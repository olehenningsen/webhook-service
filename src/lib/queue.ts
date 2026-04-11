import { prisma } from "./prisma";
import { WebhookEventStatus } from "@/generated/prisma/enums";

const AGENT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes (managed agents run longer)

/**
 * Check if an agent is currently running on this issue.
 * Also handles timeout — if a PROCESSING event is older than 5 min, mark it FAILED.
 */
export async function isAgentRunning(issueId: string): Promise<boolean> {
  const running = await prisma.webhookEvent.findFirst({
    where: {
      issueId,
      status: WebhookEventStatus.PROCESSING,
    },
    orderBy: { createdAt: "desc" },
  });

  if (!running) return false;

  // Check timeout
  const elapsed = Date.now() - running.createdAt.getTime();
  if (elapsed > AGENT_TIMEOUT_MS) {
    await prisma.webhookEvent.update({
      where: { id: running.id },
      data: {
        status: WebhookEventStatus.FAILED,
        errorMessage: `Agent timed out after ${AGENT_TIMEOUT_MS / 1000}s`,
        processedAt: new Date(),
      },
    });
    return false;
  }

  return true;
}

/**
 * Enqueue an event — set status to QUEUED with a position.
 */
export async function enqueue(eventId: string, issueId: string): Promise<void> {
  const lastQueued = await prisma.webhookEvent.findFirst({
    where: {
      issueId,
      status: WebhookEventStatus.QUEUED,
    },
    orderBy: { queuePosition: "desc" },
  });

  const nextPosition = (lastQueued?.queuePosition ?? 0) + 1;

  // Max queue size of 10 per issue to prevent runaway queues
  if (nextPosition > 10) {
    await prisma.webhookEvent.update({
      where: { id: eventId },
      data: {
        status: WebhookEventStatus.SKIPPED,
        errorMessage: "Queue limit exceeded (max 10 per issue)",
      },
    });
    return;
  }

  await prisma.webhookEvent.update({
    where: { id: eventId },
    data: {
      status: WebhookEventStatus.QUEUED,
      queuePosition: nextPosition,
    },
  });
}

/**
 * Dequeue the next event for an issue — returns the event to process, or null.
 */
export async function dequeue(
  issueId: string
): Promise<{ id: string; toStatus: string; issueId: string; issueTitle: string } | null> {
  const next = await prisma.webhookEvent.findFirst({
    where: {
      issueId,
      status: WebhookEventStatus.QUEUED,
    },
    orderBy: { queuePosition: "asc" },
  });

  if (!next) return null;

  await prisma.webhookEvent.update({
    where: { id: next.id },
    data: {
      status: WebhookEventStatus.RECEIVED,
      queuePosition: null,
    },
  });

  return {
    id: next.id,
    toStatus: next.toStatus,
    issueId: next.issueId,
    issueTitle: next.issueTitle,
  };
}
