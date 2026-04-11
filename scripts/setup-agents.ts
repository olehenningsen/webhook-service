/**
 * Setup script for creating managed agents and environments on the Anthropic platform.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx scripts/setup-agents.ts
 *
 * This script:
 * 1. Creates 2 environments (planning + development)
 * 2. Creates 7 agents with system prompts from SKILL.md files
 * 3. Outputs all IDs ready for Vercel env vars
 *
 * MCP server URLs can be configured via environment variables:
 *   LINEAR_MCP_URL  — URL for the Linear MCP server
 *   GITHUB_MCP_URL  — URL for the GitHub MCP server
 */

import * as fs from "fs";
import * as path from "path";

const BASE_URL = "https://api.anthropic.com";
const BETA_HEADER = "managed-agents-2026-04-01";
const API_VERSION = "2023-06-01";
const MODEL = "claude-sonnet-4-6";

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("Error: ANTHROPIC_API_KEY environment variable is required");
  process.exit(1);
}

const LINEAR_MCP_URL = process.env.LINEAR_MCP_URL;
const GITHUB_MCP_URL = process.env.GITHUB_MCP_URL;

// ─── API helpers ──────────────────────────────────────────

async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "x-api-key": API_KEY!,
    "anthropic-version": API_VERSION,
    "anthropic-beta": BETA_HEADER,
    "content-type": "application/json",
  };

  const options: RequestInit = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(url, options);
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`API error (${response.status} ${method} ${path}): ${errorBody}`);
  }
  return response.json() as Promise<T>;
}

// ─── Read SKILL.md files ──────────────────────────────────

const AGENTS_DIR = path.resolve(__dirname, "../../Claude Dev TeamAgentic/agents");
const TEMPLATES_DIR = path.resolve(__dirname, "../../Claude Dev TeamAgentic/templates");

function readFileOrFallback(filePath: string, fallback: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    console.warn(`Warning: Could not read ${filePath}, using fallback`);
    return fallback;
  }
}

const skills = {
  saga: readFileOrFallback(path.join(AGENTS_DIR, "saga/SKILL.md"), "Du er Saga, product manager i TeamAgentic."),
  atlas: readFileOrFallback(path.join(AGENTS_DIR, "atlas/SKILL.md"), "Du er Atlas, tech lead i TeamAgentic."),
  frontend: readFileOrFallback(path.join(AGENTS_DIR, "frontend/SKILL.md"), "Du er en frontend developer i TeamAgentic."),
  backend: readFileOrFallback(path.join(AGENTS_DIR, "backend/SKILL.md"), "Du er en backend developer i TeamAgentic."),
  scout: readFileOrFallback(path.join(AGENTS_DIR, "scout/SKILL.md"), "Du er Scout, tester i TeamAgentic."),
};

const templates = {
  prd: readFileOrFallback(path.join(TEMPLATES_DIR, "prd-template.md"), ""),
  trd: readFileOrFallback(path.join(TEMPLATES_DIR, "trd-template.md"), ""),
  commitPr: readFileOrFallback(path.join(TEMPLATES_DIR, "commit-pr-template.md"), ""),
  testRapport: readFileOrFallback(path.join(TEMPLATES_DIR, "test-rapport-template.md"), ""),
};

// ─── Build system prompts ─────────────────────────────────

function buildSystemPrompt(skillContent: string, templateContent?: string): string {
  let prompt = skillContent;
  if (templateContent) {
    prompt += `\n\n---\n\n# Template Reference\n\n${templateContent}`;
  }
  return prompt;
}

// ─── Agent definitions ────────────────────────────────────

interface AgentDef {
  name: string;
  description: string;
  systemPrompt: string;
  environment: "planning" | "development";
  needsGithub: boolean;
}

const agentDefs: AgentDef[] = [
  {
    name: "saga",
    description: "Saga — Product Manager. Sparrer med Ole, skriver PRD'er.",
    systemPrompt: buildSystemPrompt(skills.saga, templates.prd),
    environment: "planning",
    needsGithub: false,
  },
  {
    name: "atlas",
    description: "Atlas — Tech Lead. Skriver TRD'er, nedbryder i dev-tasks.",
    systemPrompt: buildSystemPrompt(skills.atlas, templates.trd),
    environment: "planning",
    needsGithub: false,
  },
  {
    name: "pixel",
    description: "Pixel — Frontend Developer. Implementerer React-komponenter.",
    systemPrompt: buildSystemPrompt(skills.frontend, templates.commitPr),
    environment: "development",
    needsGithub: true,
  },
  {
    name: "sprite",
    description: "Sprite — Frontend Developer. Implementerer React-komponenter.",
    systemPrompt: buildSystemPrompt(skills.frontend, templates.commitPr),
    environment: "development",
    needsGithub: true,
  },
  {
    name: "byte",
    description: "Byte — Backend Developer. Implementerer API-routes og database-logik.",
    systemPrompt: buildSystemPrompt(skills.backend, templates.commitPr),
    environment: "development",
    needsGithub: true,
  },
  {
    name: "loop",
    description: "Loop — Backend Developer. Implementerer API-routes og database-logik.",
    systemPrompt: buildSystemPrompt(skills.backend, templates.commitPr),
    environment: "development",
    needsGithub: true,
  },
  {
    name: "scout",
    description: "Scout — Tester. Designer testplaner, kører tests, rapporterer bugs.",
    systemPrompt: buildSystemPrompt(skills.scout, templates.testRapport),
    environment: "development",
    needsGithub: true,
  },
];

// ─── Main ─────────────────────────────────────────────────

async function main() {
  console.log("🚀 Setting up TeamAgentic managed agents...\n");

  // Step 1: Create environments
  console.log("━━━ Creating environments ━━━\n");

  const planningEnv = await apiRequest<{ id: string; name: string }>(
    "POST",
    "/v1/environments",
    {
      name: "teamagentic-planning",
      config: {
        type: "cloud",
        networking: { type: "unrestricted" },
      },
    }
  );
  console.log(`✓ Planning environment: ${planningEnv.id}`);

  const developmentEnv = await apiRequest<{ id: string; name: string }>(
    "POST",
    "/v1/environments",
    {
      name: "teamagentic-development",
      config: {
        type: "cloud",
        networking: { type: "unrestricted" },
        packages: {
          npm: ["typescript", "vitest", "@playwright/test"],
          apt: ["git"],
        },
      },
    }
  );
  console.log(`✓ Development environment: ${developmentEnv.id}\n`);

  // Step 2: Create agents
  console.log("━━━ Creating agents ━━━\n");

  const agentIds: Record<string, string> = {};

  for (const def of agentDefs) {
    const envId =
      def.environment === "planning" ? planningEnv.id : developmentEnv.id;

    // Build tools array
    const tools: unknown[] = [];

    if (def.environment === "development") {
      // Full toolset for dev agents
      tools.push({ type: "agent_toolset_20260401" });
    } else {
      // Planning agents: only web fetch/search, no bash/file tools
      tools.push({
        type: "agent_toolset_20260401",
        default_config: { enabled: false },
        configs: [
          { name: "web_fetch", enabled: true },
          { name: "web_search", enabled: true },
        ],
      });
    }

    // Add MCP server toolsets
    const mcpServers: { type: "url"; name: string; url: string }[] = [];

    if (LINEAR_MCP_URL) {
      mcpServers.push({ type: "url", name: "linear", url: LINEAR_MCP_URL });
      tools.push({ type: "mcp_toolset", mcp_server_name: "linear" });
    }

    if (def.needsGithub && GITHUB_MCP_URL) {
      mcpServers.push({ type: "url", name: "github", url: GITHUB_MCP_URL });
      tools.push({ type: "mcp_toolset", mcp_server_name: "github" });
    }

    const agent = await apiRequest<{ id: string; name: string }>(
      "POST",
      "/v1/agents",
      {
        name: `teamagentic-${def.name}`,
        model: MODEL,
        system: def.systemPrompt,
        description: def.description,
        tools,
        mcp_servers: mcpServers,
      }
    );

    agentIds[def.name] = agent.id;
    console.log(`✓ ${def.name}: ${agent.id}`);
  }

  // Step 3: Output env vars
  console.log("\n━━━ Environment variables for Vercel ━━━\n");
  console.log(`ENV_ID_PLANNING=${planningEnv.id}`);
  console.log(`ENV_ID_DEVELOPMENT=${developmentEnv.id}`);
  console.log(`AGENT_ID_SAGA=${agentIds.saga}`);
  console.log(`AGENT_ID_ATLAS=${agentIds.atlas}`);
  console.log(`AGENT_ID_PIXEL=${agentIds.pixel}`);
  console.log(`AGENT_ID_SPRITE=${agentIds.sprite}`);
  console.log(`AGENT_ID_BYTE=${agentIds.byte}`);
  console.log(`AGENT_ID_LOOP=${agentIds.loop}`);
  console.log(`AGENT_ID_SCOUT=${agentIds.scout}`);

  console.log("\n✅ Setup complete! Copy the env vars above to Vercel.\n");

  if (!LINEAR_MCP_URL) {
    console.log(
      "⚠️  LINEAR_MCP_URL was not set. Agents were created without Linear MCP.\n" +
      "   Set the env var and re-run, or update agents on platform.claude.com.\n"
    );
  }
  if (!GITHUB_MCP_URL) {
    console.log(
      "⚠️  GITHUB_MCP_URL was not set. Dev agents were created without GitHub MCP.\n" +
      "   Set the env var and re-run, or update agents on platform.claude.com.\n"
    );
  }
}

main().catch((error) => {
  console.error("❌ Setup failed:", error.message);
  process.exit(1);
});
