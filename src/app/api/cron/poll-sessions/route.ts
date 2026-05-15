import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { WebhookEventStatus } from "@/generated/prisma/enums";
import { getSessionStatus, listSessionEvents, sendEvent } from "@/lib/managed-agents";
import { dequeue } from "@/lib/queue";
import { triggerAgent } from "@/lib/agent-trigger";
import { executeGitAction } from "@/lib/git-workflow";
import { routeStatus } from "@/lib/router";
import { dispatchAvailableWork } from "@/lib/orchestrator";
import { DEVELOPER_POOL } from "@/lib/config";

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
      // If no session ID was ever saved, the trigger failed silently.
      // Mark as FAILED after a grace period (2 minutes) to allow in-flight triggers to complete.
      if (!event.agentSessionId) {
        const elapsed = Date.now() - event.createdAt.getTime();
        if (elapsed > 2 * 60 * 1000) {
          await prisma.webhookEvent.update({
            where: { id: event.id },
            data: {
              status: WebhookEventStatus.FAILED,
              errorMessage: "Agent session was never created (no session ID after 2 min)",
              processedAt: new Date(),
            },
          });

          results.push({
            eventId: event.id,
            issueId: event.issueId,
            sessionStatus: "orphaned",
            action: "FAILED",
          });

          await dequeueNext(event.issueId);

          if (DEVELOPER_POOL.includes(event.triggeredAgent as typeof DEVELOPER_POOL[number])) {
            dispatchAvailableWork().catch((error) => {
              console.error(`[poll-sessions] Orchestrator dispatch failed:`, error);
            });
          }
        }
        continue;
      }

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

        // If a developer agent timed out, free the slot and re-evaluate
        if (DEVELOPER_POOL.includes(event.triggeredAgent as typeof DEVELOPER_POOL[number])) {
          dispatchAvailableWork().catch((error) => {
            console.error(`[poll-sessions] Orchestrator dispatch failed:`, error);
          });
        }
        continue;
      }

      // Query session status from managed agents API
      const session = await getSessionStatus(event.agentSessionId!);

      // RECOVERY: detect "empty session" — agent-trigger stored a session ID
      // but the initial sendEvent didn't actually deliver, so the session
      // sits in Anthropic with 0 events and never starts work. Resend a
      // minimal wake-up message that tells the agent to fetch the issue
      // and proceed per its SKILL.md.
      if (session.status === "running") {
        try {
          const events = await listSessionEvents(event.agentSessionId!, 3);
          const sessionElapsed = Date.now() - event.createdAt.getTime();
          if (events.length === 0 && sessionElapsed > 60_000) {
            const wakeup =
              `## Issue: ${event.issueId} — ${event.issueTitle}\n\n` +
              `**Status:** ${event.fromStatus ?? "(ny)"} → ${event.toStatus}\n\n` +
              `Hent issue-detaljerne via Linear MCP (\`get_issue("${event.issueId}")\`) ` +
              `og udfør din rolle som beskrevet i din SKILL.md. ` +
              `(Genaktivering: din session blev oprettet uden initial besked.)`;
            await sendEvent(event.agentSessionId!, wakeup);
            console.log(
              `[poll-sessions] Recovered empty session ${event.agentSessionId} for ${event.issueId}`
            );
            results.push({
              eventId: event.id,
              issueId: event.issueId,
              sessionStatus: "recovered",
              action: "WAKE_UP",
            });
            continue;
          }
        } catch (recoveryError) {
          console.warn(
            `[poll-sessions] Empty-session recovery check failed for ${event.issueId}:`,
            recoveryError
          );
        }
      }

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

        // If a developer agent completed, re-evaluate orchestrator
        if (DEVELOPER_POOL.includes(event.triggeredAgent as typeof DEVELOPER_POOL[number])) {
          dispatchAvailableWork().catch((error) => {
            console.error(`[poll-sessions] Orchestrator dispatch failed:`, error);
          });
        }
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

        // If a developer agent failed, free the slot and re-evaluate
        if (DEVELOPER_POOL.includes(event.triggeredAgent as typeof DEVELOPER_POOL[number])) {
          dispatchAvailableWork().catch((error) => {
            console.error(`[poll-sessions] Orchestrator dispatch failed:`, error);
          });
        }
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
