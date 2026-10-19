// Deterministic checks computed from Ari's evidence. Claude refines the README/demo/hackatime
// verdicts afterwards; these give an instant first pass and feed the prompt.
import { parseRepo } from "./github.ts";
import type { AriReview, Check, CommitStats, DemoProbe, Level } from "./types.ts";

const DAY = 86_400_000;
const hours = (s: number) => `${(s / 3600).toFixed(1)}h`;

export function fraudCheck(r: AriReview): Check {
  const fraud = r.warnings.filter((w) => w.kind === "FRAUD");
  if (!fraud.length) return { level: "unknown", summary: "No fraud squad review on record" };
  const details: string[] = [];
  let level: Level = "pass";
  for (const w of fraud) {
    const failed = /fail|reject/i.test(w.title);
    if (failed) level = "fail";
    for (const m of w.matched.length ? w.matched : [{ key: "", value: w.what }]) {
      details.push(`${m.key ? `${m.key}: ` : ""}${m.value}`);
      const score = Number(m.value.match(/(\d+)\s*\/\s*10/)?.[1] ?? NaN);
      if (score <= 3) level = "fail";
      else if (level === "pass" && (score <= 6 || /\b(\d+(\.\d+)?)\s*(h|hr|hrs|hours)\b|deduct|deflat|at most|cut|undeclared ai/i.test(m.value))) level = "warn";
    }
  }
  const scores = details.map((d) => d.match(/(\d+)\s*\/\s*10/)?.[0]).filter(Boolean);
  const title = fraud.map((w) => w.title).join("; ");
  const summary = level === "warn" ? `${title} with concerns (${scores.join(", ")})` : `${title}${scores.length ? ` (${scores.join(", ")})` : ""}`;
  return { level, summary, details };
}

const normRepo = (u: string | null | undefined) => {
  const p = parseRepo(u);
  return p ? `${p.owner}/${p.repo}`.toLowerCase() : (u ?? "").toLowerCase().replace(/\/+$/, "");
};

export function doubleDipCheck(r: AriReview): Check {
  const details: string[] = [];
  let level: Level = "pass";
  for (const w of r.warnings.filter((w) => w.kind === "DOUBLE_DIP")) {
    level = "warn";
    details.push(`${w.title}: ${w.what}`, ...w.matched.map((m) => `  ${m.key}: ${m.value}`), `  Ari says: ${w.action}`);
  }
  const repo = normRepo(r.ship.repoUrl);
  const htNames = new Set(r.hackatimeProjects.map((p) => p.name.toLowerCase()));
  for (const p of r.pastProjects) {
    const sameRepo = repo && normRepo(p.codeUrl) === repo;
    const sameHt = p.hackatimeProjects.some((h) => htNames.has(h.toLowerCase()));
    if (sameRepo || sameHt) {
      level = "fail";
      details.push(`Same ${sameRepo ? "repo" : "Hackatime project"} already credited in ${p.programs.join(", ")} (${hours(p.creditedSeconds)}, ${p.approvedAt?.slice(0, 10) ?? "?"}): ${p.codeUrl ?? ""}`);
    }
  }
  if (r.update?.message && /ysws|submitted|juice|beest|hacktank|summer|arcade|high seas|macondo|horizons|shipwrecked|athena/i.test(r.update.message)) {
    if (level === "pass") level = "warn";
    details.push(`Maker's update note mentions other programs: "${r.update.message.slice(0, 300)}"`);
  }
  const summary =
    level === "fail" ? "Same project already credited elsewhere"
    : level === "warn" ? "Possible double-dip, check details"
    : `No overlap with ${r.pastProjects.length} past project${r.pastProjects.length === 1 ? "" : "s"}`;
  return { level, summary, details };
}

const LOW_EFFORT = /^(update|updated|fix|fixes|fixed|wip|commit|changes|stuff|asdf|test|\.|initial commit|add files via upload|update readme\.md|create readme\.md)$/i;

export function commitStats(r: AriReview): CommitStats {
  const commits = [...r.evidence.commits].sort((a, b) => a.committedAt.localeCompare(b.committedAt));
  const perDay: Record<string, number> = {};
  for (const c of commits) perDay[c.committedAt.slice(0, 10)] = (perDay[c.committedAt.slice(0, 10)] ?? 0) + 1;
  const days = Object.keys(perDay).sort();
  let largestGapDays = 0;
  for (let i = 1; i < days.length; i++) largestGapDays = Math.max(largestGapDays, (Date.parse(days[i]) - Date.parse(days[i - 1])) / DAY);
  const totalSeconds = commits.reduce((s, c) => s + c.codingSeconds, 0);
  const biggest = commits.reduce((m, c) => Math.max(m, c.codingSeconds), 0);
  return {
    total: commits.length,
    activeDays: days.length,
    spanDays: days.length ? Math.round((Date.parse(days[days.length - 1]) - Date.parse(days[0])) / DAY) + 1 : 0,
    firstAt: commits[0]?.committedAt ?? null,
    lastAt: commits[commits.length - 1]?.committedAt ?? null,
    largestGapDays: Math.round(largestGapDays),
    unmatchedAuthors: commits.filter((c) => c.people.length && c.people.every((p) => !p.matched)).length,
    lowEffortMessages: commits.filter((c) => LOW_EFFORT.test(c.message.trim())).length,
    biggestCommitShare: totalSeconds ? biggest / totalSeconds : 0,
    perDay,
  };
}

export function commitCheck(r: AriReview, s: CommitStats): Check {
  const details = [
    `${s.total} commits over ${s.activeDays} active day${s.activeDays === 1 ? "" : "s"} (span ${s.spanDays}d, longest gap ${s.largestGapDays}d)`,
  ];
  let level: Level = "pass";
  const totalHours = (r.hours.hackatimeSeconds + r.hours.devlogSeconds + r.hours.lapseSeconds) / 3600;
  if (s.total === 0) return { level: "fail", summary: "No commits captured", details };
  if (s.total <= 3 && totalHours > 5) {
    level = "fail";
    details.push(`Only ${s.total} commits for ${totalHours.toFixed(1)}h of tracked time`);
  }
  if (s.biggestCommitShare > 0.6 && totalHours > 5) {
    level = level === "fail" ? "fail" : "warn";
    details.push(`One commit carries ${(s.biggestCommitShare * 100).toFixed(0)}% of the coding time (code dump?)`);
  }
  if (s.lowEffortMessages / s.total > 0.5) {
    if (level === "pass") level = "warn";
    details.push(`${s.lowEffortMessages}/${s.total} commit messages are generic ("update", "fix", ...)`);
  }
  if (s.unmatchedAuthors / s.total > 0.5) {
    if (level === "pass") level = "warn";
    details.push(`${s.unmatchedAuthors}/${s.total} commits have authors Ari could not match to the maker`);
  }
  if (s.activeDays <= 2 && totalHours > 10) {
    if (level === "pass") level = "warn";
    details.push(`All work landed on ${s.activeDays} day(s) for ${totalHours.toFixed(1)}h`);
  }
  const summary = level === "pass" ? `${s.total} commits across ${s.activeDays} days, looks steady` : details[details.length - 1];
  return { level, summary, details };
}

const tokens = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));

export function hackatimeCheck(r: AriReview): Check {
  const names = r.hackatimeProjects.map((p) => p.name);
  if (!names.length) return { level: r.hours.devlogSeconds || r.hours.programSeconds ? "unknown" : "fail", summary: "No Hackatime projects linked" };
  const tracked = r.fileHours.reduce((s, f) => s + f.seconds, 0);
  const inRepo = r.fileHours.filter((f) => f.status === "head").reduce((s, f) => s + f.seconds, 0);
  const share = tracked ? inRepo / tracked : null;
  const repo = parseRepo(r.ship.repoUrl)?.repo ?? "";
  const ref = new Set([...tokens(repo), ...tokens(r.ship.title)]);
  const unrelatedNames = names.filter((n) => ![...tokens(n)].some((t) => ref.has(t)));
  const details = [
    `Projects: ${r.hackatimeProjects.map((p) => `${p.name}${p.seconds != null ? ` (${hours(p.seconds)})` : ""}`).join(", ")}`,
    share != null ? `${(share * 100).toFixed(0)}% of per-file Hackatime time is in files that exist in the repo` : "No per-file time captured",
  ];
  const outside = r.fileHours.filter((f) => f.status !== "head").sort((a, b) => b.seconds - a.seconds).slice(0, 5);
  if (outside.length) details.push(`Top files not in repo: ${outside.map((f) => `${f.path} (${hours(f.seconds)})`).join(", ")}`);
  if (r.hours.aiDiscountedSeconds) details.push(`Ari AI-discounted ${hours(r.hours.aiDiscountedSeconds)}`);
  let level: Level = "pass";
  if (share != null && share < 0.5) {
    // Time in a second listed repo (firmware, backend, ...) is expected to show as "not in repo".
    level = r.ship.extraRepoUrls.length ? "warn" : "fail";
    if (r.ship.extraRepoUrls.length) details.push(`Ship lists extra repos (${r.ship.extraRepoUrls.join(", ")}); outside time may live there`);
  }
  else if ((share != null && share < 0.8) || unrelatedNames.length) level = "warn";
  if (unrelatedNames.length) details.push(`Names that don't resemble the repo/title: ${unrelatedNames.join(", ")}`);
  const summary =
    level === "fail" ? "Most tracked time is in files outside this repo"
    : level === "warn" ? (unrelatedNames.length ? `Check project names: ${unrelatedNames.join(", ")}` : "Some tracked time is outside the repo")
    : "Hackatime time maps onto this repo's files";
  return { level, summary, details };
}

export function demoCheck(r: AriReview, d: DemoProbe): Check {
  const where = d.finalUrl && d.finalUrl !== d.url ? ` → ${d.finalUrl}` : "";
  const details = [`${d.url ?? "(none)"}${where}`, d.status ? `HTTP ${d.status}${d.title ? ` · "${d.title}"` : ""}` : ""].filter(Boolean);
  if (d.releaseAssets.length) details.push(`Assets: ${d.releaseAssets.join(", ")}`);
  switch (d.kind) {
    case "missing":
      return { level: r.ship.track === "hardware" ? "unknown" : "fail", summary: "No demo link", details };
    case "broken":
      return { level: "fail", summary: "Demo link is broken", details };
    case "source-only":
      return { level: "fail", summary: "Demo just links to source code", details };
    case "release-source-only":
      return { level: "warn", summary: "Release has only source archives, no build", details };
    case "video":
      return { level: "warn", summary: "Demo is a video, not something runnable", details };
    case "release":
      return { level: "pass", summary: `Release with ${d.releaseAssets.length || "?"} downloadable asset(s)`, details };
    case "store":
      return { level: "pass", summary: "Published on a store/package registry", details };
    case "download":
      return { level: "pass", summary: "Direct download", details };
    default:
      return { level: d.status && d.status < 400 ? "pass" : "warn", summary: d.status === 403 ? "Live site (blocked our bot, check manually)" : "Live site loads", details };
  }
}
