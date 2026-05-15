/**
 * Update managed agent system prompts with latest SKILL.md files.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx scripts/update-agent-prompts.ts
 *
 * Reads SKILL.md + templates, builds system prompts, and POSTs versioned
 * updates to each agent. Requires AGENT_ID_* env vars.
 */

import * as fs from "fs";
import * as path from "path";

const BASE_URL = "https://api.anthropic.com";
const BETA_HEADER = "managed-agents-2026-04-01";
const API_VERSION = "2023-06-01";

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("Error: ANTHROPIC_API_KEY environment variable is required");
  process.exit(1);
}

// ─── API helpers ──────────────────────────────────────────

async function apiRequest<T>(
  method: string,
  reqPath: string,
  body?: unknown
): Promise<T> {
  const url = `${BASE_URL}${reqPath}`;
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
    throw new Error(`API error (${response.status} ${method} ${reqPath}): ${errorBody}`);
  }
  return response.json() as Promise<T>;
}

interface AgentGetResponse {
  id: string;
  version: number;
  system: string;
  [key: string]: unknown;
}

async function getAgent(agentId: string): Promise<AgentGetResponse> {
  return apiRequest<AgentGetResponse>("GET", `/v1/agents/${agentId}`);
}

async function updateAgentSystem(agentId: string, version: number, system: string): Promise<AgentGetResponse> {
  return apiRequest<AgentGetResponse>("POST", `/v1/agents/${agentId}`, {
    version,
    system,
  });
}

// ─── Read SKILL.md files ──────────────────────────────────
// Paths are configurable via env vars (AGENTS_DIR, TEMPLATES_DIR) so the
// script works from any checkout layout. Default is the conventional
// sibling-directory layout: webhook-service and "Claude Dev TeamAgentic"
// share a parent folder.

const AGENTS_DIR =
  process.env.AGENTS_DIR ??
  path.resolve(__dirname, "../../Claude Dev TeamAgentic/agents");
const TEMPLATES_DIR =
  process.env.TEMPLATES_DIR ??
  path.resolve(__dirname, "../../Claude Dev TeamAgentic/templates");

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

function readFileOrEmpty(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function buildSystemPrompt(skillContent: string, templateContent?: string): string {
  let prompt = skillContent;
  if (templateContent) {
    prompt += `\n\n---\n\n# Template Reference\n\n${templateContent}`;
  }
  return prompt;
}

// ─── Agent mapping ────────────────────────────────────────

interface AgentUpdate {
  name: string;
  envVar: string;
  skillPath: string;
  templatePath?: string;
}

const agents: AgentUpdate[] = [
  { name: "saga", envVar: "AGENT_ID_SAGA", skillPath: "saga/SKILL.md", templatePath: "prd-template.md" },
  { name: "atlas", envVar: "AGENT_ID_ATLAS", skillPath: "atlas/SKILL.md", templatePath: "trd-template.md" },
  { name: "pixel", envVar: "AGENT_ID_PIXEL", skillPath: "frontend/SKILL.md", templatePath: "commit-pr-template.md" },
  { name: "sprite", envVar: "AGENT_ID_SPRITE", skillPath: "frontend/SKILL.md", templatePath: "commit-pr-template.md" },
  { name: "byte", envVar: "AGENT_ID_BYTE", skillPath: "backend/SKILL.md", templatePath: "commit-pr-template.md" },
  { name: "loop", envVar: "AGENT_ID_LOOP", skillPath: "backend/SKILL.md", templatePath: "commit-pr-template.md" },
  { name: "scout", envVar: "AGENT_ID_SCOUT", skillPath: "scout/SKILL.md", templatePath: "test-rapport-template.md" },
];

// ─── Main ─────────────────────────────────────────────────

async function main() {
  console.log("Updating managed agent system prompts...\n");

  let updated = 0;
  let skipped = 0;

  for (const agent of agents) {
    const agentId = process.env[agent.envVar];
    if (!agentId) {
      console.log(`  ⏭  ${agent.name}: ${agent.envVar} not set — skipping`);
      skipped++;
      continue;
    }

    const skill = readFile(path.join(AGENTS_DIR, agent.skillPath));
    const template = agent.templatePath
      ? readFileOrEmpty(path.join(TEMPLATES_DIR, agent.templatePath))
      : undefined;
    const systemPrompt = buildSystemPrompt(skill, template);

    try {
      // GET current version first
      const current = await getAgent(agentId);
      console.log(`  📖 ${agent.name}: current version ${current.version}, system ${current.system.length} chars`);

      // POST versioned update
      const result = await updateAgentSystem(agentId, current.version, systemPrompt);
      console.log(`  ✓  ${agent.name}: updated to version ${result.version} (${systemPrompt.length} chars)`);
      updated++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`  ✗  ${agent.name}: ${msg}`);
    }
  }

  console.log(`\nDone: ${updated} updated, ${skipped} skipped`);
}

main().catch((error) => {
  console.error("Failed:", error.message);
  process.exit(1);
});
