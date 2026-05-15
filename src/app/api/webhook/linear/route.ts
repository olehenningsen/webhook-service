import { NextRequest, NextResponse } from "next/server";
import { verifyLinearSignature } from "@/lib/signature";
import { getEnv } from "@/lib/config";
import { prisma } from "@/lib/prisma";
import { routeStatus } from "@/lib/router";
import { isAgentRunning, enqueue } from "@/lib/queue";
import { triggerAgent } from "@/lib/agent-trigger";
import { executeGitAction } from "@/lib/git-workflow";
import { dispatchAvailableWork } from "@/lib/orchestrator";
import {
  LinearWebhookPayloadSchema,
  isStatusChange,
  generateEventId,
} from "@/types/linear-webhook";
import { WebhookEventStatus } from "@/generated/prisma/enums";

// Allow up to 60s for session creation + retries
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const env = getEnv();

  // 1. Read raw body for signature verification
  const rawBody = await request.text();
  const signature = request.headers.get("linear-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }

  // 2. Verify webhook signature
  if (!verifyLinearSignature(rawBody, signature, env.LINEAR_WEBHOOK_SECRET)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // 3. Parse and validate payload
  const parseResult = LinearWebhookPayloadSchema.safeParse(
    JSON.parse(rawBody)
  );
  if (!parseResult.success) {
    console.error(
      "[webhook] Invalid payload:",
      parseResult.error.flatten()
    );
    // Return 200 to prevent Linear from retrying
    return NextResponse.json({ received: true, skipped: "invalid_payload" });
  }

  const payload = parseResult.data;

  // 4. Filter: only process status changes
  if (!isStatusChange(payload)) {
    return NextResponse.json({ received: true, skipped: "not_status_change" });
  }

  const toStatus = payload.data.state?.name;
  if (!toStatus) {
    return NextResponse.json({ received: true, skipped: "no_state" });
  }

  // 5. Idempotency check
  const linearEventId = generateEventId(payload);
  const existing = await prisma.webhookEvent.findUnique({
    where: { linearEventId },
  });

  if (existing) {
    return NextResponse.json({
      received: true,
      eventId: existing.id,
      skipped: "duplicate",
    });
  }

  // 6. Store event
  const event = await prisma.webhookEvent.create({
    data: {
      linearEventId,
      issueId: payload.data.identifier,
      issueTitle: payload.data.title,
      fromStatus: null, // Linear doesn't send from-state name directly
      toStatus,
      status: WebhookEventStatus.RECEIVED,
    },
  });

  // 7. Route status to agent/git action
  const route = routeStatus(toStatus);

  if (route.action === "log") {
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: {
        status: WebhookEventStatus.COMPLETED,
        triggeredAgent: null,
        processedAt: new Date(),
      },
    });
    return NextResponse.json({ received: true, eventId: event.id });
  }

  // 8. Handle orchestrate action (TEA-11: developer parallelization)
  if (route.action === "orchestrate") {
    // Mark event completed (orchestrator manages its own events)
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: {
        status: WebhookEventStatus.COMPLETED,
        processedAt: new Date(),
      },
    });

    // Await orchestrator — must complete before Vercel kills the runtime
    try {
      const result = await dispatchAvailableWork();
      console.log(
        `[webhook] Orchestrator: assigned=${result.assigned}, skipped=${result.skipped}`
      );
    } catch (error) {
      console.error(
        `[webhook] Orchestrator dispatch failed for ${payload.data.identifier}:`,
        error
      );
    }

    return NextResponse.json({ received: true, eventId: event.id });
  }

  // 9. Check queue — is an agent already running on this issue?
  if (route.agent && (await isAgentRunning(payload.data.identifier))) {
    await enqueue(event.id, payload.data.identifier);
    return NextResponse.json({
      received: true,
      eventId: event.id,
      queued: true,
    });
  }

  // 10-11. Run git action and agent trigger IN PARALLEL when both are configured.
  // Sequential awaiting (git first, then agent) was eating into the Vercel 60s
  // function budget — slow git operations (PR creation with merge-from-main
  // taking 10-30s) left too little time for triggerAgent's sendEvent to
  // complete, causing the "empty Scout session" bug where the session was
  // created but the initial message never landed. Promise.allSettled lets
  // them race; total runtime is now max(git, trigger) ≈ git, not git + trigger.
  //
  // Side effects: both write to the same webhook event row (status,
  // triggeredAgent, agentSessionId). Order of writes is non-deterministic,
  // but:
  //   - triggerAgent owns agentSessionId (git-workflow no longer writes it)
  //   - last-write-wins on status is acceptable; the cron poller derives true
  //     state from the Anthropic session anyway
  const tasks: Promise<void>[] = [];

  if (route.gitAction) {
    tasks.push(
      executeGitAction({
        eventId: event.id,
        action: route.gitAction,
        issueKey: payload.data.identifier,
        issueTitle: payload.data.title,
        issueDescription: payload.data.description,
        teamKey: payload.data.team?.key,
        labels: payload.data.labels?.map((l) => l.name),
      }).catch((error) => {
        console.error(
          `[webhook] Git action '${route.gitAction}' failed for ${payload.data.identifier}:`,
          error
        );
      })
    );
  }

  if (route.agent) {
    tasks.push(
      (async () => {
        try {
          await triggerAgent({
            eventId: event.id,
            agent: route.agent!,
            issueId: payload.data.identifier,
            issueTitle: payload.data.title,
            issueDescription: payload.data.description,
            toStatus,
          });
        } catch (error) {
          console.error(
            `[webhook] Agent trigger failed for ${payload.data.identifier}:`,
            error
          );
        }
      })()
    );
  }

  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }

  // 12. For git-only actions (no agent), the event is managed by executeGitAction
  // For agent-only actions, managed by triggerAgent
  // For both (e.g., Test = create-pr + scout), both run in parallel
  if (!route.agent && !route.gitAction) {
    // No specific handler (e.g., notify) — mark as completed
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: {
        status: WebhookEventStatus.COMPLETED,
        processedAt: new Date(),
      },
    });
  }

  // 13. If issue moved to Done, re-evaluate orchestrator (blocker may have resolved)
  if (toStatus === "Done") {
    try {
      await dispatchAvailableWork();
    } catch (error) {
      console.error(
        `[webhook] Orchestrator re-evaluation failed after Done:`,
        error
      );
    }
  }

  return NextResponse.json({ received: true, eventId: event.id });
}
