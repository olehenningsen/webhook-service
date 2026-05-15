import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getEnv } from "@/lib/config";

/**
 * Debug endpoint: list webhook events.
 *
 * NOTE: Vercel Deployment Protection sits in front of all routes by default
 * and will intercept this endpoint with an SSO login page even though we
 * validate `x-api-key` internally. To access this endpoint from an external
 * script or curl, EITHER:
 *
 *   1. Enable "Protection Bypass for Automation" in the Vercel project
 *      settings, then pass the generated token alongside x-api-key:
 *        curl -H "x-api-key: $API_KEY" \
 *             -H "x-vercel-protection-bypass: $BYPASS_SECRET" \
 *             "https://<prod-url>/api/events"
 *
 *   2. Or disable Deployment Protection on this specific route via Vercel
 *      "Skip Deployment Protection" path patterns. The internal x-api-key
 *      check remains the primary auth.
 *
 * See: https://vercel.com/docs/deployment-protection
 */
export async function GET(request: NextRequest) {
  // Auth check
  const apiKey = request.headers.get("x-api-key");
  const env = getEnv();

  if (apiKey !== env.API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Query params
  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "50"), 100);
  const cursor = searchParams.get("cursor");
  const issueId = searchParams.get("issueId");

  // Build query
  const where = {
    ...(issueId ? { issueId } : {}),
    ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
  };

  const [events, totalCount] = await Promise.all([
    prisma.webhookEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit + 1, // Fetch one extra to check if there's a next page
    }),
    prisma.webhookEvent.count({ where: issueId ? { issueId } : {} }),
  ]);

  const hasMore = events.length > limit;
  const results = hasMore ? events.slice(0, limit) : events;
  const nextCursor = hasMore
    ? results[results.length - 1].createdAt.toISOString()
    : null;

  return NextResponse.json({
    events: results.map((e) => ({
      id: e.id,
      issueId: e.issueId,
      issueTitle: e.issueTitle,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      triggeredAgent: e.triggeredAgent,
      agentSessionId: e.agentSessionId,
      status: e.status,
      errorMessage: e.errorMessage,
      retryCount: e.retryCount,
      queuePosition: e.queuePosition,
      processedAt: e.processedAt,
      createdAt: e.createdAt,
    })),
    nextCursor,
    totalCount,
  });
}
