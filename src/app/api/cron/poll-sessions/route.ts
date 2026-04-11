import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { WebhookEventStatus } from "@/generated/prisma/enums";
import { getSessionStatus } from "@/lib/managed-agents";
import { dequeue } from "@/lib/queue";
import { triggerAgent } from "@/lib/agent-trigger";
import { executeGitAction } from "@/lib/git-workflow";
import { routeStatus } from "@/lib/router";

const AGENT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Cron endpoint that polls managed agent session statuses.
 * Runs every minute via Vercel Cron.
 *
 * Checks all PROCESSING events, queries their session status,
 * and marks them COMPLETED/FAILED as appropriate.
 */
export async function GET(request: NextRequest) {
  // Verify cron secret (Vercel sends this automatically)
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const processingEvents = await prisma.webhookEvent.findMany({
    where: {
      status: WebhookEventStatus.PROCESSING,
      agentSessionId: { not: null },
    },
  });

  if (processingEvents.length === 0) {
    return NextResponse.json({ polled: 0, results: [] });
  }

  const results: Array<{
    eventId: string;
    issueId: string;
    sessionStatus: string;
    action: string;
  }> = [];

  for (const event of processingEvents) {
    try {
      // Check for timeout first
      const elapsed = Date.now() - event.createdAt.getTime();
      if (elapsed > AGENT_TIMEOUT_MS) {
        await prisma.webhookEvent.update({
          where: { id: event.id },
          data: {
            status: WebhookEventStatus.FAILED,
            errorMessage: `Agent session timed out after ${Math.round(elapsed / 1000)}s`,
            processedAt: new Date(),
          },
        });

        results.push({
          eventId: event.id,
          issueId: event.issueId,
          sessionStatus: "timeout",
          action: "FAILED",
        });

        // Dequeue next event for this issue
        await dequeueNext(event.issueId);
        continue;
      }

      // Query session status from managed agents API
      const session = await getSessionStatus(event.agentSessionId!);

      if (session.status === "idle") {
        // Agent finished — mark completed
        await prisma.webhookEvent.update({
          where: { id: event.id },
          data: {
            status: WebhookEventStatus.COMPLETED,
            processedAt: new Date(),
          },
        });

        results.push({
          eventId: event.id,
          issueId: event.issueId,
          sessionStatus: session.status,
          action: "COMPLETED",
        });

        // Dequeue next event for this issue
        await dequeueNext(event.issueId);
      } else if (session.status === "terminated") {
        // Agent failed permanently
        await prisma.webhookEvent.update({
          where: { id: event.id },
          data: {
            status: WebhookEventStatus.FAILED,
            errorMessage: "Agent session terminated",
            processedAt: new Date(),
          },
        });

        results.push({
          eventId: event.id,
          issueId: event.issueId,
          sessionStatus: session.status,
          action: "FAILED",
        });

        // Dequeue next event for this issue
        await dequeueNext(event.issueId);
      } else {
        // Still running or rescheduling — check again next cycle
        results.push({
          eventId: event.id,
          issueId: event.issueId,
          sessionStatus: session.status,
          action: "SKIPPED",
        });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(
        `[poll-sessions] Error checking session for event ${event.id}: ${errorMessage}`
      );

      results.push({
        eventId: event.id,
        issueId: event.issueId,
        sessionStatus: "error",
        action: `ERROR: ${errorMessage}`,
      });
    }
  }

  console.log(
    `[poll-sessions] Polled ${processingEvents.length} sessions: ${JSON.stringify(results)}`
  );

  return NextResponse.json({
    polled: processingEvents.length,
    results,
  });
}

/**
 * Dequeue and trigger the next event for an issue.
 * Handles both git actions and agent triggers.
 */
async function dequeueNext(issueId: string): Promise<void> {
  const next = await dequeue(issueId);
  if (!next) return;

  const route = routeStatus(next.toStatus);

  // Execute git action if configured
  if (route.gitAction) {
    try {
      await executeGitAction({
        eventId: next.id,
        action: route.gitAction,
        issueKey: next.issueId,
        issueTitle: next.issueTitle,
      });
    } catch (error) {
      console.error(
        `[poll-sessions] Git action '${route.gitAction}' failed for ${next.issueId}:`,
        error
      );
    }
  }

  // Trigger agent if configured
  if (route.agent) {
    triggerAgent({
      eventId: next.id,
      agent: route.agent,
      issueId: next.issueId,
      issueTitle: next.issueTitle,
      toStatus: next.toStatus,
    }).catch((error) => {
      console.error(
        `[poll-sessions] Failed to trigger next queued agent for ${next.issueId}:`,
        error
      );
    });
  }
}
