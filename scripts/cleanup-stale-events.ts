/**
 * One-shot cleanup script that deletes FAILED webhook events older than
 * 30 days. The webhook_event table accumulates failed orchestrator dispatches,
 * timed-out agent triggers, and similar dead entries over time. This keeps
 * the table tidy without losing recent failures (which are still useful
 * for debugging).
 *
 * Usage:
 *   source .env && npx tsx scripts/cleanup-stale-events.ts
 *
 * Idempotent — running it twice in a row is a no-op the second time.
 */

import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { WebhookEventStatus } from "../src/generated/prisma/enums";

const RETENTION_DAYS = 30;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL must be set");
    process.exit(1);
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  console.log(
    `[cleanup] Deleting FAILED webhook events created before ${cutoff.toISOString()}`
  );

  const result = await prisma.webhookEvent.deleteMany({
    where: {
      status: WebhookEventStatus.FAILED,
      createdAt: { lt: cutoff },
    },
  });

  console.log(
    `[cleanup] Deleted ${result.count} stale FAILED events (older than ${RETENTION_DAYS} days)`
  );

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error("[cleanup] Failed:", error);
  process.exit(1);
});
