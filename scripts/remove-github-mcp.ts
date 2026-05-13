/**
 * Remove the GitHub MCP server from all managed agents.
 *
 * After this runs, agents only have Linear MCP. All git/GitHub work
 * happens via the mounted github_repository resource (git CLI in
 * /workspace/<repo>) and via webhook-service handling PR/merge.
 *
 * Usage:
 *   source .env.production && npx tsx scripts/remove-github-mcp.ts
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
  mcp_servers: Array<{ type: string; name: string; url: string }>;
  tools: unknown[];
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
  console.log("Removing GitHub MCP from all agents...\n");

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

      const newMcpServers = agent.mcp_servers.filter((s) => s.name !== "github");
      const removedGithub = newMcpServers.length < agent.mcp_servers.length;

      // Also strip github mcp_toolset from tools array
      const newTools = (agent.tools as Array<Record<string, unknown>>).filter(
        (t) => !(t.type === "mcp_toolset" && t.mcp_server_name === "github")
      );

      if (!removedGithub && newTools.length === agent.tools.length) {
        console.log(`  ⏭  ${name}: no github MCP found — skipping`);
        continue;
      }

      const result = await apiRequest<AgentResponse>("POST", `/v1/agents/${agentId}`, {
        version: agent.version,
        mcp_servers: newMcpServers,
        tools: newTools,
      });

      console.log(
        `  ✓  ${name}: v${agent.version} → v${result.version} — github MCP removed`
      );
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
