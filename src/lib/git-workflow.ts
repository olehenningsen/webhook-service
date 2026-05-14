import { getGitHubConfig, getRepoForTeam } from "./config";
import {
  createFeatureBranch,
  createPullRequest,
  autoMergePR,
} from "./github";
import { addIssueComment } from "./linear-client";
import { prisma } from "./prisma";
import { WebhookEventStatus } from "@/generated/prisma/enums";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export type GitAction = "create-branch" | "create-pr" | "auto-merge";

interface GitWorkflowInput {
  eventId: string;
  action: GitAction;
  issueKey: string;
  issueTitle: string;
  issueDescription?: string;
  teamKey?: string;
  labels?: string[];
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

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Update event to PROCESSING
      await prisma.webhookEvent.update({
        where: { id: input.eventId },
        data: {
          status: WebhookEventStatus.PROCESSING,
          triggeredAgent: `git:${input.action}`,
          retryCount: attempt,
        },
      });

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

        default:
          resultMessage = `Unknown git action: ${input.action}`;
      }

      // Mark as completed.
      // IMPORTANT: do NOT write to agentSessionId here — it's reserved for the
      // Anthropic session ID set by triggerAgent. When a route triggers both a
      // git action and an agent (e.g. Test: create-pr + scout), git-workflow
      // and agent-trigger may run on the same event row. Writing the git
      // result message here would clobber the session ID stored by triggerAgent,
      // making the cron poller unable to detect agent completion.
      await prisma.webhookEvent.update({
        where: { id: input.eventId },
        data: {
          status: WebhookEventStatus.COMPLETED,
          processedAt: new Date(),
        },
      });

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
        await prisma.webhookEvent.update({
          where: { id: input.eventId },
          data: {
            status: WebhookEventStatus.FAILED,
            errorMessage: `All retries exhausted: ${errorMessage}`,
            retryCount: attempt,
            processedAt: new Date(),
          },
        });
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
