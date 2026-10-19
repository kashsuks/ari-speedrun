import type { Analysis, AriProgram, Level } from "../../server/types.ts";
import type { RunState } from "../../server/analyze.ts";

export type { Analysis, AriProgram, Level, RunState };

export interface ShipSummary {
  shipId: string;
  title: string;
  author: string;
  thumb: string | null;
  track: string;
  ago: string;
  evidenceSeconds: number;
  isUpdate: boolean;
  priority: boolean;
  claim: { mine: boolean; byName: string } | null;
  checks: Record<string, { level: Level; summary: string }>;
  recommendation: "approve" | "changes" | "reject" | null;
  confidence: string | null;
  summary: string | null;
  returnReason: string | null;
  stack: string | null;
  aiError: string | null;
  analyzedAt: string;
  decided: Analysis["decided"];
}

export interface Config {
  hasCookie: boolean;
  aiProvider: "api" | "claude-code" | "codex";
  aiReady: boolean;
  hasGithub: boolean;
  model: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { body });
  return body as T;
}

export const api = {
  config: () => req<Config>("/api/config"),
  programs: () => req<AriProgram[]>("/api/programs"),
  analyze: (programId: string, force = false) => req<RunState>(`/api/programs/${programId}/analyze`, { method: "POST", body: JSON.stringify({ force }) }),
  ships: (programId: string) => req<{ run: RunState | null; ships: ShipSummary[]; queueSize: number }>(`/api/programs/${programId}/ships`),
  ship: (programId: string, shipId: string) => req<Analysis>(`/api/programs/${programId}/ships/${shipId}`),
  reanalyze: (programId: string, shipId: string) => req<ShipSummary>(`/api/programs/${programId}/ships/${shipId}/reanalyze`, { method: "POST" }),
  decide: (programId: string, shipId: string, body: DecisionPayload) =>
    req<{ ok: true }>(`/api/programs/${programId}/ships/${shipId}/decision`, {
      method: "POST",
      headers: { "x-confirm-decision": shipId },
      body: JSON.stringify({ ...body, confirmed: true }),
    }),
};

export interface DecisionPayload {
  decision: "approve" | "changes" | "reject";
  note: string;
  audit: string;
  technicalFeatures: string;
  checks: boolean[];
  fieldValues: Record<string, unknown>;
  fixChecks: string[];
  deflateSeconds: number | null;
  deflationReason: string;
}

export const fmtHours = (s: number | null | undefined) => (s == null ? "?" : `${(s / 3600).toFixed(1)}h`);
export const ariUrl = (programId: string, shipId: string) => `https://ari.hackclub.com/p/${programId}/review/${shipId}`;
