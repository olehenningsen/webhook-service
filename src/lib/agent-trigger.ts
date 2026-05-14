import {
  getAgentConfig,
  getCallbackUrl,
  getGitHubConfig,
  getRepoForTeam,
} from "./config";
import {
  createSession,
  sendEvent,
  type SessionResource,
} from "./managed-agents";
import { prisma } from "./prisma";
import { WebhookEventStatus } from "@/generated/prisma/enums";

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

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Update event to PROCESSING
      await prisma.webhookEvent.update({
        where: { id: input.eventId },
        data: {
          status: WebhookEventStatus.PROCESSING,
          triggeredAgent: input.agent,
          retryCount: attempt,
        },
      });

      // Create a managed agent session with vault credentials (MCP OAuth)
      // and a github_repository resource (auth baked into git remote — agent
      // can `git push` without ever handling the token).
      console.log(`[agent-trigger] Creating session for ${input.issueId} (agent: ${agentId}, env: ${environmentId}, vaults: ${vaultIds.join(",")}, resources: ${resources.length})`);
      const session = await createSession(
        agentId,
        environmentId,
        `${input.issueId}: ${input.issueTitle}`,
        vaultIds,
        resources
      );
      console.log(`[agent-trigger] Session created: ${session.id}`);

      // Send the initial user message BEFORE storing agentSessionId.
      // Previously we stored the ID first as a "safety net" — but the
      // consequence was that when sendEvent silently failed (Vercel runtime
      // cut-off, hanging fetch, etc.) we ended up with orphan empty sessions
      // visible to the cron poller as "real" running sessions. Now: if
      // sendEvent fails, we throw before storing, the retry loop tries again,
      // and the orphan session in Anthropic just sits idle until its env TTL
      // garbage-collects it.
      console.log(`[agent-trigger] Sending initial message to ${session.id}`);
      await sendEvent(session.id, userMessage);
      console.log(`[agent-trigger] Message sent to ${session.id}`);

      // Now safe to persist the session ID — sendEvent's HTTP response is
      // authoritative. (We previously had a verification step that polled
      // GET events here, but it ran into eventual-consistency: messages
      // freshly POSTed aren't always immediately visible via GET, causing
      // false-negative throws on a working session.)
      await prisma.webhookEvent.update({
        where: { id: input.eventId },
        data: {
          agentSessionId: session.id,
        },
      });

      return session.id;
    } catch (error) {
      const isLastAttempt = attempt === MAX_RETRIES;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      console.error(
        `[agent-trigger] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed for ${input.issueId}: ${errorMessage}`
      );

      if (isLastAttempt) {
        await prisma.webhookEvent.update({
          where: { id: input.eventId },
          data: {
            status: WebhookEventStatus.FAILED,
            errorMessage: `All retries exhausted: ${errorMessage}`,
            retryCount: attempt,
            processedAt: new Date(),
          },
        });
        return null;
      }

      // Exponential backoff
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return null;
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
