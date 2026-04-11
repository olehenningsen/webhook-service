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

async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const options: RequestInit = {
    method,
    headers: getHeaders(),
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

// ─── Sessions ───────────────────────────────────────────────

/**
 * Create a new agent session.
 * Returns immediately — the session runs asynchronously.
 */
export async function createSession(
  agentId: string,
  environmentId: string,
  title?: string
): Promise<SessionResponse> {
  return apiRequest<SessionResponse>("POST", "/v1/sessions", {
    agent: agentId,
    environment_id: environmentId,
    ...(title && { title }),
  });
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
