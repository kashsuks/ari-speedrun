import { env } from "./env.ts";
import type { GithubInfo } from "./types.ts";

export function parseRepo(url: string | null | undefined): { owner: string; repo: string } | null {
  if (!url) return null;
  const m = url.match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/, "") } : null;
}

let rateLimitedUntil = 0;

export async function gh<T>(path: string): Promise<T | null> {
  if (Date.now() < rateLimitedUntil) return null;
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "ari-speedrun",
      ...(env.githubToken ? { authorization: `Bearer ${env.githubToken}` } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!res) return null;
  if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
    rateLimitedUntil = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
    return null;
  }
  return res.ok ? ((await res.json()) as T) : null;
}

async function rawReadme(owner: string, repo: string): Promise<string | null> {
  for (const name of ["README.md", "readme.md", "Readme.md", "README.MD", "README", "README.rst", "README.txt"]) {
    const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${name}`, {
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (res?.ok) return await res.text();
  }
  return null;
}

export async function fetchGithub(repoUrl: string): Promise<GithubInfo | null> {
  const parsed = parseRepo(repoUrl);
  if (!parsed) return null;
  const { owner, repo } = parsed;
  const [meta, languages, readmeMarkdown] = await Promise.all([
    gh<any>(`/repos/${owner}/${repo}`),
    gh<Record<string, number>>(`/repos/${owner}/${repo}/languages`),
    rawReadme(owner, repo),
  ]);
  const tree = meta?.default_branch
    ? await gh<{ tree: { path: string; type: string }[] }>(`/repos/${owner}/${repo}/git/trees/${meta.default_branch}?recursive=1`)
    : null;
  return {
    owner,
    repo,
    description: meta?.description ?? null,
    stars: meta?.stargazers_count ?? 0,
    fork: !!meta?.fork,
    createdAt: meta?.created_at ?? null,
    pushedAt: meta?.pushed_at ?? null,
    languages: languages ?? {},
    topLevel: tree ? [...new Set(tree.tree.map((t) => t.path.split("/")[0]))].slice(0, 60) : [],
    fileCount: tree ? tree.tree.filter((t) => t.type === "blob").length : null,
    readmeMarkdown,
  };
}

const EXT_LANG: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", py: "Python",
  rs: "Rust", go: "Go", java: "Java", kt: "Kotlin", swift: "Swift", c: "C", h: "C", cpp: "C++", cc: "C++",
  hpp: "C++", cs: "C#", rb: "Ruby", php: "PHP", lua: "Lua", gd: "GDScript", dart: "Dart", svelte: "Svelte",
  vue: "Vue", html: "HTML", css: "CSS", scss: "SCSS", nix: "Nix", zig: "Zig", sh: "Shell", ex: "Elixir",
  hs: "Haskell", ml: "OCaml", scala: "Scala", r: "R", jl: "Julia", sql: "SQL", ino: "Arduino",
};

/** Language breakdown from Ari's per-file Hackatime seconds, used when the GitHub API is unavailable. */
export function languagesFromFiles(files: { path: string; seconds: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of files) {
    const lang = EXT_LANG[f.path.split(".").pop()?.toLowerCase() ?? ""];
    if (lang) out[lang] = (out[lang] ?? 0) + f.seconds;
  }
  return out;
}
