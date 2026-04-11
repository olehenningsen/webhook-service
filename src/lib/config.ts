import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  LINEAR_WEBHOOK_SECRET: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  API_KEY: z.string().min(1),
  VERCEL_URL: z.string().optional(),
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
