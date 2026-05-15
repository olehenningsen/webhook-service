import {
  getAgentConfig,
  getCallbackUrl,
  getGitHubConfig,
  getRepoForTeam,
  DEVELOPER_POOL,
} from "./config";
import {
  createSession,
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
        `${input.issueId}: ${input.issueTitle}`,
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
      console.error(
        `[agent-trigger] createSession attempt ${attempt + 1}/${MAX_RETRIES + 1} failed for ${input.issueId}: ${errMsg}`
      );
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
