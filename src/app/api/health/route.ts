import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

interface HealthResponse {
  status: "ok" | "error";
  timestamp: string;
  service: string;
  agentSessionsActive: number | null;
  lastWebhookSeenAt: string | null;
  error?: string;
}

export async function GET() {
  try {
    // Primary health indicator: DB connectivity
    await prisma.$queryRaw`SELECT 1`;

    // Secondary queries: run in parallel, failures must not affect status
    const [countResult, maxResult] = await Promise.allSettled([
      prisma.webhookEvent.count({ where: { status: "PROCESSING" } }),
      prisma.webhookEvent.findFirst({
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
    ]);

    const agentSessionsActive =
      countResult.status === "fulfilled" ? countResult.value : null;

    const lastWebhookSeenAt =
      maxResult.status === "fulfilled" && maxResult.value !== null
        ? maxResult.value.createdAt.toISOString()
        : null;

    const response: HealthResponse = {
      status: "ok",
      timestamp: new Date().toISOString(),
      service: "webhook-orchestration",
      agentSessionsActive,
      lastWebhookSeenAt,
    };

    return NextResponse.json(response);
  } catch {
    const response: HealthResponse = {
      status: "error",
      timestamp: new Date().toISOString(),
      service: "webhook-orchestration",
      agentSessionsActive: null,
      lastWebhookSeenAt: null,
      error: "Database connection failed",
    };

    return NextResponse.json(response, { status: 503 });
  }
}
