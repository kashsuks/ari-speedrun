import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

export const env = {
  ariCookie: process.env.ARI_COOKIE ?? "",
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
  githubToken: process.env.GITHUB_TOKEN ?? "",
  appPassword: process.env.APP_PASSWORD ?? "",
  port: Number(process.env.PORT ?? 8787),
  dataDir: process.env.DATA_DIR ?? "data",
  model: process.env.CLAUDE_MODEL ?? "claude-opus-5-5",
  concurrency: Number(process.env.ANALYSIS_CONCURRENCY ?? 3),
};
