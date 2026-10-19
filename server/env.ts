import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

const PROVIDERS = ["api", "claude-code", "codex"] as const;
export type AiProvider = (typeof PROVIDERS)[number];
const DEFAULT_MODEL: Record<Exclude<AiProvider, "api">, string> = { "claude-code": "haiku", codex: "gpt-5.6-luna" };

const rawProvider = process.env.AI_PROVIDER || (process.env.ANTHROPIC_API_KEY ? "api" : "claude-code");
if (!PROVIDERS.includes(rawProvider as AiProvider)) throw new Error(`AI_PROVIDER must be one of ${PROVIDERS.join(", ")}`);
const aiProvider = rawProvider as AiProvider;

export const env = {
  ariCookie: process.env.ARI_COOKIE ?? "",
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
  githubToken: process.env.GITHUB_TOKEN ?? "",
  appPassword: process.env.APP_PASSWORD ?? "",
  port: Number(process.env.PORT ?? 8787),
  dataDir: process.env.DATA_DIR ?? "data",
  aiProvider,
  // Cheapest capable model per CLI by default; subscription limits are the constraint there.
  model: process.env.AI_MODEL || (aiProvider === "api" ? process.env.CLAUDE_MODEL || "claude-opus-5-5" : DEFAULT_MODEL[aiProvider]),
  concurrency: Number(process.env.ANALYSIS_CONCURRENCY ?? 3),
};
