import { useEffect, useMemo, useState } from "react";
import { api, ariUrl, fmtHours, type Analysis } from "./api.ts";
import { CHECK_LABELS, CopyButton, LevelDot, RecBadge } from "./bits.tsx";
import { DecisionPanel } from "./DecisionPanel.tsx";

export function ShipDetail({ programId, shipId, onChanged }: { programId: string; shipId: string; onChanged: () => void }) {
  const [a, setA] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.ship(programId, shipId).then(setA).catch((e) => setError(e.message));
  }, [programId, shipId]);

  if (error) return <div className="banner fail">{error}</div>;
  if (!a) return <div className="center muted">Loading…</div>;

  const { review: r, ai } = a;
  const s = r.ship;
  const h = r.hours;

  return (
    <div className="ship">
      <section className="head">
        {s.thumbnailUrl && <img className="cover" src={s.thumbnailUrl} alt="" />}
        <div className="headtext">
          <h2>
            {s.title} <RecBadge rec={ai?.recommendation ?? null} confidence={ai?.confidence} />
          </h2>
          <div className="muted">
            {r.makers.map((m) => m.name).join(", ")} · {s.track} · v{s.version} · shipped {s.receivedAt.slice(0, 10)}
            {r.update && <span className="pill blue">maker update</span>}
          </div>
          <p>{s.description}</p>
          <div className="links">
            <a href={ariUrl(programId, s.id)} target="_blank" rel="noreferrer">Open in Ari ↗</a>
            <a href={s.repoUrl} target="_blank" rel="noreferrer">Repo ↗</a>
            {s.demoUrl && <a href={s.demoUrl} target="_blank" rel="noreferrer">Demo ↗</a>}
            {s.extraRepoUrls.map((u) => (
              <a key={u} href={u} target="_blank" rel="noreferrer">{u.replace(/^https?:\/\//, "")} ↗</a>
            ))}
            <button
              className="ghost small"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.reanalyze(programId, shipId);
                  onChanged();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Re-analysing…" : "↻ Re-analyse"}
            </button>
          </div>
          <div className="hours">
            <b>{fmtHours(h.hackatimeSeconds + h.devlogSeconds + h.lapseSeconds + h.programSeconds)}</b>
            <span className="muted">
              hackatime {fmtHours(h.hackatimeSeconds)} · devlogs {fmtHours(h.devlogSeconds)} · lapse {fmtHours(h.lapseSeconds)}
              {h.programSeconds ? ` · program ${fmtHours(h.programSeconds)}` : ""}
              {h.aiDiscountedSeconds ? ` · AI-discounted ${fmtHours(h.aiDiscountedSeconds)}` : ""}
            </span>
          </div>
        </div>
      </section>

      {a.aiError && <div className="banner warn">AI analysis failed: {a.aiError}</div>}
      {ai && (
        <section className="summary">
          <p>{ai.summary}</p>
          <p className="muted">
            <b>Stack:</b> {ai.stack}
          </p>
        </section>
      )}

      <section className="checks">
        {Object.entries(CHECK_LABELS).map(([k, label]) => {
          const c = a.checks[k as keyof Analysis["checks"]];
          return (
            <details key={k} className={`check ${c.level}`} open={c.level === "fail" || c.level === "warn"}>
              <summary>
                <LevelDot level={c.level} /> <b>{label}</b> <span>{c.summary}</span>
              </summary>
              {c.details?.length ? (
                <ul>
                  {c.details.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              ) : null}
            </details>
          );
        })}
      </section>

      <DecisionPanel analysis={a} onDecided={onChanged} />

      <Commits a={a} />
      <Hackatime a={a} />
      {r.pastReviews.length > 0 && (
        <section>
          <h3>Prior reviews of this project</h3>
          {r.pastReviews.map((p) => (
            <div key={p.shipId + p.version} className="prior">
              <b>v{p.version} {p.decision}</b> <span className="muted">by {p.reviewerName}, {p.when}</span>
              <div>{p.note}</div>
              <div className="muted">audit: {p.audit}</div>
            </div>
          ))}
        </section>
      )}
      {r.pastProjects.length > 0 && (
        <section>
          <h3>Past projects ({r.pastProjects.length})</h3>
          <table className="tbl">
            <tbody>
              {r.pastProjects.map((p, i) => (
                <tr key={i}>
                  <td>{p.programs.join(", ")}</td>
                  <td>{p.approvedAt?.slice(0, 10)}</td>
                  <td>{fmtHours(p.creditedSeconds)}</td>
                  <td>{p.codeUrl && <a href={p.codeUrl} target="_blank" rel="noreferrer">{p.codeUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "")}</a>}</td>
                  <td className="muted">{p.description?.slice(0, 90)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {Object.keys(s.meta ?? {}).length > 0 && (
        <section>
          <h3>Submission meta</h3>
          <dl className="meta">
            {Object.entries(s.meta).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{/^https?:\/\//.test(v) ? <a href={v} target="_blank" rel="noreferrer">{v}</a> : v}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <section>
        <h3>
          README <CopyButton text={a.github?.readmeMarkdown ?? ""} />
        </h3>
        <pre className="readme">{a.github?.readmeMarkdown ?? "(README not fetched from GitHub; see Ari)"}</pre>
      </section>
    </div>
  );
}

function Commits({ a }: { a: Analysis }) {
  const st = a.commitStats;
  const days = useMemo(() => {
    if (!st.firstAt || !st.lastAt) return [];
    const out: { day: string; n: number }[] = [];
    for (let t = Date.parse(st.firstAt.slice(0, 10)); t <= Date.parse(st.lastAt.slice(0, 10)); t += 86_400_000) {
      const day = new Date(t).toISOString().slice(0, 10);
      out.push({ day, n: st.perDay[day] ?? 0 });
    }
    return out;
  }, [st]);
  const max = Math.max(1, ...days.map((d) => d.n));
  const commits = [...a.review.evidence.commits].sort((x, y) => y.committedAt.localeCompare(x.committedAt));
  return (
    <section>
      <h3>
        Commits <span className="muted">{st.total} over {st.activeDays} days</span>
      </h3>
      <div className="spark" title="commits per day">
        {days.map((d) => (
          <span key={d.day} title={`${d.day}: ${d.n}`} style={{ height: `${(d.n / max) * 100}%` }} className={d.n ? "" : "zero"} />
        ))}
      </div>
      <details>
        <summary className="muted">Show all commits</summary>
        <table className="tbl">
          <tbody>
            {commits.map((c) => (
              <tr key={c.id}>
                <td className="mono muted">{c.committedAt.slice(0, 16).replace("T", " ")}</td>
                <td className="mono">{fmtHours(c.codingSeconds)}</td>
                <td>
                  {c.people.some((p) => p.matched) ? "" : <span className="pill warn">unmatched</span>} {c.message.split("\n")[0]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

function Hackatime({ a }: { a: Analysis }) {
  const r = a.review;
  const total = r.fileHours.reduce((s, f) => s + f.seconds, 0) || 1;
  return (
    <section>
      <h3>
        Hackatime <span className="muted">{r.hackatimeProjects.map((p) => `${p.name} (${fmtHours(p.seconds)})`).join(", ")}</span>
      </h3>
      <details>
        <summary className="muted">Per-file time ({r.fileHours.length} files)</summary>
        <table className="tbl">
          <tbody>
            {r.fileHours.slice(0, 80).map((f) => (
              <tr key={f.path}>
                <td className={f.status === "head" ? "mono" : "mono warntext"}>{f.path}</td>
                <td className="mono">{fmtHours(f.seconds)}</td>
                <td className="muted">{((f.seconds / total) * 100).toFixed(0)}%</td>
                <td className="muted">{f.status === "head" ? "" : "not in repo"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
