import { getGitHubConfig, getRepoForTeam } from "./config";
import {
  createFeatureBranch,
  createPullRequest,
  autoMergePR,
  closePR,
} from "./github";
import { addIssueComment } from "./linear-client";
import { prisma } from "./prisma";
import { WebhookEventStatus } from "@/generated/prisma/enums";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export type GitAction = "create-branch" | "create-pr" | "auto-merge" | "close-pr";

interface GitWorkflowInput {
  eventId: string;
  action: GitAction;
  issueKey: string;
  issueTitle: string;
  issueDescription?: string;
  teamKey?: string;
  labels?: string[];
  /**
   * Set true when a triggerAgent call runs in parallel on the same event
   * row (Test transition runs `create-pr` + `scout` together). In that
   * case the agent owns the row's status/triggeredAgent/errorMessage
   * lifecycle — git-workflow must not write to those fields or it races
   * the agent. Git output is logged only.
   */
  concurrentWithAgent?: boolean;
}

/**
 * Execute a git workflow action (branch, PR, or merge).
 * Runs with retry logic and updates the webhook event in the database.
 */
export async function executeGitAction(
  input: GitWorkflowInput
): Promise<void> {
  const { owner } = getGitHubConfig();
  const repo = getRepoForTeam(input.teamKey);
  const skipRowUpdates = input.concurrentWithAgent === true;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Update event to PROCESSING — but only when we own the row.
      // When triggerAgent runs in parallel for the same eventId, it owns
      // status/triggeredAgent and this update would race its writes.
      if (!skipRowUpdates) {
        await prisma.webhookEvent.update({
          where: { id: input.eventId },
          data: {
            status: WebhookEventStatus.PROCESSING,
            triggeredAgent: `git:${input.action}`,
            retryCount: attempt,
          },
        });
      }

      let resultMessage: string;

      switch (input.action) {
        case "create-branch": {
          const result = await createFeatureBranch({
            owner,
            repo,
            issueKey: input.issueKey,
            issueTitle: input.issueTitle,
          });
          resultMessage = `Branch created: ${result.branchName} (${result.sha.slice(0, 7)})`;
          break;
        }

        case "create-pr": {
          const result = await createPullRequest({
            owner,
            repo,
            issueKey: input.issueKey,
            issueTitle: input.issueTitle,
          });

          if (result.noCommits) {
            resultMessage = `No commits on branch '${result.branchName}' — PR skipped (branch exists, awaiting agent commits)`;
            break;
          }

          resultMessage = `PR created: #${result.prNumber} ${result.prUrl}`;

          // Hotfix fast-track: merge immediately if labeled
          if (input.labels?.some((l) => l.toLowerCase() === "hotfix")) {
            console.log(
              `[git-workflow] Hotfix detected for ${input.issueKey} — auto-merging`
            );
            const mergeResult = await autoMergePR({
              owner,
              repo,
              issueKey: input.issueKey,
            });
            resultMessage += ` | Hotfix merged: ${mergeResult.sha?.slice(0, 7)}`;
          }
          break;
        }

        case "auto-merge": {
          const result = await autoMergePR({
            owner,
            repo,
            issueKey: input.issueKey,
          });

          if (result.merged) {
            resultMessage = `Merged PR #${result.prNumber} (squash): ${result.sha?.slice(0, 7)}`;
          } else {
            resultMessage = "No PR to merge";
          }
          break;
        }

        case "close-pr": {
          const result = await closePR({
            owner,
            repo,
            issueKey: input.issueKey,
          });

          if (result.closed) {
            resultMessage = `Closed PR #${result.prNumber} and deleted branch (issue Cancelled)`;
          } else {
            resultMessage = "No open PR found for Cancelled issue — nothing to do";
          }
          break;
        }

        default:
          resultMessage = `Unknown git action: ${input.action}`;
      }

      // Mark as completed — only when we own the row. When an agent is also
      // running on this event (Test: create-pr + scout), the agent's
      // lifecycle owns status/processedAt; writing COMPLETED here races
      // triggerAgent's writes and can make the event look finished before
      // the agent has even started.
      if (!skipRowUpdates) {
        await prisma.webhookEvent.update({
          where: { id: input.eventId },
          data: {
            status: WebhookEventStatus.COMPLETED,
            processedAt: new Date(),
          },
        });
      }

      console.log(
        `[git-workflow] ${input.action} completed for ${input.issueKey}: ${resultMessage}`
      );
      return;
    } catch (error) {
      const isLastAttempt = attempt === MAX_RETRIES;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      console.error(
        `[git-workflow] Attempt ${attempt + 1}/${MAX_RETRIES + 1} '${input.action}' failed for ${input.issueKey}: ${errorMessage}`
      );

      // Handle merge conflicts specifically — don't retry, notify instead
      if (errorMessage.includes("Merge conflict") || errorMessage.includes("Manual resolution needed")) {
        await handleMergeConflict(input, errorMessage);
        return;
      }

      if (isLastAttempt) {
        // Only write FAILED when we own the row. When the agent is also
        // running, leave the row to the agent's lifecycle — the git error
        // is logged above, and posting a Linear comment about a failed
        // create-pr is handled separately if needed.
        if (!skipRowUpdates) {
          await prisma.webhookEvent.update({
            where: { id: input.eventId },
            data: {
              status: WebhookEventStatus.FAILED,
              errorMessage: `All retries exhausted: ${errorMessage}`,
              retryCount: attempt,
              processedAt: new Date(),
            },
          });
        }
        return;
      }

      // Exponential backoff
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Handle merge conflicts by posting a Linear comment and marking event as failed.
 */
async function handleMergeConflict(
  input: GitWorkflowInput,
  errorMessage: string
): Promise<void> {
  // Post comment on Linear issue
  try {
    await addIssueComment(
      input.issueKey,
      [
        `⚠️ **Git merge-konflikt**`,
        ``,
        `Git-operationen \`${input.action}\` fejlede:`,
        `> ${errorMessage}`,
        ``,
        `Konflikten skal løses manuelt.`,
      ].join("\n")
    );
  } catch (commentError) {
    console.error(
      `[git-workflow] Failed to post conflict comment on ${input.issueKey}:`,
      commentError
    );
  }

  // Mark event as failed
  await prisma.webhookEvent.update({
    where: { id: input.eventId },
    data: {
      status: WebhookEventStatus.FAILED,
      errorMessage: `Merge conflict: ${errorMessage}`,
      processedAt: new Date(),
    },
  });
}
