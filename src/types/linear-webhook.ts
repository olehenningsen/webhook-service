import { z } from "zod";

/**
 * Linear webhook payload for issue updates.
 * See: https://developers.linear.app/docs/graphql/webhooks
 */
export const LinearWebhookPayloadSchema = z.object({
  action: z.string(),
  type: z.string(),
  data: z.object({
    id: z.string(),
    identifier: z.string(),
    title: z.string(),
    description: z.string().optional(),
    state: z
      .object({
        name: z.string(),
      })
      .optional(),
    team: z
      .object({
        key: z.string(),
      })
      .optional(),
    labels: z
      .array(
        z.object({
          name: z.string(),
        })
      )
      .optional(),
  }),
  updatedFrom: z
    .object({
      stateId: z.string().optional(),
    })
    .optional(),
  webhookId: z.string().optional(),
  webhookTimestamp: z.number().optional(),
  url: z.string().optional(),
});

export type LinearWebhookPayload = z.infer<typeof LinearWebhookPayloadSchema>;

/**
 * Check if this webhook event is a status change.
 */
export function isStatusChange(payload: LinearWebhookPayload): boolean {
  return (
    payload.action === "update" &&
    payload.type === "Issue" &&
    payload.updatedFrom?.stateId !== undefined
  );
}

/**
 * Generate a unique event ID for idempotency.
 * Combines webhook timestamp + issue ID + new state to handle duplicate deliveries.
 */
export function generateEventId(payload: LinearWebhookPayload): string {
  const timestamp = payload.webhookTimestamp ?? Date.now();
  const issueId = payload.data.identifier;
  const state = payload.data.state?.name ?? "unknown";
  return `${timestamp}-${issueId}-${state}`;
}
