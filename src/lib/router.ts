/**
 * Maps Linear issue statuses to the agent that should be triggered.
 * Returns null if no agent should be triggered (informational or manual step).
 */

export interface RouteResult {
  agent: string | null;
  action: "trigger" | "log" | "notify";
  description: string;
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
    action: "log",
    description: "Developer arbejder — kun log",
  },
  Test: {
    agent: "scout",
    action: "trigger",
    description: "Scout (Tester) starter testplan og test-eksekvering",
  },
  Review: {
    agent: null,
    action: "notify",
    description: "Notificér Ole — klar til review",
  },
  Done: {
    agent: null,
    action: "trigger",
    description: "Trigger auto-merge (TEA-9)",
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
