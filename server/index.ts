import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { z } from "zod";
import { analyzeShip, getRun, listAnalyses, loadAnalysis, saveAnalysis, startRun } from "./analyze.ts";
import { aiReady } from "./claude.ts";
import { AriAuthError, getReview, listPrograms, listQueue, submitDecision } from "./ari.ts";
import { env } from "./env.ts";
import type { Analysis } from "./types.ts";

const app = new Hono();

// Password gate. The server holds the reviewer's Ari session, so never expose it unprotected.
app.use("*", async (c, next) => {
  if (!env.appPassword) return next();
  const header = c.req.header("authorization") ?? "";
  const given = header.startsWith("Basic ") ? Buffer.from(header.slice(6), "base64").toString().split(":").slice(1).join(":") : "";
  const a = Buffer.from(given);
  const b = Buffer.from(env.appPassword);
  if (a.length === b.length && timingSafeEqual(a, b)) return next();
  return c.text("Unauthorized", 401, { "WWW-Authenticate": 'Basic realm="ari-speedrun"' });
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message, auth: err instanceof AriAuthError }, err instanceof AriAuthError ? 401 : 500);
});

let programNames = new Map<string, string>();

app.get("/api/config", (c) =>
  c.json({ hasCookie: !!env.ariCookie, aiProvider: env.aiProvider, aiReady: aiReady(), hasGithub: !!env.githubToken, model: env.model }),
);

app.get("/api/programs", async (c) => {
  const programs = await listPrograms();
  programNames = new Map(programs.map((p) => [p.id, p.name]));
  return c.json(programs);
});

const programName = (id: string) => programNames.get(id) ?? id;

function summarize(a: Analysis) {
  return {
    shipId: a.shipId,
    title: a.queue.title,
    author: a.queue.author,
    thumb: a.queue.thumb,
    track: a.queue.track,
    ago: a.queue.ago,
    evidenceSeconds: a.queue.evidenceSeconds,
    isUpdate: a.queue.isUpdate,
    priority: a.queue.priority,
    claim: a.queue.claim,
    checks: Object.fromEntries(Object.entries(a.checks).map(([k, v]) => [k, { level: v.level, summary: v.summary }])),
    recommendation: a.ai?.recommendation ?? null,
    confidence: a.ai?.confidence ?? null,
    summary: a.ai?.summary ?? null,
    returnReason: a.ai?.returnReason ?? null,
    stack: a.ai?.stack ?? null,
    aiError: a.aiError,
    analyzedAt: a.analyzedAt,
    decided: a.decided ?? null,
  };
}

app.post("/api/programs/:id/analyze", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const run = await startRun(c.req.param("id"), programName(c.req.param("id")), { force: !!body.force });
  return c.json(run);
});

app.get("/api/programs/:id/ships", async (c) => {
  const id = c.req.param("id");
  const run = getRun(id);
  const inQueue = run ? new Set(run.queueIds) : new Set((await listQueue(id)).map((r) => r.id));
  const ships = listAnalyses(id)
    .filter((a) => inQueue.has(a.shipId) || a.decided)
    .map(summarize);
  return c.json({ run, ships, queueSize: inQueue.size });
});

app.get("/api/programs/:id/ships/:shipId", (c) => {
  const a = loadAnalysis(c.req.param("id"), c.req.param("shipId"));
  if (!a) return c.json({ error: "not analyzed yet" }, 404);
  // The hourly heatmap is large and unused by the UI.
  const { privatePanels: _drop, ...review } = a.review;
  return c.json({ ...a, review });
});

app.post("/api/programs/:id/ships/:shipId/reanalyze", async (c) => {
  const { id, shipId } = c.req.param();
  const row = (await listQueue(id)).find((r) => r.id === shipId);
  if (!row) return c.json({ error: "ship is no longer in the queue" }, 404);
  const a = await analyzeShip(id, programName(id), row, { force: true });
  return c.json(summarize(a));
});

// ---------------------------------------------------------------------------
// The ONLY route that changes anything in Ari. It runs solely when the reviewer
// presses a decision button and confirms the dialog in the dashboard; the UI
// sends the ship id in X-Confirm-Decision and `confirmed: true` in the body.
// ---------------------------------------------------------------------------

const DecisionBody = z.object({
  confirmed: z.literal(true),
  decision: z.enum(["approve", "changes", "reject"]),
  note: z.string().trim().min(1, "Note to maker is required"),
  audit: z.string().trim().min(1, "Audit note is required"),
  technicalFeatures: z.string().default(""),
  checks: z.array(z.boolean()).default([]),
  fieldValues: z.record(z.string(), z.unknown()).default({}),
  fixChecks: z.array(z.string()).default([]),
  deflateSeconds: z.number().int().positive().nullable().default(null),
  deflationReason: z.string().default(""),
});

app.post("/api/programs/:id/ships/:shipId/decision", async (c) => {
  const { id, shipId } = c.req.param();
  if (c.req.header("x-confirm-decision") !== shipId) return c.json({ error: "Decision not confirmed" }, 400);
  const parsed = DecisionBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
  const body = parsed.data;
  if (body.decision === "approve" && body.audit.trim().length < 100) return c.json({ error: "Ari requires an audit note of at least 100 characters for approvals" }, 400);

  // Re-read the ship so we send the current ingest version and never act on a stale or closed ship.
  const review = await getReview(id, shipId);
  if (review.ship.status !== "pending" || review.state.decided) return c.json({ error: `Ship is ${review.ship.status}, not pending` }, 409);
  if (review.lock.readOnly) return c.json({ error: `${review.lock.byName ?? "Another reviewer"} is reviewing this ship` }, 409);

  const result = await submitDecision(id, shipId, review.ship.ingestVersion, body);
  if (!result.ok) return c.json({ error: result.message, problems: result.data?.problems ?? null }, 422);

  const a = loadAnalysis(id, shipId);
  if (a) saveAnalysis({ ...a, decided: { decision: body.decision, at: new Date().toISOString(), result: result.data } });
  return c.json({ ok: true, result: result.data });
});

// Built frontend
if (existsSync("web/dist")) {
  app.use("/*", serveStatic({ root: "web/dist" }));
  app.get("*", serveStatic({ path: "web/dist/index.html" }));
}

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`ari-speedrun listening on http://localhost:${info.port}`);
  if (!env.ariCookie) console.warn("ARI_COOKIE is not set");
  if (!aiReady()) console.warn("ANTHROPIC_API_KEY is not set: AI checks and notes will be skipped");
  else console.log(`AI: ${env.aiProvider} (${env.model})`);
  if (!env.appPassword) console.warn("APP_PASSWORD is not set: do not expose this server publicly");
});
