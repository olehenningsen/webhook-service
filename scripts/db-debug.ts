import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  const recent = await prisma.webhookEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: 15,
  });
  console.log("=== Last 15 events ===");
  for (const e of recent) {
    console.log(
      `${e.createdAt.toISOString().slice(11, 19)} | ${e.issueId} → ${e.toStatus} | ${e.status} | agent=${e.triggeredAgent} | session=${e.agentSessionId?.slice(0, 15) ?? "-"} | err=${e.errorMessage?.slice(0, 60) ?? "-"}`
    );
  }
  console.log("\n=== PROCESSING events ===");
  const processing = await prisma.webhookEvent.findMany({
    where: { status: "PROCESSING" },
  });
  for (const e of processing) {
    console.log(
      `${e.createdAt.toISOString()} | ${e.issueId} | agent=${e.triggeredAgent} | session=${e.agentSessionId ?? "NULL"}`
    );
  }
  console.log(`\nTotal PROCESSING: ${processing.length}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
