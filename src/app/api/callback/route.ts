import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { WebhookEventStatus } from "@/generated/prisma/enums";
import { dequeue } from "@/lib/queue";
import { triggerAgent } from "@/lib/agent-trigger";
import { executeGitAction } from "@/lib/git-workflow";
import { routeStatus } from "@/lib/router";

const CallbackSchema = z.object({
  eventId: z.string(),
  sessionId: z.string().optional(),
  success: z.boolean(),
  errorMessage: z.string().optional(),
});

/**
 * Agent-completion callback.
 * Called when a managed agent finishes processing an issue.
 * Dequeues the next event for the same issue if any.
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const parseResult = CallbackSchema.safeParse(body);

  if (!parseResult.success) {
    return NextResponse.json(
      { error: "Bad request", details: parseResult.error.flatten() },
      { status: 400 }
    );
  }

  const { eventId, success, errorMessage } = parseResult.data;

  // Update the event
  const event = await prisma.webhookEvent.findUnique({
    where: { id: eventId },
  });

  if (!event) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }

  await prisma.webhookEvent.update({
    where: { id: eventId },
    data: {
      status: success
        ? WebhookEventStatus.COMPLETED
        : WebhookEventStatus.FAILED,
      errorMessage: errorMessage ?? null,
      processedAt: new Date(),
    },
  });

  console.log(
    `[callback] Event ${eventId} for ${event.issueId}: ${success ? "COMPLETED" : "FAILED"}`
  );

  // Dequeue next event for this issue
  const next = await dequeue(event.issueId);
  if (next) {
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
          `[callback] Git action '${route.gitAction}' failed for ${next.issueId}:`,
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
          `[callback] Failed to trigger next queued agent for ${next.issueId}:`,
          error
        );
      });
    }
  }

  return NextResponse.json({ received: true });
}
