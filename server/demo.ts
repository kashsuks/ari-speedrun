// Fetches a ship's demo link and classifies whether it is something a reviewer can actually use.
import { gh, parseRepo } from "./github.ts";
import type { DemoProbe } from "./types.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const SOURCE_EXT = /\.(zip|tar\.gz|tgz)$/i;
const VIDEO_HOSTS = /(youtube\.com|youtu\.be|vimeo\.com|loom\.com|streamable\.com|drive\.google\.com\/file)/i;
const STORE_HOSTS = /(play\.google\.com|apps\.apple\.com|chromewebstore\.google\.com|chrome\.google\.com\/webstore|addons\.mozilla\.org|microsoftedge\.microsoft\.com|itch\.io|testflight\.apple\.com|pypi\.org|npmjs\.com|crates\.io|marketplace\.visualstudio\.com|modrinth\.com|curseforge\.com|flathub\.org|snapcraft\.io|aur\.archlinux\.org)/i;

function htmlText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function githubDemo(url: string, base: DemoProbe): Promise<DemoProbe | null> {
  const repo = parseRepo(url);
  if (!repo) return null;
  const path = new URL(url).pathname.split("/").slice(3);
  if (path[0] === "releases") {
    const release =
      path[1] === "tag" && path[2]
        ? await gh<any>(`/repos/${repo.owner}/${repo.repo}/releases/tags/${path.slice(2).join("/")}`)
        : await gh<any>(`/repos/${repo.owner}/${repo.repo}/releases/latest`);
    const assets: string[] = (release?.assets ?? []).map((a: any) => a.name);
    const binaries = assets.filter((a) => !/^source code/i.test(a));
    return {
      ...base,
      kind: release == null || binaries.length ? "release" : "release-source-only",
      title: release?.name ?? null,
      textSample: release?.body?.slice(0, 1500) ?? null,
      releaseAssets: assets,
    };
  }
  // Repo root, tree, or blob: this is just source code.
  return { ...base, kind: "source-only", title: `${repo.owner}/${repo.repo}` };
}

export async function probeDemo(url: string | null | undefined, repoUrl: string | null): Promise<DemoProbe> {
  const base: DemoProbe = { url: url ?? null, finalUrl: null, status: null, contentType: null, kind: "missing", title: null, textSample: null, releaseAssets: [] };
  if (!url) return base;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ...base, kind: "broken" };
  }

  if (/^(www\.)?github\.com$/i.test(parsed.hostname)) {
    const res = await githubDemo(url, base);
    if (res) return res;
  }
  if (VIDEO_HOSTS.test(url)) base.kind = "video";
  else if (STORE_HOSTS.test(url)) base.kind = "store";

  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  }).catch((e: Error) => e);
  if (res instanceof Error) return { ...base, kind: base.kind === "missing" ? "broken" : base.kind, textSample: `fetch failed: ${res.message}` };

  const contentType = res.headers.get("content-type");
  const out: DemoProbe = { ...base, finalUrl: res.url, status: res.status, contentType };
  if (!res.ok && res.status !== 403) return { ...out, kind: base.kind === "missing" ? "broken" : base.kind };

  // A redirect to the repo itself still means "source only".
  if (repoUrl && parseRepo(res.url) && parseRepo(res.url)?.repo === parseRepo(repoUrl)?.repo && !/\/releases/.test(res.url)) {
    return { ...out, kind: "source-only" };
  }
  if (SOURCE_EXT.test(res.url)) return { ...out, kind: "download" };
  if (contentType && !/text\/html|xhtml/.test(contentType)) {
    return { ...out, kind: /video\//.test(contentType) ? "video" : "download" };
  }
  const html = (await res.text()).slice(0, 400_000);
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null;
  const text = htmlText(html).slice(0, 2000);
  const kind = base.kind !== "missing" ? base.kind : "live-site";
  if (kind === "video") return { ...out, kind, title };
  return { ...out, kind, title, textSample: text || "(page rendered no static text, likely a client-side app)" };
}
