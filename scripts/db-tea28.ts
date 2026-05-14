import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  const events = await prisma.webhookEvent.findMany({
    where: { issueId: "TEA-28" },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  for (const e of events) {
    console.log(
      `${e.createdAt.toISOString().slice(11, 19)} | ${e.toStatus} | ${e.status} | agent=${e.triggeredAgent} | sess=${e.agentSessionId?.slice(0, 15) ?? "-"} | err=${e.errorMessage?.slice(0, 60) ?? "-"}`
    );
  }
  await prisma.$disconnect();
}

main().catch(console.error);
