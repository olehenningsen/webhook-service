import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  LINEAR_WEBHOOK_SECRET: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  API_KEY: z.string().min(1),
  VERCEL_URL: z.string().optional(),
  CRON_SECRET: z.string().optional(),

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

  return { agentId, environmentId };
}
