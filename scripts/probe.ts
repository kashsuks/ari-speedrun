// Read-only: dumps decoded SvelteKit page data from Ari so the parser can be mapped to real fields.
import { unflatten } from "devalue";
import { writeFileSync, mkdirSync } from "node:fs";

const path = process.argv[2];
if (!path) throw new Error("usage: tsx scripts/probe.ts /p/<program>/queue");
const res = await fetch((() => { const u = new URL(path, "https://ari.hackclub.com"); u.pathname = u.pathname.replace(/\/$/, "") + "/__data.json"; return u; })(), {
  headers: { cookie: process.env.ARI_COOKIE ?? "" },
  redirect: "manual",
});
if (res.status !== 200) throw new Error(`HTTP ${res.status} ${res.headers.get("location") ?? ""}`);
const [head, ...rest] = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const chunks = new Map<number, unknown>();
const revivers = { Promise: (id: number) => ({ __promise: id }) };
for (const c of rest) chunks.set(c.id, c.error ? { __error: c.error } : unflatten(c.data, revivers));
const nodes = head.nodes.map((n: any) => (n?.type === "data" ? unflatten(n.data, revivers) : n));
const resolve = (v: any): any =>
  v && typeof v === "object"
    ? "__promise" in v ? resolve(chunks.get(v.__promise))
    : Array.isArray(v) ? v.map(resolve)
    : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]))
    : v;
mkdirSync("data/probe", { recursive: true });
const out = `data/probe/${path.replace(/[^a-z0-9]+/gi, "_")}.json`;
writeFileSync(out, JSON.stringify(resolve(nodes), null, 2));
console.log(out);
