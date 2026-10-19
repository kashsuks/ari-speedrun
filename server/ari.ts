// Client for Ari's reviewer UI. Ari has no public reviewer API, so this reads the same
// SvelteKit `__data.json` payloads the review screen loads, authenticated with the
// reviewer's own session cookie.
//
// Reads never claim a ship: Ari only claims when the browser posts `?/claim`.
// The write functions at the bottom are ONLY called from the explicit decision
// endpoint, which requires the reviewer to press a button in the dashboard.
import { unflatten } from "devalue";
import { env } from "./env.ts";
import type { AriProgram, AriQueueRow, AriReview } from "./types.ts";

const BASE = "https://ari.hackclub.com";

export class AriAuthError extends Error {}

function headers(extra: Record<string, string> = {}) {
  return { cookie: env.ariCookie, "user-agent": "ari-speedrun", ...extra };
}

async function loadData(path: string): Promise<any[]> {
  const url = new URL(path, BASE);
  url.pathname = url.pathname.replace(/\/$/, "") + "/__data.json";
  const res = await fetch(url, { headers: headers(), redirect: "manual" });
  if (res.status >= 300 && res.status < 400) throw new AriAuthError("Ari session expired; refresh ARI_COOKIE");
  if (!res.ok) throw new Error(`Ari ${path}: HTTP ${res.status}`);

  // SvelteKit streams promise results as extra NDJSON lines after the first one.
  const [head, ...rest] = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (head.type === "redirect") throw new AriAuthError("Ari session expired; refresh ARI_COOKIE");
  if (head.type === "error") throw new Error(`Ari ${path}: ${JSON.stringify(head.error)}`);
  const chunks = new Map<number, unknown>();
  const revivers = { Promise: (id: number) => ({ __promise: id }) };
  for (const c of rest) chunks.set(c.id, c.error ? null : unflatten(c.data, revivers));
  const resolve = (v: any): any =>
    v && typeof v === "object"
      ? "__promise" in v
        ? resolve(chunks.get(v.__promise))
        : Array.isArray(v)
          ? v.map(resolve)
          : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]))
      : v;
  return head.nodes.map((n: any) => (n?.type === "data" ? resolve(unflatten(n.data, revivers)) : null));
}

const pageData = (nodes: any[]) => nodes[nodes.length - 1] ?? {};

export async function listPrograms(): Promise<AriProgram[]> {
  const data = pageData(await loadData("/programs"));
  return ((data.assigned ?? []) as any[]).map((p: any) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    iconUrl: p.iconUrl,
    pending: p.pending ?? 0,
    member: !!p.member,
  }));
}

export async function listQueue(programId: string): Promise<AriQueueRow[]> {
  const rows = new Map<string, AriQueueRow>();
  for (let page = 1; page < 100; page++) {
    const data = pageData(await loadData(`/p/${programId}/queue?page=${page}`));
    const before = rows.size;
    for (const r of data.rows ?? []) rows.set(r.id, r);
    if (rows.size === before || rows.size >= (data.total ?? 0)) break;
  }
  return [...rows.values()];
}

export async function getReview(programId: string, shipId: string): Promise<AriReview> {
  return pageData(await loadData(`/p/${programId}/review/${shipId}`)) as AriReview;
}

/** Ari's rendered README for the ship's repo, as HTML. */
export async function getReadmeHtml(programId: string, shipId: string): Promise<string | null> {
  const res = await fetch(`${BASE}/p/${programId}/review/${shipId}/readme`, { headers: headers() });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { ok?: boolean; html?: string } | null;
  return body?.ok ? (body.html ?? "") : null;
}

// ---------------------------------------------------------------------------
// Writes. Only reachable through POST /api/ships/:id/decision.
// ---------------------------------------------------------------------------

type ActionResult = { ok: boolean; status: number; data?: any; message?: string };

async function postAction(programId: string, shipId: string, action: string, fields: Record<string, string> = {}): Promise<ActionResult> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await fetch(`${BASE}/p/${programId}/review/${shipId}?/${action}`, {
    method: "POST",
    headers: headers({ accept: "application/json", "x-sveltekit-action": "true", origin: BASE, referer: `${BASE}/p/${programId}/review/${shipId}` }),
    body: form,
    redirect: "manual",
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: res.status, message: text.slice(0, 300) || `HTTP ${res.status}` };
  }
  // SvelteKit action responses carry devalue-encoded `data` as a string.
  const data = typeof parsed.data === "string" ? unflatten(JSON.parse(parsed.data)) : parsed.data;
  if (parsed.type === "success") return { ok: true, status: res.status, data };
  if (parsed.type === "redirect") return { ok: false, status: res.status, message: `Redirected to ${parsed.location} (session expired?)` };
  return { ok: false, status: parsed.status ?? res.status, data, message: data?.message ?? data?.error ?? parsed.error?.message ?? `Ari refused the ${action}` };
}

export type Decision = "approve" | "changes" | "reject";

export interface DecisionInput {
  decision: Decision;
  note: string;
  audit: string;
  technicalFeatures: string;
  checks: boolean[];
  fieldValues: Record<string, unknown>;
  fixChecks: string[];
  deflateSeconds: number | null;
  deflationReason: string;
}

export async function submitDecision(programId: string, shipId: string, ingestVersion: number, input: DecisionInput): Promise<ActionResult> {
  const claim = await postAction(programId, shipId, "claim");
  if (!claim.ok) return { ...claim, message: `Could not claim ship: ${claim.message ?? claim.data?.by ?? "locked"}` };

  const result = await postAction(programId, shipId, input.decision, {
    ingestVersion: String(ingestVersion),
    deflateSeconds: input.deflateSeconds ? String(input.deflateSeconds) : "",
    note: input.note,
    audit: input.audit,
    technicalFeatures: input.technicalFeatures,
    deflationReason: input.deflationReason,
    adjustments: "{}",
    collaboratorDeflates: "{}",
    collaboratorNotes: "{}",
    fieldValues: JSON.stringify(input.fieldValues),
    checks: JSON.stringify(input.checks),
    fixChecks: JSON.stringify(input.fixChecks),
  });
  if (!result.ok) await postAction(programId, shipId, "release");
  return result;
}
