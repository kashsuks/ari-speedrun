import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { env } from "./env.ts";
import type { AiVerdict, AriReview, Check, CommitStats, DemoProbe, GithubInfo } from "./types.ts";

const client = env.anthropicKey ? new Anthropic({ apiKey: env.anthropicKey }) : null;

const Verdict = z.object({
  recommendation: z.enum(["approve", "changes", "reject"]),
  confidence: z.enum(["high", "medium", "low"]),
  readme: z.object({ aiGenerated: z.enum(["likely", "possibly", "unlikely"]), reasoning: z.string() }),
  demo: z.object({ usable: z.boolean(), reasoning: z.string() }),
  hackatimeRelated: z.object({ related: z.boolean(), reasoning: z.string() }),
  commits: z.object({ healthy: z.boolean(), reasoning: z.string() }),
  summary: z.string(),
  stack: z.string(),
  noteToMaker: z.string(),
  auditNote: z.string(),
  technicalFeatures: z.string(),
  returnReason: z.string(),
  changeInstructions: z.string(),
});

const SYSTEM = `You help a Hack Club YSWS reviewer triage project submissions ("ships") in Ari, the review platform. You are a reviewer's assistant, not the fraud squad: take the fraud squad's verdict and notes as given and never second-guess their trust score.

For each ship you get Ari's evidence (commits, Hackatime projects and per-file time, timelapses, devlogs, past projects, prior reviews, fraud squad notes, double-dip flags), the README, and an automated probe of the demo link. Judge:

1. README: is it AI-generated? Signals: emoji section headers, generic "Features/Tech Stack/Getting Started/Contributing/License" boilerplate with no project-specific detail, marketing tone, em-dash heavy prose, bolded bullet lists with "**Thing** - description", "Built with love", claims that don't match the code. A short, plain, slightly messy README written by a teenager is human. A README with a few AI-polished sentences is "possibly"; a README that reads like a template is "likely". Programs return ships with AI READMEs.
2. Demo: is it something a reviewer can actually use? Live sites, store listings, and releases with built binaries or loadable packages count. A link to the GitHub repo or source code does not. A video alone is weak for software unless the project can't reasonably be hosted (e.g. hardware, OS-level tools); say so. A browser extension release whose zip can be loaded unpacked is acceptable. Use the probe result; if the probe could not see the page content (client-side app, 403), give the benefit of the doubt when the URL looks like a real deployment.
3. Hackatime: do the linked Hackatime project names and the per-file time correspond to this repo? Time in files that don't exist in the repo, or project names for something else entirely, is a problem.
4. Commits: are they frequent and real, or a few giant dumps / generic messages / unmatched authors? Compare commit cadence with the tracked hours.
5. Double-dipping: has this same project (same repo or same Hackatime project) already been credited by another program? Ari's DOUBLE_DIP flag that says time was paid "before this program" means only the older hours were paid elsewhere; that is fine if this ship is new work, which update ships often are.

Recommend "approve" when everything holds up, "changes" when something the maker can fix is wrong (AI README, no usable demo, unrelated Hackatime project, missing info), and "reject" only for clear-cut ineligibility (double-dip of the same work, fraud failure). When unsure between approve and changes, choose changes and say why with low confidence.

Write these fields:
- summary: 1-2 sentences on what the project is and your overall read.
- stack: the languages/frameworks/tools used, comma separated, e.g. "TypeScript, React, Vite, Supabase".
- noteToMaker: shared with the maker. If approving, a short warm, specific note (2-3 sentences) that mentions something concrete you liked; no generic praise, no emojis. If returning, clear numbered instructions on exactly what to change before reshipping, friendly and direct. If one of the program's canned snippets fits, base the note on its wording.
- auditNote: internal justification. If approving: at least 400 characters covering what the project is, the README, the demo, the commits/time evidence, and the fraud squad note (quote their score), in plain sentences. If returning: one short phrase, e.g. "ai readme", "demo is source code", "hackatime project unrelated".
- technicalFeatures: if approving, 2-4 sentences naming the specific technical features that account for the hours (what was actually built, not adjectives). If returning, an empty string.
- returnReason: a few words, the internal reason for returning (empty string when approving).
- changeInstructions: the concrete list of what the maker must change (empty string when approving).

Write like a person: plain words, no em dashes, no filler.`;

function fmtHours(s: number | null | undefined) {
  return s == null ? "?" : `${(s / 3600).toFixed(1)}h`;
}

const MAX_README = 60_000;

export function buildPrompt(input: {
  programName: string;
  review: AriReview;
  readme: string | null;
  github: GithubInfo | null;
  demo: DemoProbe;
  stats: CommitStats;
  checks: Record<string, Check>;
  languages: Record<string, number>;
}): string {
  const { review: r, readme, github, demo, stats, checks, languages } = input;
  const s = r.ship;
  const lines: string[] = [];
  const section = (title: string, body: string | string[]) => lines.push(`<${title}>\n${Array.isArray(body) ? body.join("\n") : body}\n</${title}>`);

  section("program", input.programName);
  section("ship", [
    `Title: ${s.title}`,
    `Author: ${s.author}`,
    `Track: ${s.track}`,
    `Version: ${s.version}${r.update ? " (maker update)" : ""}`,
    `Description: ${s.description}`,
    `Repo: ${s.repoUrl}${s.extraRepoUrls.length ? ` (+ ${s.extraRepoUrls.join(", ")})` : ""}`,
    `Demo: ${s.demoUrl ?? "(none)"}`,
    ...Object.entries(s.meta ?? {}).map(([k, v]) => `Meta "${k}": ${v}`),
  ]);
  if (r.update?.message) section("maker_update_message", r.update.message);
  section("time_evidence", [
    `Hackatime ${fmtHours(r.hours.hackatimeSeconds)}, devlogs ${fmtHours(r.hours.devlogSeconds)}, timelapses ${fmtHours(r.hours.lapseSeconds)}, program-added ${fmtHours(r.hours.programSeconds)}, AI-discounted ${fmtHours(r.hours.aiDiscountedSeconds)}, after last commit ${fmtHours(r.hours.afterLastCommitSeconds)}`,
    `Hackatime projects: ${r.hackatimeProjects.map((p) => `${p.name} (${fmtHours(p.seconds)})`).join(", ") || "(none)"}`,
    `Per-file Hackatime time (status "head" = file exists in repo):`,
    ...r.fileHours.slice(0, 60).map((f) => `  ${f.path}  ${fmtHours(f.seconds)}  ${f.status}`),
    r.fileHours.length > 60 ? `  ... ${r.fileHours.length - 60} more files` : "",
  ]);
  section("commits", [
    `Stats: ${stats.total} commits, ${stats.activeDays} active days over ${stats.spanDays} days, longest gap ${stats.largestGapDays}d, biggest commit holds ${(stats.biggestCommitShare * 100).toFixed(0)}% of coding time, ${stats.unmatchedAuthors} with unmatched authors, ${stats.lowEffortMessages} generic messages`,
    ...[...r.evidence.commits]
      .sort((a, b) => a.committedAt.localeCompare(b.committedAt))
      .slice(-150)
      .map((c) => `  ${c.committedAt.slice(0, 16)}  ${fmtHours(c.codingSeconds).padStart(6)}  ${c.people.some((p) => p.matched) ? "" : "[unmatched] "}${c.message.split("\n")[0].slice(0, 140)}`),
  ]);
  if (r.evidence.devlogs.length) section("devlogs", r.evidence.devlogs.slice(0, 40).map((d) => `  ${d.at ?? ""} ${fmtHours(d.seconds)} ${(d.text ?? "").slice(0, 400)}`));
  if (r.evidence.clips.length) section("timelapses", r.evidence.clips.slice(0, 40).map((c) => `  ${c.at.slice(0, 10)} ${fmtHours(c.lengthSeconds)} ${c.note ?? ""}`));
  section("languages", Object.entries(languages).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(", ") || "(unknown)");
  if (github) section("repo", [`Files: ${github.fileCount ?? "?"}`, `Top level: ${github.topLevel.join(", ")}`, `Created ${github.createdAt ?? "?"}, fork: ${github.fork}`]);
  section("demo_probe", [
    `Classified as: ${demo.kind}`,
    `URL: ${demo.url ?? "(none)"} → ${demo.finalUrl ?? "-"} (HTTP ${demo.status ?? "-"}, ${demo.contentType ?? "-"})`,
    demo.title ? `Title: ${demo.title}` : "",
    demo.releaseAssets.length ? `Release assets: ${demo.releaseAssets.join(", ")}` : "",
    demo.textSample ? `Page text: ${demo.textSample}` : "",
  ]);
  section("fraud_squad", r.warnings.filter((w) => w.kind === "FRAUD").map((w) => `${w.title}: ${w.what}`).join("\n") || "No fraud review on record.");
  section("other_flags", r.warnings.filter((w) => w.kind !== "FRAUD").map((w) => `[${w.kind}] ${w.title}: ${w.what} | ${w.matched.map((m) => `${m.key}: ${m.value}`).join("; ")} | Ari suggests: ${w.action}`).join("\n") || "None.");
  section(
    "past_projects",
    r.pastProjects.map((p) => `  ${p.programs.join("/")} ${p.approvedAt?.slice(0, 10) ?? ""} ${fmtHours(p.creditedSeconds)} code=${p.codeUrl ?? "-"} demo=${p.playableUrl ?? "-"} ht=[${p.hackatimeProjects.join(", ")}] ${(p.description ?? "").slice(0, 160).replace(/\n/g, " ")}`).join("\n") || "None.",
  );
  if (r.pastReviews.length) section("prior_reviews_of_this_project", r.pastReviews.map((p) => `  v${p.version} ${p.decision} by ${p.reviewerName} (${p.when}): note="${p.note}" audit="${p.audit}"`));
  section("automated_checks", Object.entries(checks).map(([k, c]) => `${k}: ${c.level.toUpperCase()} - ${c.summary}${c.details?.length ? `\n  ${c.details.join("\n  ")}` : ""}`));
  section("program_checklist", r.checklist.map((c) => `- ${c.label}`).join("\n") || "(none)");
  section("program_canned_snippets", r.snippets.map((sn) => `[${sn.name}] ${sn.body}`).join("\n") || "(none)");

  const readmeText = readme ?? "(no README found)";
  section("readme", readmeText.length > MAX_README ? `${readmeText.slice(0, MAX_README)}\n[README truncated at ${MAX_README} characters of ${readmeText.length}]` : readmeText);
  lines.push("Review this ship and fill in every field.");
  return lines.filter(Boolean).join("\n\n");
}

export async function judge(prompt: string): Promise<AiVerdict> {
  if (!client) throw new Error("ANTHROPIC_API_KEY is not set");
  const res = await client.beta.messages.parse({
    model: env.model,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: betaZodOutputFormat(Verdict) },
    system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });
  if (res.stop_reason === "refusal") throw new Error("Claude declined to review this ship");
  if (!res.parsed_output) throw new Error(`Claude returned no structured output (stop: ${res.stop_reason})`);
  return res.parsed_output;
}
