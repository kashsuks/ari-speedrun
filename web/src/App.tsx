import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type AriProgram, type Config, type RunState, type ShipSummary } from "./api.ts";
import { ShipDetail } from "./ShipDetail.tsx";
import { CHECK_LABELS, LevelDot, RecBadge } from "./bits.tsx";

type Filter = "all" | "approve" | "changes" | "reject" | "pending";

export function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [programs, setPrograms] = useState<AriProgram[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [programId, setProgramId] = useState<string | null>(() => new URLSearchParams(location.search).get("program"));
  const program = programs?.find((p) => p.id === programId) ?? null;

  useEffect(() => {
    api.config().then(setConfig).catch((e) => setError(e.message));
    api.programs().then(setPrograms).catch((e) => setError(e.message));
  }, []);

  const pick = (id: string | null) => {
    setProgramId(id);
    history.replaceState(null, "", id ? `?program=${id}` : "/");
  };

  return (
    <div className="app">
      <header className="top">
        <button className="brand" onClick={() => pick(null)}>Ari Speedrun</button>
        {program && <span className="crumb" style={{ color: program.color }}>{program.name}</span>}
        <span className="spacer" />
        {config && (
          <span className="cfg">
            {!config.hasAnthropic && <span className="pill fail">no ANTHROPIC_API_KEY</span>}
            {!config.hasGithub && <span className="pill warn" title="GitHub API is limited to 60 requests/hour without a token">no GITHUB_TOKEN</span>}
            <span className="muted">{config.model}</span>
          </span>
        )}
      </header>
      {error && <div className="banner fail">{error}</div>}
      {!program ? (
        <ProgramPicker programs={programs} onPick={pick} />
      ) : (
        <Queue key={program.id} program={program} />
      )}
    </div>
  );
}

function ProgramPicker({ programs, onPick }: { programs: AriProgram[] | null; onPick: (id: string) => void }) {
  if (!programs) return <div className="center muted">Loading programs from Ari…</div>;
  return (
    <div className="picker">
      <h1>Pick a YSWS to review</h1>
      <div className="cards">
        {programs.map((p) => (
          <button key={p.id} className="card" style={{ borderColor: p.color }} onClick={() => onPick(p.id)}>
            {p.iconUrl && <img src={p.iconUrl} alt="" />}
            <span className="name">{p.name}</span>
            <span className="muted">{p.pending} in queue</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Queue({ program }: { program: AriProgram }) {
  const [ships, setShips] = useState<ShipSummary[]>([]);
  const [run, setRun] = useState<RunState | null>(null);
  const [queueSize, setQueueSize] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const res = await api.ships(program.id);
      setShips(res.ships);
      setRun(res.run);
      setQueueSize(res.queueSize);
      return res.run;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, [program.id]);

  // Start analysing as soon as the program is picked; cached ships are reused.
  useEffect(() => {
    api.analyze(program.id).then(setRun).catch((e) => setError(e.message)).finally(refresh);
  }, [program.id, refresh]);

  useEffect(() => {
    if (run && run.finishedAt) return;
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [run, refresh]);

  const counts = useMemo(() => {
    const c = { all: 0, approve: 0, changes: 0, reject: 0, pending: 0 } as Record<Filter, number>;
    for (const s of ships) {
      if (s.decided) continue;
      c.all++;
      c[s.recommendation ?? "pending"]++;
    }
    return c;
  }, [ships]);

  const visible = ships
    .filter((s) => (filter === "all" ? true : filter === "pending" ? !s.recommendation : s.recommendation === filter))
    .sort((a, b) => Number(!!a.decided) - Number(!!b.decided));

  const running = run && !run.finishedAt;

  return (
    <div className="queue">
      <aside className="list">
        <div className="toolbar">
          <div className="filters">
            {(["all", "approve", "changes", "reject", "pending"] as Filter[]).map((f) => (
              <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                {f} <span className="muted">{counts[f]}</span>
              </button>
            ))}
          </div>
          <button
            className="ghost"
            disabled={!!running}
            title="Re-fetch the queue and analyse new ships (cached ones are reused unless their evidence changed)"
            onClick={() => api.analyze(program.id).then(setRun).then(refresh)}
          >
            ↻ Refresh queue
          </button>
        </div>
        {running && (
          <div className="progress">
            <div className="bar" style={{ width: `${(run.done / Math.max(1, run.total)) * 100}%` }} />
            <span>Analysing {run.done}/{run.total}…</span>
          </div>
        )}
        {error && <div className="banner fail">{error}</div>}
        {queueSize === 0 && <div className="center muted">Queue is empty.</div>}
        <ul>
          {visible.map((s) => (
            <li key={s.shipId} className={`${selected === s.shipId ? "sel" : ""} ${s.decided ? "done" : ""}`} onClick={() => setSelected(s.shipId)}>
              {s.thumb ? <img className="thumb" src={s.thumb} alt="" loading="lazy" /> : <div className="thumb" />}
              <div className="meta">
                <div className="row1">
                  <span className="title">{s.title}</span>
                  {s.decided ? <span className="pill">{s.decided.decision} ✓</span> : <RecBadge rec={s.recommendation} confidence={s.confidence} />}
                </div>
                <div className="row2 muted">
                  {s.author} · {(s.evidenceSeconds / 3600).toFixed(1)}h · {s.ago}
                  {s.isUpdate && <span className="pill blue">update</span>}
                  {s.claim && !s.claim.mine && <span className="pill warn">🔒 {s.claim.byName}</span>}
                </div>
                <div className="dots">
                  {Object.entries(CHECK_LABELS).map(([k, label]) => (
                    <LevelDot key={k} level={s.checks[k]?.level ?? "unknown"} title={`${label}: ${s.checks[k]?.summary ?? ""}`} />
                  ))}
                  {s.returnReason && s.recommendation !== "approve" && <span className="reason">{s.returnReason}</span>}
                </div>
              </div>
            </li>
          ))}
          {running &&
            run.active.map((id) => (
              <li key={`a-${id}`} className="ghostrow muted">analysing {id}…</li>
            ))}
        </ul>
      </aside>
      <main className="detail">
        {selected ? (
          <ShipDetail
            key={`${selected}-${version}`}
            programId={program.id}
            shipId={selected}
            onChanged={() => {
              setVersion((v) => v + 1);
              void refresh();
            }}
          />
        ) : (
          <div className="center muted">Select a ship</div>
        )}
      </main>
    </div>
  );
}
