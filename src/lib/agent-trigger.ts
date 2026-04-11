import Anthropic from "@anthropic-ai/sdk";
import { getEnv, getCallbackUrl } from "./config";
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
 * Trigger a managed agent via Claude API with retry logic.
 * Uses exponential backoff on transient failures.
 */
export async function triggerAgent(input: TriggerInput): Promise<string | null> {
  const env = getEnv();
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const systemPrompt = buildSystemPrompt(input.agent);
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

      // TODO: Replace with actual managed agent API call when available.
      // For now, use messages API as placeholder.
      const response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      });

      // Extract session ID (use message ID as placeholder)
      const sessionId = response.id;

      await prisma.webhookEvent.update({
        where: { id: input.eventId },
        data: {
          agentSessionId: sessionId,
        },
      });

      console.log(
        `[agent-trigger] Agent '${input.agent}' triggered for ${input.issueId} (session: ${sessionId})`
      );

      return sessionId;
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

function buildSystemPrompt(agent: string): string {
  // In production, this would load the agent's SKILL.md from the repo
  const agentNames: Record<string, string> = {
    saga: "Saga (Product Manager)",
    atlas: "Atlas (Tech Lead)",
    pixel: "Pixel (Frontend Developer)",
    sprite: "Sprite (Frontend Developer)",
    byte: "Byte (Backend Developer)",
    loop: "Loop (Backend Developer)",
    scout: "Scout (Tester)",
  };

  return `Du er ${agentNames[agent] ?? agent} i TeamAgentic. Et issue har skiftet status og kræver din opmærksomhed.`;
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
    `Callback URL: ${getCallbackUrl()}`,
  ]
    .filter(Boolean)
    .join("\n");
}
