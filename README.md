# ari-speedrun

A triage dashboard for [Ari](https://ari.hackclub.com) review queues. Pick a YSWS, and it pulls every ship in that program's queue, checks each one, and drafts your review notes so you can decide fast.

For every ship it shows:

- **README**: Claude judges whether it was AI-generated.
- **Demo**: fetches the link and classifies it (live site, store listing, release with builds, video, or just source code).
- **Double-dip**: Ari's double-dip flags plus past projects that share the repo or Hackatime project.
- **Fraud squad**: the fraud team's verdict, trust scores and notes (deduction hints are flagged).
- **Commits**: cadence, gaps, code dumps, generic messages, and authors Ari couldn't match.
- **Hackatime**: whether the linked projects and per-file time actually belong to this repo.

Claude then recommends approve / changes / reject and drafts:

- approve: a note to the maker, an internal justification (audit note, 100+ chars as Ari requires), and the technical-features note
- changes: a short internal reason (e.g. "ai readme") and clear instructions for the maker

All drafts are editable. **Nothing is ever sent to Ari unless you press a decision button and confirm the dialog.** Analysis only reads Ari data; it never claims ships.

## How it talks to Ari

Ari's webhooks are program-side only (ingest ships, receive decisions) and cannot list a queue, so this app uses your reviewer session the same way the Ari web UI does: it reads the SvelteKit page data for `/p/<program>/queue` and `/p/<program>/review/<id>`, and on a confirmed decision posts `?/claim` then `?/approve|changes|reject`. If Ari changes its UI internals, `server/ari.ts` is the one file to update; `scripts/probe.ts` dumps raw payloads for that.

## Setup

```sh
cp .env.example .env   # fill in ARI_COOKIE, ANTHROPIC_API_KEY, optionally GITHUB_TOKEN and APP_PASSWORD
npm install
npm run dev            # http://localhost:5173 (API on :8787)
```

`ARI_COOKIE` only needs `ari_session=...` from your browser's cookies on ari.hackclub.com. It expires; when the app reports the session expired, copy a fresh one.

A `GITHUB_TOKEN` (no scopes) is strongly recommended: without it GitHub allows 60 API requests an hour, and the app falls back to Ari's per-file data for languages.

Results are cached in `data/` per ship and only re-analyzed when Ari's evidence changes (or you press Re-analyse).

## Hosting

```sh
docker build -t ari-speedrun .
docker run -p 8787:8787 --env-file .env -v ari-data:/data ari-speedrun
```

Works as-is on Fly.io, Railway, Render or any VPS. **Set `APP_PASSWORD`** before exposing it: the server holds your Ari session and can submit decisions as you. The browser will prompt for it (any username).

Optional env: `CLAUDE_MODEL` (default `claude-opus-5-5`), `ANALYSIS_CONCURRENCY` (default 3), `DATA_DIR`, `PORT`.
