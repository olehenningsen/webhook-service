import { LinearClient } from "@linear/sdk";
import { getEnv } from "./config";

let _client: LinearClient | null = null;

function getLinearClient(): LinearClient {
  if (!_client) {
    const env = getEnv();
    if (!env.LINEAR_API_KEY) {
      throw new Error("LINEAR_API_KEY env var not configured.");
    }
    _client = new LinearClient({ apiKey: env.LINEAR_API_KEY });
  }
  return _client;
}

/**
 * Post a comment on a Linear issue.
 * Uses the issue identifier (e.g., "TEA-9") to find the issue first.
 */
export async function addIssueComment(
  issueIdentifier: string,
  body: string
): Promise<void> {
  const client = getLinearClient();

  // Use the search to find issue by identifier
  const results = await client.searchIssues(issueIdentifier, { first: 1 });
  const issue = results.nodes[0];

  if (!issue) {
    console.warn(`[linear-client] Issue ${issueIdentifier} not found`);
    return;
  }

  await client.createComment({
    issueId: issue.id,
    body,
  });

  console.log(`[linear-client] Posted comment on ${issueIdentifier}`);
}
