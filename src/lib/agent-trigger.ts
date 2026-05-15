import {
  getAgentConfig,
  getCallbackUrl,
  getGitHubConfig,
  getRepoForTeam,
  DEVELOPER_POOL,
} from "./config";
import {
  createSession,
  listAgentSessions,
  sendEvent,
  type SessionResource,
} from "./managed-agents";
import { addLabelByIssueKey } from "./linear-client";
import { prisma } from "./prisma";
import { WebhookEventStatus } from "@/generated/prisma/enums";

// Colors for the non-developer agents' dev:* labels. Developer-pool agents
// have their own colors set by the orchestrator.
const NON_DEV_LABEL_COLORS: Record<string, string> = {
  saga: "#9B59B6",   // purple — PM
  atlas: "#3498DB",  // blue — tech lead
  scout: "#E74C3C",  // red — tester
};

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

interface TriggerInput {
  eventId: string;
  agent: string;
  issueId: string;
  issueTitle: string;
  issueDescription?: string;
  fromStatus?: string;
  toStatus: string;
}

/**
 * Trigger a managed agent session via Claude Managed Agents API.
 * Creates a session and sends the initial user message with issue context.
 * Returns immediately (fire-and-forget) — completion is detected by the cron poller.
 */
export async function triggerAgent(input: TriggerInput): Promise<string | null> {
  const { agentId, environmentId, vaultIds } = getAgentConfig(input.agent);
  const resources = buildResources();
  const repoMount = resources[0]?.mount_path;
  const repoUrl = resources[0]?.url;
  const fallbackToken = resources[0]?.authorization_token;
  const userMessage = buildUserMessage(input, repoMount, repoUrl, fallbackToken);

  // For Saga/Atlas/Scout, add a dev:<agent> label up-front so the dashboard
  // sees them as active. Developer-pool agents get this from the
  // orchestrator. Best-effort — failures are non-fatal.
  const isDeveloper = (DEVELOPER_POOL as readonly string[]).includes(input.agent);
  if (!isDeveloper) {
    try {
      await addLabelByIssueKey(
        input.issueId,
        `dev:${input.agent}`,
        NON_DEV_LABEL_COLORS[input.agent]
      );
    } catch (labelError) {
      console.warn(
        `[agent-trigger] Failed to add dev:${input.agent} label to ${input.issueId}:`,
        labelError
      );
    }
  }

  // Phase 1: create the session, with retries. Each attempt creates a
  // *new* Anthropic session, so we keep this loop narrow. Status reset
  // to PROCESSING and errorMessage cleared on every attempt so prior
  // cron orphan-FAILED messages don't stick around if we recover here.
  //
  // Orphan-recovery: when createSession aborts (Anthropic provisioning
  // exceeds our timeout), Anthropic still creates the session server-side
  // a moment later — our fetch just never reads the response. Without
  // recovery, each retry creates yet another orphan. After an abort, we
  // check the agent's recent sessions for one matching our title and
  // reclaim it instead of looping into more orphans.
  const sessionTitle = `${input.issueId}: ${input.issueTitle}`;
  let session: { id: string } | null = null;
  let createError: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await prisma.webhookEvent.update({
        where: { id: input.eventId },
        data: {
          status: WebhookEventStatus.PROCESSING,
          triggeredAgent: input.agent,
          retryCount: attempt,
          errorMessage: null,
        },
      });

      console.log(`[agent-trigger] Creating session for ${input.issueId} (attempt ${attempt + 1}/${MAX_RETRIES + 1}, agent: ${agentId}, env: ${environmentId}, vaults: ${vaultIds.join(",")}, resources: ${resources.length})`);
      session = await createSession(
        agentId,
        environmentId,
        sessionTitle,
        vaultIds,
        resources
      );
      console.log(`[agent-trigger] Session created: ${session.id}`);

      // Persist agentSessionId immediately so the cron empty-session
      // recovery can find this session if anything fails from here on.
      await prisma.webhookEvent.update({
        where: { id: input.eventId },
        data: { agentSessionId: session.id },
      });
      break;
    } catch (error) {
      createError = error;
      const errMsg = error instanceof Error ? error.message : String(error);
      const isAbort =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      console.error(
        `[agent-trigger] createSession attempt ${attempt + 1}/${MAX_RETRIES + 1} failed for ${input.issueId}: ${errMsg}${isAbort ? " (abort — probing for orphan)" : ""}`
      );

      // After an abort, Anthropic may have created the session anyway.
      // Look it up by title before retrying — saves multiplying orphans.
      if (isAbort) {
        try {
          const recent = await listAgentSessions(agentId, 10);
          const orphan = recent.find(
            (s) =>
              s.title === sessionTitle &&
              // Restrict to sessions created in the last 5 minutes so we
              // don't grab a stale match from an earlier failed run.
              Date.now() - new Date(s.created_at).getTime() < 5 * 60 * 1000
          );
          if (orphan) {
            console.log(
              `[agent-trigger] Reclaimed orphan session ${orphan.id} for ${input.issueId} (created ${orphan.created_at})`
            );
            session = { id: orphan.id };
            // Reset status to PROCESSING and clear errorMessage in case the
            // cron orphan-FAILED branch already ran on this row while we
            // were waiting for Anthropic. The session is actually fine —
            // the row should reflect that.
            await prisma.webhookEvent.update({
              where: { id: input.eventId },
              data: {
                status: WebhookEventStatus.PROCESSING,
                agentSessionId: orphan.id,
                errorMessage: null,
                processedAt: null,
              },
            });
            break;
          }
        } catch (lookupError) {
          console.warn(
            `[agent-trigger] Orphan-recovery lookup failed for ${input.issueId}:`,
            lookupError
          );
        }
      }

      if (attempt === MAX_RETRIES) break;
      await new Promise((resolve) => setTimeout(resolve, BASE_DELAY_MS * Math.pow(2, attempt)));
    }
  }

  if (!session) {
    const errMsg = createError instanceof Error ? createError.message : String(createError);
    await prisma.webhookEvent.update({
      where: { id: input.eventId },
      data: {
        status: WebhookEventStatus.FAILED,
        errorMessage: `createSession exhausted: ${errMsg}`,
        processedAt: new Date(),
      },
    });
    return null;
  }

  // Phase 2: deliver the initial message on the EXISTING session. Retrying
  // sendEvent here instead of in the outer loop avoids creating a new
  // Anthropic session per attempt (previously this leaked up to MAX_RETRIES+1
  // orphan sessions per sendEvent-timeout cycle).
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[agent-trigger] Sending initial message to ${session.id} (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
      await sendEvent(session.id, userMessage);
      console.log(`[agent-trigger] Message sent to ${session.id}`);
      return session.id;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(
        `[agent-trigger] sendEvent attempt ${attempt + 1}/${MAX_RETRIES + 1} failed for ${input.issueId} on session ${session.id}: ${errMsg}`
      );
      if (attempt === MAX_RETRIES) {
        // sendEvent never delivered, but the session is alive and known to
        // the DB. Leave status PROCESSING so cron empty-session recovery
        // can wake it up with a fresh message. Record what happened.
        await prisma.webhookEvent.update({
          where: { id: input.eventId },
          data: {
            errorMessage: `sendEvent exhausted (cron will recover): ${errMsg}`,
          },
        });
        return session.id;
      }
      await new Promise((resolve) => setTimeout(resolve, BASE_DELAY_MS * Math.pow(2, attempt)));
    }
  }

  return session.id;
}

/**
 * Build session resources. Currently mounts the default GitHub repo so the
 * agent can run `git push` directly — the auth token is baked into the local
 * git remote by the managed agents platform.
 *
 * Returns [] if GitHub config is incomplete (allows non-code agents to run).
 */
function buildResources(): SessionResource[] {
  try {
    const { token, owner, defaultRepo } = getGitHubConfig();
    const repo = getRepoForTeam();
    return [
      {
        type: "github_repository",
        url: `https://github.com/${owner}/${repo}`,
        mount_path: `/workspace/${repo}`,
        authorization_token: token,
      },
    ];
  } catch {
    return [];
  }
}

function buildUserMessage(
  input: TriggerInput,
  repoMount?: string,
  repoUrl?: string,
  fallbackToken?: string
): string {
  const repoSection = repoMount
    ? [
        `## Repository`,
        ``,
        `Repoet er allerede klonet og klar i \`${repoMount}\`. Standard \`origin\` remote har autentificering indbygget — du kan **direkte** køre \`git checkout -b ...\`, \`git commit\`, og \`git push\` fra den mappe.`,
        ``,
        `**Webhook-service håndterer PR-oprettelse og merge automatisk** når du flytter issuet til Test (og senere Done). Du skal IKKE oprette PR selv — brug ikke GitHub MCP (den er heller ikke tilgængelig).`,
        ``,
        ...(fallbackToken && repoUrl
          ? [
              `### Fallback hvis \`git push origin\` fejler`,
              ``,
              `Den lokale auth-proxy kan time ud efter inaktivitet. Hvis push fejler med \`Failed to connect to 127.0.0.1\` eller lignende, brug PAT'en direkte:`,
              ``,
              "```bash",
              `git remote set-url origin ${repoUrl.replace("https://", `https://x-access-token:${fallbackToken}@`)}.git`,
              `git push -u origin <din-branch>`,
              "```",
              ``,
              `Denne PAT har \`repo\` scope. Brug ALDRIG denne i kommentarer, commits eller kode — kun til at sætte git remote.`,
              ``,
            ]
          : []),
      ]
    : [];

  return [
    `## Issue: ${input.issueId} — ${input.issueTitle}`,
    ``,
    `**Status ændret:** ${input.fromStatus ?? "(ny)"} → ${input.toStatus}`,
    ``,
    input.issueDescription
      ? `## Beskrivelse\n\n${input.issueDescription}`
      : "",
    ``,
    ...repoSection,
    `Når du er færdig, vil systemet automatisk detektere at din session er idle.`,
    `Callback URL (fallback): ${getCallbackUrl()}`,
  ]
    .filter(Boolean)
    .join("\n");
}
