import { prisma } from "./prisma";
import { WebhookEventStatus } from "@/generated/prisma/enums";

const LOCK_ID = "orchestrator-lock";
const LOCK_TTL_MS = 30_000; // 30 seconds

/**
 * Acquire a concurrency lock for the orchestrator.
 * Uses a well-known WebhookEvent row as a mutex.
 * Returns true if lock acquired, false if already locked.
 */
export async function acquireOrchestratorLock(): Promise<boolean> {
  const now = new Date();

  // Check for existing lock
  const existing = await prisma.webhookEvent.findUnique({
    where: { linearEventId: LOCK_ID },
  });

  if (existing) {
    const elapsed = now.getTime() - existing.createdAt.getTime();
    if (existing.status === WebhookEventStatus.PROCESSING && elapsed < LOCK_TTL_MS) {
      // Lock is held and not expired
      return false;
    }

    // Lock expired or not PROCESSING — reclaim it
    await prisma.webhookEvent.update({
      where: { linearEventId: LOCK_ID },
      data: {
        status: WebhookEventStatus.PROCESSING,
        createdAt: now,
        processedAt: null,
      },
    });
    return true;
  }

  // Create new lock row
  try {
    await prisma.webhookEvent.create({
      data: {
        linearEventId: LOCK_ID,
        issueId: "system",
        issueTitle: "Orchestrator Lock",
        toStatus: "lock",
        status: WebhookEventStatus.PROCESSING,
      },
    });
    return true;
  } catch {
    // Unique constraint violation — another process created it first
    return false;
  }
}

/**
 * Release the orchestrator lock.
 */
export async function releaseOrchestratorLock(): Promise<void> {
  await prisma.webhookEvent.update({
    where: { linearEventId: LOCK_ID },
    data: {
      status: WebhookEventStatus.COMPLETED,
      processedAt: new Date(),
    },
  });
}
