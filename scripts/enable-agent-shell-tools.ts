/**
 * Enable all agent tools (including shell/bash) on developer agents.
 * This allows agents to use git CLI with a PAT for private repo access.
 *
 * Usage:
 *   source .env.production && npx tsx scripts/enable-agent-shell-tools.ts
 */

const BASE_URL = "https://api.anthropic.com";
const BETA_HEADER = "managed-agents-2026-04-01";
const API_VERSION = "2023-06-01";

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("Error: ANTHROPIC_API_KEY is required");
  process.exit(1);
}

async function apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "x-api-key": API_KEY!,
      "anthropic-version": API_VERSION,
      "anthropic-beta": BETA_HEADER,
      "content-type": "application/json",
    },
    ...(body && { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`API error (${response.status}): ${errorBody}`);
  }
  return response.json() as Promise<T>;
}

interface AgentResponse {
  id: string;
  version: number;
  tools: unknown[];
  mcp_servers: Array<{ type: string; name: string; url: string }>;
  [key: string]: unknown;
}

const AGENT_ENV_VARS = [
  "AGENT_ID_SAGA",
  "AGENT_ID_ATLAS",
  "AGENT_ID_PIXEL",
  "AGENT_ID_SPRITE",
  "AGENT_ID_BYTE",
  "AGENT_ID_LOOP",
  "AGENT_ID_SCOUT",
];

async function main() {
  console.log("Enabling all agent tools (incl. shell) on all agents...\n");

  let updated = 0;

  for (const envVar of AGENT_ENV_VARS) {
    const agentId = process.env[envVar];
    const name = envVar.replace("AGENT_ID_", "").toLowerCase();

    if (!agentId) {
      console.log(`  ⏭  ${name}: ${envVar} not set — skipping`);
      continue;
    }

    try {
      const agent = await apiRequest<AgentResponse>("GET", `/v1/agents/${agentId}`);

      // Build new tools config: enable all agent tools + keep MCP toolsets
      const mcpToolsets = agent.mcp_servers.map((server) => ({
        type: "mcp_toolset",
        mcp_server_name: server.name,
        default_config: {
          enabled: true,
          permission_policy: { type: "always_allow" },
        },
        configs: [],
      }));

      const newTools = [
        {
          type: "agent_toolset_20260401",
          default_config: {
            enabled: true,
            permission_policy: { type: "always_allow" },
          },
        },
        ...mcpToolsets,
      ];

      const result = await apiRequest<AgentResponse>("POST", `/v1/agents/${agentId}`, {
        version: agent.version,
        tools: newTools,
      });

      console.log(`  ✓  ${name}: v${agent.version} → v${result.version} — all tools enabled`);
      updated++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`  ✗  ${name}: ${msg}`);
    }
  }

  console.log(`\nDone: ${updated} agents updated`);
}

main().catch((error) => {
  console.error("Failed:", error.message);
  process.exit(1);
});
