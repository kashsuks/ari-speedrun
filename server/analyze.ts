import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getReadmeHtml, getReview, listQueue } from "./ari.ts";
import { commitCheck, commitStats, demoCheck, doubleDipCheck, fraudCheck, hackatimeCheck } from "./checks.ts";
import { buildPrompt, judge } from "./claude.ts";
import { probeDemo } from "./demo.ts";
import { env } from "./env.ts";
import { fetchGithub, languagesFromFiles } from "./github.ts";
import type { AiVerdict, Analysis, AriQueueRow, Check, Level } from "./types.ts";

// ---------------------------------------------------------------------------
// Cache: one JSON file per ship, keyed on Ari's ingest + evidence snapshot versions.
// ---------------------------------------------------------------------------

const dir = (programId: string) => join(env.dataDir, "analyses", programId);
const file = (programId: string, shipId: string) => join(dir(programId), `${shipId}.json`);

export function loadAnalysis(programId: string, shipId: string): Analysis | null {
  const f = file(programId, shipId);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Analysis) : null;
}

export function saveAnalysis(a: Analysis) {
  mkdirSync(dir(a.programId), { recursive: true });
  writeFileSync(file(a.programId, a.shipId), JSON.stringify(a));
}

export function listAnalyses(programId: string): Analysis[] {
  if (!existsSync(dir(programId))) return [];
  return readdirSync(dir(programId))
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir(programId), f), "utf8")) as Analysis);
}

// ---------------------------------------------------------------------------
// Analysis of one ship
// ---------------------------------------------------------------------------

function htmlToText(html: string) {
  return html
    .replace(/<(h[1-6])[^>]*>/gi, "\n# ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(br|p|div|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const worse = (a: Level, b: Level): Level => {
  const rank: Record<Level, number> = { unknown: 0, pass: 1, warn: 2, fail: 3 };
  return rank[a] >= rank[b] ? a : b;
};

/** Fold Claude's judgement into the deterministic checks. */
function mergeAi(checks: Analysis["checks"], ai: AiVerdict) {
  checks.readme = {
    level: ai.readme.aiGenerated === "likely" ? "fail" : ai.readme.aiGenerated === "possibly" ? "warn" : "pass",
    summary: ai.readme.aiGenerated === "likely" ? "README looks AI-generated" : ai.readme.aiGenerated === "possibly" ? "README may be AI-assisted" : "README reads as human-written",
    details: [ai.readme.reasoning, ...(checks.readme.details ?? [])],
  };
  const demo = checks.demo;
  if (!ai.demo.usable && demo.level === "pass") demo.level = "warn";
  if (ai.demo.usable && demo.level === "fail" && demo.summary !== "Demo link is broken") demo.level = "warn";
  demo.details = [`Claude: ${ai.demo.reasoning}`, ...(demo.details ?? [])];
  if (!ai.hackatimeRelated.related) checks.hackatime.level = worse(checks.hackatime.level, "warn");
  checks.hackatime.details = [`Claude: ${ai.hackatimeRelated.reasoning}`, ...(checks.hackatime.details ?? [])];
  if (!ai.commits.healthy) checks.commits.level = worse(checks.commits.level, "warn");
  checks.commits.details = [`Claude: ${ai.commits.reasoning}`, ...(checks.commits.details ?? [])];
}

export async function analyzeShip(programId: string, programName: string, row: AriQueueRow, opts: { force?: boolean } = {}): Promise<Analysis> {
  const review = await getReview(programId, row.id);
  const cached = loadAnalysis(programId, row.id);
  if (
    !opts.force && cached && cached.ai &&
    cached.ingestVersion === review.ship.ingestVersion &&
    cached.snapshotVersion === review.snapshot?.version
  ) {
    // Evidence unchanged: keep the AI verdict but refresh live Ari state (claims, flags).
    const fresh = { ...cached, queue: row, review, checks: { ...cached.checks, fraud: fraudCheck(review), doubleDip: doubleDipCheck(review) } };
    saveAnalysis(fresh);
    return fresh;
  }

  const [github, demo, ariReadme] = await Promise.all([
    fetchGithub(review.ship.repoUrl),
    probeDemo(review.ship.demoUrl, review.ship.repoUrl),
    getReadmeHtml(programId, row.id),
  ]);
  const readme = github?.readmeMarkdown ?? (ariReadme ? htmlToText(ariReadme) : null);
  const languages = github && Object.keys(github.languages).length ? github.languages : languagesFromFiles(review.fileHours);
  const stats = commitStats(review);
  const readmeCheck: Check = readme
    ? { level: "unknown", summary: "Awaiting AI read", details: [`${readme.length} characters`] }
    : { level: "fail", summary: "No README found" };
  const checks: Analysis["checks"] = {
    readme: readmeCheck,
    demo: demoCheck(review, demo),
    doubleDip: doubleDipCheck(review),
    fraud: fraudCheck(review),
    commits: commitCheck(review, stats),
    hackatime: hackatimeCheck(review),
  };

  let ai: AiVerdict | null = null;
  let aiError: string | null = null;
  try {
    ai = await judge(buildPrompt({ programName, review, readme, github, demo, stats, checks, languages }));
    mergeAi(checks, ai);
  } catch (e) {
    aiError = (e as Error).message;
  }

  const analysis: Analysis = {
    shipId: row.id,
    programId,
    ingestVersion: review.ship.ingestVersion,
    snapshotVersion: review.snapshot?.version ?? 0,
    analyzedAt: new Date().toISOString(),
    queue: row,
    review,
    github: github ? { ...github, languages } : null,
    demo,
    checks,
    commitStats: stats,
    ai,
    aiError,
  };
  saveAnalysis(analysis);
  return analysis;
}

// ---------------------------------------------------------------------------
// Program-wide runs
// ---------------------------------------------------------------------------

export interface RunState {
  programId: string;
  startedAt: string;
  finishedAt: string | null;
  total: number;
  done: number;
  active: string[];
  errors: Record<string, string>;
  queueIds: string[];
}

const runs = new Map<string, RunState>();
export const getRun = (programId: string) => runs.get(programId) ?? null;

export async function startRun(programId: string, programName: string, opts: { force?: boolean } = {}): Promise<RunState> {
  const existing = runs.get(programId);
  if (existing && !existing.finishedAt) return existing;

  const queue = await listQueue(programId);
  const state: RunState = {
    programId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    total: queue.length,
    done: 0,
    active: [],
    errors: {},
    queueIds: queue.map((r) => r.id),
  };
  runs.set(programId, state);

  const pending = [...queue];
  const worker = async () => {
    for (let row = pending.shift(); row; row = pending.shift()) {
      state.active.push(row.id);
      try {
        await analyzeShip(programId, programName, row, opts);
      } catch (e) {
        state.errors[row.id] = (e as Error).message;
      } finally {
        state.active = state.active.filter((id) => id !== row!.id);
        state.done++;
      }
    }
  };
  void Promise.all(Array.from({ length: Math.max(1, env.concurrency) }, worker)).then(() => {
    state.finishedAt = new Date().toISOString();
  });
  return state;
}
