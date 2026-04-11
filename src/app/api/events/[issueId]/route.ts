import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getEnv } from "@/lib/config";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ issueId: string }> }
) {
  const apiKey = request.headers.get("x-api-key");
  const env = getEnv();

  if (apiKey !== env.API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { issueId } = await params;

  const events = await prisma.webhookEvent.findMany({
    where: { issueId },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({
    issueId,
    events: events.map((e) => ({
      id: e.id,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      triggeredAgent: e.triggeredAgent,
      agentSessionId: e.agentSessionId,
      status: e.status,
      errorMessage: e.errorMessage,
      processedAt: e.processedAt,
      createdAt: e.createdAt,
    })),
    count: events.length,
  });
}
