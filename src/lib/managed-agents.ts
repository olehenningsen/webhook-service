import { getEnv } from "./config";

const BASE_URL = "https://api.anthropic.com";
const BETA_HEADER = "managed-agents-2026-04-01";
const API_VERSION = "2023-06-01";

interface SessionResponse {
  id: string;
  type: "session";
  status: "rescheduling" | "running" | "idle" | "terminated";
  title: string | null;
  created_at: string;
  updated_at: string;
  stats?: {
    active_seconds: number;
    duration_seconds: number;
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

interface AgentResponse {
  id: string;
  type: "agent";
  name: string;
  version: number;
  created_at: string;
}

interface EnvironmentResponse {
  id: string;
  type: "environment";
  name: string;
  created_at: string;
}

function getHeaders(): Record<string, string> {
  const env = getEnv();
  return {
    "x-api-key": env.ANTHROPIC_API_KEY,
    "anthropic-version": API_VERSION,
    "anthropic-beta": BETA_HEADER,
    "content-type": "application/json",
  };
}

const DEFAULT_TIMEOUT_MS = 30_000;
// createSession provisions a sandbox (vault auth, github_repository mount,
// MCP server setup). Under load the server-side work can exceed 30s even
// though the typical case is 1-5s. Each retry on AbortError leaks an
// orphan session in Anthropic (provisioning runs to completion regardless
// of our fetch abort), so we give createSession a longer budget. Capped
// well below Vercel function maxDuration (60s) so the outer handler can
// still mark FAILED cleanly.
const CREATE_SESSION_TIMEOUT_MS = 50_000;

async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const options: RequestInit = {
    method,
    headers: getHeaders(),
    // Bound every request — without this, a hanging fetch silently dies
    // when Vercel kills the function runtime, leaving orphan sessions
    // (e.g. session created but initial sendEvent never delivered).
    signal: AbortSignal.timeout(timeoutMs),
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Managed Agents API error (${response.status}): ${errorBody}`
    );
  }

  return response.json() as Promise<T>;
}

/**
 * List events for a session. Used to verify that a sendEvent call
 * actually delivered (sometimes the POST succeeds but the message
 * never lands).
 */
interface EventListResponse {
  data: Array<{ type: string; id: string }>;
}

export async function listSessionEvents(
  sessionId: string,
  limit = 5
): Promise<EventListResponse["data"]> {
  const res = await apiRequest<EventListResponse>(
    "GET",
    `/v1/sessions/${sessionId}/events?limit=${limit}`
  );
  return res.data ?? [];
}

// ─── Sessions ───────────────────────────────────────────────

export interface SessionResource {
  type: "github_repository";
  url: string;
  mount_path: string;
  authorization_token: string;
}

/**
 * Create a new agent session.
 * Returns immediately — the session runs asynchronously.
 * vault_ids attaches credential vaults (e.g. MCP OAuth tokens) to the session.
 * resources mounts external resources (e.g. github repos) into the sandbox
 * with auth baked into the local config — agent uses `git push` without ever
 * handling the token.
 */
export async function createSession(
  agentId: string,
  environmentId: string,
  title?: string,
  vaultIds?: string[],
  resources?: SessionResource[]
): Promise<SessionResponse> {
  return apiRequest<SessionResponse>(
    "POST",
    "/v1/sessions",
    {
      agent: agentId,
      environment_id: environmentId,
      ...(title && { title }),
      ...(vaultIds?.length && { vault_ids: vaultIds }),
      ...(resources?.length && { resources }),
    },
    CREATE_SESSION_TIMEOUT_MS
  );
}

/**
 * Send a user message to an active session.
 */
export async function sendEvent(
  sessionId: string,
  message: string
): Promise<void> {
  await apiRequest("POST", `/v1/sessions/${sessionId}/events`, {
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text: message }],
      },
    ],
  });
}

/**
 * Get the current status of a session.
 * Status values: "rescheduling" | "running" | "idle" | "terminated"
 */
export async function getSessionStatus(
  sessionId: string
): Promise<SessionResponse> {
  return apiRequest<SessionResponse>("GET", `/v1/sessions/${sessionId}`);
}

interface SessionListResponse {
  data: SessionResponse[];
}

/**
 * List recent sessions for an agent. Used by triggerAgent's orphan-recovery
 * path: when createSession aborts (Anthropic provisioning >50s), the session
 * is often created server-side after our fetch gave up. We look it up here
 * by title to reclaim it instead of creating yet another orphan on retry.
 */
export async function listAgentSessions(
  agentId: string,
  limit = 10
): Promise<SessionResponse[]> {
  const res = await apiRequest<SessionListResponse>(
    "GET",
    `/v1/sessions?agent_id=${encodeURIComponent(agentId)}&limit=${limit}`
  );
  return res.data ?? [];
}

// ─── Agents (used by setup script) ─────────────────────────

export interface CreateAgentInput {
  name: string;
  model: string;
  system?: string;
  description?: string;
  tools?: unknown[];
  mcp_servers?: { type: "url"; name: string; url: string }[];
}

export async function createAgent(
  input: CreateAgentInput
): Promise<AgentResponse> {
  return apiRequest<AgentResponse>("POST", "/v1/agents", input);
}

export async function updateAgent(
  agentId: string,
  input: Partial<CreateAgentInput>
): Promise<AgentResponse> {
  return apiRequest<AgentResponse>("PUT", `/v1/agents/${agentId}`, input);
}

// ─── Environments (used by setup script) ────────────────────

export interface CreateEnvironmentInput {
  name: string;
  config: {
    type: "cloud";
    networking: { type: "unrestricted" } | { type: "limited"; allowed_hosts: string[] };
    packages?: {
      pip?: string[];
      npm?: string[];
      apt?: string[];
    };
  };
}

export async function createEnvironment(
  input: CreateEnvironmentInput
): Promise<EnvironmentResponse> {
  return apiRequest<EnvironmentResponse>("POST", "/v1/environments", input);
}
