import { LinearClient, Issue, IssueRelation } from "@linear/sdk";
import { getEnv } from "./config";

let _client: LinearClient | null = null;

export function getLinearClient(): LinearClient {
  if (!_client) {
    const env = getEnv();
    if (!env.LINEAR_API_KEY) {
      throw new Error("LINEAR_API_KEY env var not configured.");
    }
    _client = new LinearClient({ apiKey: env.LINEAR_API_KEY });
  }
  return _client;
}

// ─── Comments ──────────────────────────────────────────────

/**
 * Post a comment on a Linear issue.
 * Uses the issue identifier (e.g., "TEA-9") to find the issue first.
 */
export async function addIssueComment(
  issueIdentifier: string,
  body: string
): Promise<void> {
  const client = getLinearClient();

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

// ─── Issue Queries (TEA-11) ────────────────────────────────

/**
 * Fetch all issues in Todo status for a team.
 */
export async function getTodoIssues(teamKey: string): Promise<Issue[]> {
  const client = getLinearClient();

  const issues = await client.issues({
    filter: {
      team: { key: { eq: teamKey } },
      state: { name: { eq: "Todo" } },
    },
    first: 50,
  });

  return issues.nodes;
}

/**
 * Check if an issue is a "parent wrapper" — has child issues that aren't all Done.
 * Parent issues should NOT be dispatched to developers, since their actual
 * implementation work lives in the sub-issues. Returns true if the issue has
 * any children and at least one is not Done.
 */
export async function hasUnfinishedChildren(issue: Issue): Promise<boolean> {
  const children = await issue.children();
  if (children.nodes.length === 0) return false;
  for (const child of children.nodes) {
    const state = await child.state;
    if (!state || state.name !== "Done") return true;
  }
  return false;
}

/**
 * Check if all blockers for an issue are Done.
 * Returns { resolved: true } if no blockers or all blockers are Done.
 * Uses inverseRelations (issues that block this one).
 */
export async function areBlockersResolved(
  issue: Issue
): Promise<{ resolved: boolean; pendingBlockers: string[] }> {
  const relations = await issue.relations();
  const inverseRelations = await issue.inverseRelations();

  // Collect all blocking issue relations
  // Direct: this issue has relation type "blocks" pointing FROM another issue
  // Inverse: another issue has relation type "blocks" pointing TO this issue
  const blockerRelations: IssueRelation[] = [];

  for (const rel of relations.nodes) {
    if (rel.type === "blocks") {
      // This means the related issue blocks this one...
      // Actually in Linear: relation type "blocks" on issue A means A blocks the related issue
      // We need inverseRelations where type === "blocks" (those block us)
    }
  }

  for (const rel of inverseRelations.nodes) {
    if (rel.type === "blocks") {
      // This inverse relation means: the source issue blocks our issue
      blockerRelations.push(rel);
    }
  }

  if (blockerRelations.length === 0) {
    return { resolved: true, pendingBlockers: [] };
  }

  const pendingBlockers: string[] = [];

  for (const rel of blockerRelations) {
    const blockerIssue = await rel.issue;
    if (!blockerIssue) continue;

    const state = await blockerIssue.state;
    if (!state || state.name !== "Done") {
      pendingBlockers.push(blockerIssue.identifier);
    }
  }

  return {
    resolved: pendingBlockers.length === 0,
    pendingBlockers,
  };
}

// ─── Issue Updates (TEA-11) ────────────────────────────────

// Cache for status name → ID mapping
const _statusIdCache = new Map<string, string>();

/**
 * Get the workflow state ID for a status name in a team.
 */
export async function getStatusId(
  teamKey: string,
  statusName: string
): Promise<string> {
  const cacheKey = `${teamKey}:${statusName}`;
  if (_statusIdCache.has(cacheKey)) {
    return _statusIdCache.get(cacheKey)!;
  }

  const client = getLinearClient();
  const states = await client.workflowStates({
    filter: {
      team: { key: { eq: teamKey } },
      name: { eq: statusName },
    },
  });

  const state = states.nodes[0];
  if (!state) {
    throw new Error(
      `Status '${statusName}' not found for team '${teamKey}'`
    );
  }

  _statusIdCache.set(cacheKey, state.id);
  return state.id;
}

/**
 * Move an issue to a new status.
 */
export async function moveIssueToStatus(
  issueId: string,
  teamKey: string,
  statusName: string
): Promise<void> {
  const client = getLinearClient();
  const stateId = await getStatusId(teamKey, statusName);

  await client.updateIssue(issueId, { stateId });
  console.log(`[linear-client] Moved issue to '${statusName}'`);
}

// ─── Labels (TEA-11) ───────────────────────────────────────

// Cache for label name → ID mapping
const _labelIdCache = new Map<string, string>();

/**
 * Get or create a label by name in a team.
 */
export async function getOrCreateLabel(
  teamId: string,
  name: string,
  color?: string
): Promise<string> {
  if (_labelIdCache.has(name)) {
    return _labelIdCache.get(name)!;
  }

  const client = getLinearClient();

  // Search for existing label
  const labels = await client.issueLabels({
    filter: { name: { eq: name }, team: { id: { eq: teamId } } },
  });

  if (labels.nodes.length > 0) {
    const id = labels.nodes[0].id;
    _labelIdCache.set(name, id);
    return id;
  }

  // Create new label
  const result = await client.createIssueLabel({
    name,
    color: color ?? "#888888",
    teamId,
  });

  const label = await result.issueLabel;
  if (!label) {
    throw new Error(`Failed to create label '${name}'`);
  }

  _labelIdCache.set(name, label.id);
  console.log(`[linear-client] Created label '${name}' (${label.id})`);
  return label.id;
}

/**
 * Add a label to an issue by its identifier (e.g. "TEA-67").
 * Looks up the issue, then delegates to addLabelToIssue.
 * No-op if the issue can't be found.
 */
export async function addLabelByIssueKey(
  issueIdentifier: string,
  labelName: string,
  labelColor?: string
): Promise<void> {
  const client = getLinearClient();
  const results = await client.searchIssues(issueIdentifier, { first: 1 });
  const found = results.nodes[0];
  if (!found) {
    console.warn(`[linear-client] addLabelByIssueKey: ${issueIdentifier} not found`);
    return;
  }
  // searchIssues returns IssueSearchResult which lacks some Issue methods —
  // fetch the full Issue by ID so addLabelToIssue can call issue.labels() etc.
  const issue = await client.issue(found.id);
  const team = await issue.team;
  if (!team) {
    console.warn(`[linear-client] addLabelByIssueKey: ${issueIdentifier} has no team`);
    return;
  }
  await addLabelToIssue(issue, team.id, labelName, labelColor);
}

/**
 * Add a label to an issue (preserves existing labels).
 */
export async function addLabelToIssue(
  issue: Issue,
  teamId: string,
  labelName: string,
  labelColor?: string
): Promise<void> {
  const client = getLinearClient();
  const labelId = await getOrCreateLabel(teamId, labelName, labelColor);

  // Get current labels
  const currentLabels = await issue.labels();
  const currentLabelIds = currentLabels.nodes.map((l) => l.id);

  // Add new label if not already present
  if (currentLabelIds.includes(labelId)) return;

  await client.updateIssue(issue.id, {
    labelIds: [...currentLabelIds, labelId],
  });

  console.log(`[linear-client] Added label '${labelName}' to ${issue.identifier}`);
}
