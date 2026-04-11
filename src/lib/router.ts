/**
 * Maps Linear issue statuses to the agent and/or git action that should be triggered.
 */

import type { GitAction } from "./git-workflow";

export interface RouteResult {
  agent: string | null;
  action: "trigger" | "log" | "notify" | "git";
  description: string;
  gitAction?: GitAction;
}

const STATUS_AGENT_MAP: Record<string, RouteResult> = {
  Refinement: {
    agent: "saga",
    action: "trigger",
    description: "Saga (PM) starter sparring og PRD-skrivning",
  },
  Specification: {
    agent: "atlas",
    action: "trigger",
    description: "Atlas (Tech Lead) starter teknisk design (TRD)",
  },
  Todo: {
    agent: null,
    action: "trigger",
    description:
      "Developer-orkestrering — tildel til ledig developer (TEA-11)",
  },
  "In Progress": {
    agent: null,
    action: "git",
    gitAction: "create-branch",
    description: "Opret feature branch fra main",
  },
  Test: {
    agent: "scout",
    action: "trigger",
    gitAction: "create-pr",
    description: "Opret PR + Scout (Tester) starter testplan og test-eksekvering",
  },
  Review: {
    agent: null,
    action: "notify",
    description: "Notificér Ole — klar til review",
  },
  Done: {
    agent: null,
    action: "git",
    gitAction: "auto-merge",
    description: "Auto-merge PR (squash) og slet branch",
  },
  Backlog: {
    agent: null,
    action: "log",
    description: "Oles idé-dump — kun log",
  },
  Canceled: {
    agent: null,
    action: "log",
    description: "Issue annulleret — kun log",
  },
  Duplicate: {
    agent: null,
    action: "log",
    description: "Issue markeret som duplikat — kun log",
  },
};

export function routeStatus(status: string): RouteResult {
  return (
    STATUS_AGENT_MAP[status] ?? {
      agent: null,
      action: "log",
      description: `Ukendt status: ${status}`,
    }
  );
}
