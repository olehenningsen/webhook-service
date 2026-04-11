import { NextRequest, NextResponse } from "next/server";
import { verifyLinearSignature } from "@/lib/signature";
import { getEnv } from "@/lib/config";
import { prisma } from "@/lib/prisma";
import { routeStatus } from "@/lib/router";
import { isAgentRunning, enqueue } from "@/lib/queue";
import { triggerAgent } from "@/lib/agent-trigger";
import {
  LinearWebhookPayloadSchema,
  isStatusChange,
  generateEventId,
} from "@/types/linear-webhook";
import { WebhookEventStatus } from "@/generated/prisma/enums";

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

  // 7. Route status to agent
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

  // 8. Check queue — is an agent already running on this issue?
  if (await isAgentRunning(payload.data.identifier)) {
    await enqueue(event.id, payload.data.identifier);
    return NextResponse.json({
      received: true,
      eventId: event.id,
      queued: true,
    });
  }

  // 9. Trigger agent (if there is one to trigger)
  if (route.agent) {
    // Fire and forget — don't block the webhook response
    triggerAgent({
      eventId: event.id,
      agent: route.agent,
      issueId: payload.data.identifier,
      issueTitle: payload.data.title,
      issueDescription: payload.data.description,
      toStatus,
    }).catch((error) => {
      console.error(
        `[webhook] Background agent trigger failed for ${payload.data.identifier}:`,
        error
      );
    });
  } else {
    // No specific agent (e.g., Todo → developer orchestration, Done → auto-merge)
    // Mark as completed for now — TEA-11 and TEA-9 will add handling
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: {
        status: WebhookEventStatus.COMPLETED,
        processedAt: new Date(),
      },
    });
  }

  return NextResponse.json({ received: true, eventId: event.id });
}
