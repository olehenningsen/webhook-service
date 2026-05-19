import { NextRequest, NextResponse } from "next/server";
import { verifyLinearSignature } from "@/lib/signature";
import { getEnv } from "@/lib/config";
import { prisma } from "@/lib/prisma";
import { routeStatus } from "@/lib/router";
import { isAgentRunning, enqueue } from "@/lib/queue";
import { triggerAgent } from "@/lib/agent-trigger";
import { executeGitAction } from "@/lib/git-workflow";
import { dispatchAvailableWork } from "@/lib/orchestrator";
import { progressParentIfChildrenComplete } from "@/lib/linear-client";
import { DEVELOPER_POOL } from "@/lib/config";
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

  // Invariant: every row MUST be transitioned out of RECEIVED before this
  // handler returns. Each routing branch below owns its row update — either
  // directly here (log/orchestrate/notify) or by delegating to a sub-handler
  // (triggerAgent, executeGitAction, enqueue) that updates the row in turn.
  //
  // History: prior to 2026-05-19, an unexpected throw at certain early
  // points (rate limit during label-add, missing env var in getAgentConfig,
  // DB hiccup on first PROCESSING write) would leave the row stuck in
  // RECEIVED forever. Outer try/catch wrappers only logged to console
  // without updating the row. Observed on TEA-110, TEA-140, TEA-158.
  //
  // Fix: wrap the entire routing block in a try/finally that guarantees the
  // row is no longer RECEIVED on exit. A best-effort FAILED-mark catches
  // anything that fell through.
  try {

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

    // Bug-fix re-dispatch: when Scout moves an issue Test → In Progress
    // because she found bugs, the orchestrator does not re-trigger the
    // dev (Todo→InProgress is its only dispatch path). Without help, the
    // dev's session is over and the issue stays in In Progress until
    // manual intervention.
    //
    // Heuristic: if the issue is back in "In Progress" and has a sticky
    // `dev:<id>` label pointing at a developer-pool agent, and no agent
    // session is currently running on this issue, re-trigger the labelled
    // developer to address Scout's feedback. The first In Progress
    // transition (from orchestrator's own moveIssueToStatus) is covered
    // by the isAgentRunning check — orchestrator creates a PROCESSING
    // reservation event before moving the issue, so the gate is true at
    // that moment and we skip.
    if (toStatus === "In Progress") {
      try {
        const devLabel = payload.data.labels
          ?.map((l) => l.name)
          .find(
            (n) =>
              n.startsWith("dev:") &&
              (DEVELOPER_POOL as readonly string[]).includes(n.slice(4))
          );
        const dev = devLabel?.slice(4);
        if (dev && !(await isAgentRunning(payload.data.identifier))) {
          console.log(
            `[webhook] Re-dispatching ${dev} for ${payload.data.identifier} (Test → In Progress bug-fix loop)`
          );
          // Create a fresh event row so the agent lifecycle tracks cleanly.
          const redispatchEvent = await prisma.webhookEvent.create({
            data: {
              linearEventId: `redispatch-${Date.now()}-${payload.data.identifier}-${dev}`,
              issueId: payload.data.identifier,
              issueTitle: payload.data.title,
              fromStatus: null,
              toStatus: "In Progress",
              status: WebhookEventStatus.RECEIVED,
            },
          });
          triggerAgent({
            eventId: redispatchEvent.id,
            agent: dev,
            issueId: payload.data.identifier,
            issueTitle: payload.data.title,
            issueDescription: payload.data.description,
            toStatus: "In Progress",
          }).catch((error) => {
            console.error(
              `[webhook] Re-dispatch trigger failed for ${payload.data.identifier}:`,
              error
            );
          });
        }
      } catch (error) {
        console.error(
          `[webhook] Bug-fix re-dispatch check failed for ${payload.data.identifier}:`,
          error
        );
      }
    }

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
        // When the route also fires an agent (Test = create-pr + scout),
        // the agent owns the event row's status/triggeredAgent lifecycle.
        // Telling git-workflow to skip its row updates prevents the race
        // where git's writes clobber the agent's session-ID tracking and
        // leave the row COMPLETED before Scout has even been triggered.
        concurrentWithAgent: !!route.agent,
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

  // 13. If issue moved to a terminal state, auto-progress its parent (if any)
  // when all sibling children are also terminal. Parent issues are deliberately
  // skipped by the orchestrator's dispatcher (no implementation work of their
  // own), so without this step they would stay in Todo forever once their
  // children finished. Cascading: moving the parent fires its own webhook
  // which re-enters this handler and can progress a grandparent.
  if (toStatus === "Done" || toStatus === "Canceled" || toStatus === "Duplicate") {
    try {
      const result = await progressParentIfChildrenComplete(payload.data.identifier);
      if (result.moved) {
        console.log(
          `[webhook] Auto-progressed parent ${result.parent} → Done after ${payload.data.identifier} reached ${toStatus}`
        );
      }
    } catch (error) {
      console.error(
        `[webhook] Parent auto-progress failed for ${payload.data.identifier}:`,
        error
      );
    }
  }

  // 14. If issue moved to Done, re-evaluate orchestrator (blocker may have resolved)
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

  } catch (routingError) {
    // Catch-all: any unexpected throw from routing means we didn't reach
    // the sub-handler that would have updated the row. Mark FAILED so the
    // row isn't stuck RECEIVED. Cron-recovery and dashboard alerts can act
    // on FAILED rows; RECEIVED is invisible to downstream automation.
    console.error(
      `[webhook] Routing threw for ${payload.data.identifier} (${toStatus}):`,
      routingError
    );
    const message =
      routingError instanceof Error ? routingError.message : String(routingError);
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: {
        status: WebhookEventStatus.FAILED,
        errorMessage: `Routing threw: ${message.slice(0, 400)}`,
        processedAt: new Date(),
      },
    }).catch((dbErr) => {
      console.error(`[webhook] Could not mark event ${event.id} FAILED:`, dbErr);
    });
    return NextResponse.json(
      { received: true, eventId: event.id, error: "routing_failed" },
      { status: 500 }
    );
  }

  // 15. Invariant guard: row must no longer be RECEIVED. If it is, some
  // sub-handler completed normally but never updated the row (silent
  // failure path). Mark FAILED with a diagnostic so cron-recovery and
  // monitoring can act on it.
  try {
    const final = await prisma.webhookEvent.findUnique({
      where: { id: event.id },
      select: { status: true },
    });
    if (final?.status === WebhookEventStatus.RECEIVED) {
      console.warn(
        `[webhook] Row ${event.id} (${payload.data.identifier} → ${toStatus}) exited handler as RECEIVED — marking FAILED`
      );
      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: {
          status: WebhookEventStatus.FAILED,
          errorMessage: "Sub-handler returned without updating row status",
          processedAt: new Date(),
        },
      });
    }
  } catch (guardErr) {
    console.error(`[webhook] Invariant guard query failed:`, guardErr);
  }

  return NextResponse.json({ received: true, eventId: event.id });
}
