import { Issue } from "@linear/sdk";
import { prisma } from "./prisma";
import { WebhookEventStatus } from "@/generated/prisma/enums";
import { DEVELOPER_POOL, ORCHESTRATOR_CONFIG, type DeveloperAgent } from "./config";
import {
  getTodoIssues,
  areBlockersResolved,
  moveIssueToStatus,
  addLabelToIssue,
  addIssueComment,
} from "./linear-client";
import { triggerAgent } from "./agent-trigger";
import { acquireOrchestratorLock, releaseOrchestratorLock } from "./concurrency";

interface DispatchResult {
  assigned: number;
  assignments: Array<{ issueId: string; developer: string }>;
  skipped: number;
  reason?: string;
}

/**
 * Core orchestrator function. Assigns available Todo issues to idle developers.
 * Idempotent and concurrency-safe via DB lock.
 *
 * Called from:
 *   - Webhook handler (issue → Todo or → Done)
 *   - Cron poller (developer agent completes)
 *   - Callback endpoint (developer agent completes)
 */
export async function dispatchAvailableWork(): Promise<DispatchResult> {
  // 1. Acquire concurrency lock
  const locked = await acquireOrchestratorLock();
  if (!locked) {
    console.log("[orchestrator] Lock held — skipping dispatch");
    return { assigned: 0, assignments: [], skipped: 0, reason: "lock_held" };
  }

  try {
    // 2. Find available developers
    const availableDevelopers = await getAvailableDevelopers();
    if (availableDevelopers.length === 0) {
      console.log("[orchestrator] No available developers");
      return { assigned: 0, assignments: [], skipped: 0, reason: "no_available_developers" };
    }

    console.log(
      `[orchestrator] Available developers: ${availableDevelopers.join(", ")}`
    );

    // 3. Find Todo issues with resolved blockers
    const readyIssues = await getTodoIssuesReady();
    if (readyIssues.length === 0) {
      console.log("[orchestrator] No ready Todo issues");
      return { assigned: 0, assignments: [], skipped: 0, reason: "no_ready_issues" };
    }

    console.log(
      `[orchestrator] Ready issues: ${readyIssues.map((i) => i.identifier).join(", ")}`
    );

    // 4. Assign issues to developers (min of available devs and ready issues)
    const assignments: Array<{ issueId: string; developer: string }> = [];
    const count = Math.min(availableDevelopers.length, readyIssues.length);

    for (let i = 0; i < count; i++) {
      const developer = availableDevelopers[i];
      const issue = readyIssues[i];

      try {
        await assignIssueToDeveloper(issue, developer);
        assignments.push({ issueId: issue.identifier, developer });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(
          `[orchestrator] Failed to assign ${issue.identifier} to ${developer}: ${msg}`
        );
      }
    }

    const skipped = readyIssues.length - count;
    console.log(
      `[orchestrator] Dispatched ${assignments.length} assignments, ${skipped} issues waiting`
    );

    return { assigned: assignments.length, assignments, skipped };
  } finally {
    await releaseOrchestratorLock();
  }
}

/**
 * Find developers that are not currently processing any issue.
 */
async function getAvailableDevelopers(): Promise<DeveloperAgent[]> {
  const busyEvents = await prisma.webhookEvent.findMany({
    where: {
      status: WebhookEventStatus.PROCESSING,
      triggeredAgent: { in: [...DEVELOPER_POOL] },
    },
    select: { triggeredAgent: true },
  });

  const busyDevelopers = new Set(busyEvents.map((e) => e.triggeredAgent));

  return DEVELOPER_POOL.filter(
    (dev) => !busyDevelopers.has(dev)
  ) as DeveloperAgent[];
}

/**
 * Fetch Todo issues where all blockers are resolved.
 * Sorted by priority (1=Urgent first, 4=Low last).
 */
async function getTodoIssuesReady(): Promise<Issue[]> {
  const { teamKey } = ORCHESTRATOR_CONFIG;
  const todoIssues = await getTodoIssues(teamKey);

  const readyIssues: Issue[] = [];

  for (const issue of todoIssues) {
    try {
      const { resolved, pendingBlockers } = await areBlockersResolved(issue);
      if (resolved) {
        readyIssues.push(issue);
      } else {
        console.log(
          `[orchestrator] ${issue.identifier} blocked by: ${pendingBlockers.join(", ")}`
        );
      }
    } catch (error) {
      console.error(
        `[orchestrator] Error checking blockers for ${issue.identifier}:`,
        error
      );
    }
  }

  // Sort by priority (1=Urgent, 2=High, 3=Medium, 4=Low, 0=None→last)
  readyIssues.sort((a, b) => {
    const pa = a.priority === 0 ? 5 : a.priority;
    const pb = b.priority === 0 ? 5 : b.priority;
    return pa - pb;
  });

  return readyIssues;
}

/**
 * Assign an issue to a developer agent:
 * 1. Reserve the developer slot with a PROCESSING event
 * 2. Move the issue to In Progress in Linear + add dev label
 * 3. Trigger the developer agent
 * 4. Post a comment on the issue
 */
async function assignIssueToDeveloper(
  issue: Issue,
  developer: DeveloperAgent
): Promise<void> {
  const { teamKey, labelPrefix, labelColors } = ORCHESTRATOR_CONFIG;

  console.log(
    `[orchestrator] Assigning ${issue.identifier} to ${developer}`
  );

  // 1. Create a reservation event (marks developer as busy immediately)
  const event = await prisma.webhookEvent.create({
    data: {
      linearEventId: `orchestrator-${Date.now()}-${issue.identifier}-${developer}`,
      issueId: issue.identifier,
      issueTitle: issue.title,
      toStatus: "In Progress",
      status: WebhookEventStatus.PROCESSING,
      triggeredAgent: developer,
    },
  });

  try {
    // 2. Add developer label in Linear
    const team = await issue.team;
    if (team) {
      const labelName = `${labelPrefix}${developer}`;
      await addLabelToIssue(issue, team.id, labelName, labelColors[developer]);
    }

    // 3. Move issue to In Progress via Linear API
    // This triggers a new webhook → branch creation (desired cascade)
    await moveIssueToStatus(issue.id, teamKey, "In Progress");

    // 4. Fetch issue description for the agent
    const description = issue.description ?? undefined;

    // 5. Trigger the developer agent
    await triggerAgent({
      eventId: event.id,
      agent: developer,
      issueId: issue.identifier,
      issueTitle: issue.title,
      issueDescription: description,
      toStatus: "In Progress",
    });

    // 6. Post comment on the issue
    const devName = developer.charAt(0).toUpperCase() + developer.slice(1);
    await addIssueComment(
      issue.identifier,
      `🤖 **Tildelt developer-agent: ${devName}**\n\n${devName} er nu i gang med at implementere dette issue.`
    );

    console.log(
      `[orchestrator] ${issue.identifier} assigned to ${developer} (event: ${event.id})`
    );
  } catch (error) {
    // If assignment fails, clean up the reservation
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: {
        status: WebhookEventStatus.FAILED,
        errorMessage: `Assignment failed: ${error instanceof Error ? error.message : String(error)}`,
        processedAt: new Date(),
      },
    });
    throw error;
  }
}
