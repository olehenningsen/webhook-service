import { prisma } from "./prisma";
import { WebhookEventStatus } from "@/generated/prisma/enums";

const LOCK_ID = "orchestrator-lock";
const LOCK_TTL_MS = 30_000; // 30 seconds

/**
 * Acquire a concurrency lock for the orchestrator.
 * Uses a well-known WebhookEvent row as a mutex.
 * Returns true if lock acquired, false if already locked.
 *
 * The claim is atomic in two ways:
 *
 * 1. `updateMany` with a WHERE clause that requires the lock to be
 *    available (status != PROCESSING OR createdAt past the TTL).
 *    Postgres serialises row-level updates, so only one concurrent
 *    caller's update returns count > 0.
 *
 * 2. If the row doesn't exist yet (first-ever run), fall through to
 *    create. The unique constraint on `linearEventId` ensures only
 *    one create succeeds; competing workers see the conflict and
 *    return false.
 *
 * Without the atomic updateMany, two concurrent callers could both
 * findUnique a stale-or-released lock, both call update (idempotent),
 * and both believe they own the lock — leading to parallel
 * dispatchAvailableWork runs that race on getAvailableDevelopers /
 * getTodoIssuesReady and double-dispatch the same issue.
 */
export async function acquireOrchestratorLock(): Promise<boolean> {
  const now = new Date();
  const expiredCutoff = new Date(now.getTime() - LOCK_TTL_MS);

  // Atomic reclaim path: only one worker's updateMany returns count > 0.
  const claim = await prisma.webhookEvent.updateMany({
    where: {
      linearEventId: LOCK_ID,
      OR: [
        { status: { not: WebhookEventStatus.PROCESSING } },
        { createdAt: { lte: expiredCutoff } },
      ],
    },
    data: {
      status: WebhookEventStatus.PROCESSING,
      createdAt: now,
      processedAt: null,
    },
  });

  if (claim.count > 0) {
    return true;
  }

  // updateMany matched nothing. Either the row doesn't exist (first run)
  // or the lock is currently held by another worker. Try create — the
  // unique constraint disambiguates atomically.
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
    // Unique constraint violation — row exists and is held by another
    // worker. Return false; they win this round.
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
