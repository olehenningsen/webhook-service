import { z } from "zod";

// ─── Developer Pool & Orchestrator Config (TEA-11) ──────────

export const DEVELOPER_POOL = ["pixel", "sprite", "byte", "loop"] as const;
export type DeveloperAgent = (typeof DEVELOPER_POOL)[number];

export const ORCHESTRATOR_CONFIG = {
  teamKey: "TEA",
  maxDeveloperTimeMs: 30 * 60 * 1000, // 30 minutes before escalation
  labelPrefix: "dev:",
  labelColors: {
    pixel: "#FF6B6B",
    sprite: "#4ECDC4",
    byte: "#45B7D1",
    loop: "#96CEB4",
  } as Record<DeveloperAgent, string>,
};

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  LINEAR_WEBHOOK_SECRET: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  API_KEY: z.string().min(1),
  VERCEL_URL: z.string().optional(),
  CRON_SECRET: z.string().optional(),

  // GitHub (TEA-9: Git workflow engine)
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_OWNER: z.string().optional(),
  GITHUB_DEFAULT_REPO: z.string().optional(),
  // Optional JSON map for routing Linear teams/projects to specific repos:
  //   { "team:TEA": "agent-dashboard", "project:Foo": "foo-repo" }
  // Falls back to GITHUB_DEFAULT_REPO when no entry matches.
  GITHUB_REPO_MAP: z.string().optional(),

  // Linear API (for write-back: comments, status changes)
  LINEAR_API_KEY: z.string().optional(),

  // Managed agent IDs
  AGENT_ID_SAGA: z.string().optional(),
  AGENT_ID_ATLAS: z.string().optional(),
  AGENT_ID_PIXEL: z.string().optional(),
  AGENT_ID_SPRITE: z.string().optional(),
  AGENT_ID_BYTE: z.string().optional(),
  AGENT_ID_LOOP: z.string().optional(),
  AGENT_ID_SCOUT: z.string().optional(),

  // Environment IDs
  ENV_ID_PLANNING: z.string().optional(),
  ENV_ID_DEVELOPMENT: z.string().optional(),

  // Vault IDs (MCP OAuth credentials)
  VAULT_ID_MCP: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (!_env) {
    _env = envSchema.parse(process.env);
  }
  return _env;
}

export function getCallbackUrl(): string {
  const env = getEnv();
  const base = env.VERCEL_URL
    ? `https://${env.VERCEL_URL}`
    : "http://localhost:3000";
  return `${base}/api/callback`;
}

/**
 * Resolve an agent name to its managed agent ID and environment ID.
 * Throws if the agent is not configured.
 */
export function getAgentConfig(agentName: string): {
  agentId: string;
  environmentId: string;
  vaultIds: string[];
} {
  const env = getEnv();

  const agentIdMap: Record<string, string | undefined> = {
    saga: env.AGENT_ID_SAGA,
    atlas: env.AGENT_ID_ATLAS,
    pixel: env.AGENT_ID_PIXEL,
    sprite: env.AGENT_ID_SPRITE,
    byte: env.AGENT_ID_BYTE,
    loop: env.AGENT_ID_LOOP,
    scout: env.AGENT_ID_SCOUT,
  };

  // Planning agents (Saga, Atlas) use the planning environment
  // Development agents (devs + Scout) use the development environment
  const environmentMap: Record<string, string | undefined> = {
    saga: env.ENV_ID_PLANNING,
    atlas: env.ENV_ID_PLANNING,
    pixel: env.ENV_ID_DEVELOPMENT,
    sprite: env.ENV_ID_DEVELOPMENT,
    byte: env.ENV_ID_DEVELOPMENT,
    loop: env.ENV_ID_DEVELOPMENT,
    scout: env.ENV_ID_DEVELOPMENT,
  };

  const agentId = agentIdMap[agentName];
  const environmentId = environmentMap[agentName];

  if (!agentId) {
    throw new Error(
      `Agent '${agentName}' not configured. Set AGENT_ID_${agentName.toUpperCase()} env var.`
    );
  }

  if (!environmentId) {
    throw new Error(
      `Environment for '${agentName}' not configured. Set ENV_ID_PLANNING or ENV_ID_DEVELOPMENT env var.`
    );
  }

  // NOTE: All agents (including Saga) need vault_ids — Linear MCP at
  // mcp.linear.app/mcp authenticates via OAuth credentials injected from the
  // vault. A previous optimization to skip vault for Saga broke her Linear
  // MCP access (observed on TEA-61 — she made 0 MCP calls and hallucinated
  // having posted PRDs / moved state).
  return { agentId, environmentId, vaultIds: getVaultIds() };
}

/**
 * Get vault IDs for MCP credential injection into agent sessions.
 */
function getVaultIds(): string[] {
  const env = getEnv();
  return env.VAULT_ID_MCP ? [env.VAULT_ID_MCP.trim()] : [];
}

/**
 * Parse GITHUB_REPO_MAP env var into a Record<string, string>.
 * Returns an empty map on missing or invalid input — no parse failure is fatal.
 * Memoized so we don't re-parse on every call.
 */
let _repoMap: Record<string, string> | null = null;
function getRepoMap(): Record<string, string> {
  if (_repoMap !== null) return _repoMap;

  const raw = getEnv().GITHUB_REPO_MAP;
  if (!raw) {
    _repoMap = {};
    return _repoMap;
  }

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.warn("[config] GITHUB_REPO_MAP must be a JSON object — ignoring");
      _repoMap = {};
      return _repoMap;
    }
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") {
        clean[k] = v;
      } else {
        console.warn(`[config] GITHUB_REPO_MAP: skipping non-string value for '${k}'`);
      }
    }
    _repoMap = clean;
  } catch (error) {
    console.warn("[config] GITHUB_REPO_MAP is invalid JSON — ignoring:", error);
    _repoMap = {};
  }
  return _repoMap;
}

/**
 * Get GitHub configuration for git workflow operations.
 */
export function getGitHubConfig(): {
  token: string;
  owner: string;
  defaultRepo: string;
} {
  const env = getEnv();

  if (!env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN env var not configured.");
  }
  if (!env.GITHUB_OWNER) {
    throw new Error("GITHUB_OWNER env var not configured.");
  }
  if (!env.GITHUB_DEFAULT_REPO) {
    throw new Error("GITHUB_DEFAULT_REPO env var not configured.");
  }

  return {
    token: env.GITHUB_TOKEN,
    owner: env.GITHUB_OWNER,
    defaultRepo: env.GITHUB_DEFAULT_REPO,
  };
}

/**
 * Resolve the GitHub repo for a Linear team key (and optionally a project name).
 *
 * Lookup order:
 *   1. `project:<projectName>` in GITHUB_REPO_MAP
 *   2. `team:<teamKey>` in GITHUB_REPO_MAP
 *   3. GITHUB_DEFAULT_REPO (fallback)
 *
 * GITHUB_REPO_MAP is an optional JSON env var, e.g.:
 *   {"team:TEA": "agent-dashboard", "project:Mobile App": "mobile-app"}
 *
 * Invalid JSON is logged and treated as an empty map (no breakage).
 */
export function getRepoForTeam(teamKey?: string, projectName?: string): string {
  const { defaultRepo } = getGitHubConfig();
  const map = getRepoMap();

  if (projectName) {
    const hit = map[`project:${projectName}`];
    if (hit) return hit;
  }
  if (teamKey) {
    const hit = map[`team:${teamKey}`];
    if (hit) return hit;
  }
  return defaultRepo;
}
