import { getAgentConfig, getCallbackUrl } from "./config";
import { createSession, sendEvent } from "./managed-agents";
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
  const { agentId, environmentId } = getAgentConfig(input.agent);
  const userMessage = buildUserMessage(input);

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

      // Create a managed agent session
      const session = await createSession(
        agentId,
        environmentId,
        `${input.issueId}: ${input.issueTitle}`
      );

      // Send the initial user message with issue context
      await sendEvent(session.id, userMessage);

      // Store the session ID for tracking by the cron poller
      await prisma.webhookEvent.update({
        where: { id: input.eventId },
        data: {
          agentSessionId: session.id,
        },
      });

      console.log(
        `[agent-trigger] Agent '${input.agent}' session created for ${input.issueId} (session: ${session.id})`
      );

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

function buildUserMessage(input: TriggerInput): string {
  return [
    `## Issue: ${input.issueId} — ${input.issueTitle}`,
    ``,
    `**Status ændret:** ${input.fromStatus ?? "(ny)"} → ${input.toStatus}`,
    ``,
    input.issueDescription
      ? `## Beskrivelse\n\n${input.issueDescription}`
      : "",
    ``,
    `Når du er færdig, vil systemet automatisk detektere at din session er idle.`,
    `Callback URL (fallback): ${getCallbackUrl()}`,
  ]
    .filter(Boolean)
    .join("\n");
}
