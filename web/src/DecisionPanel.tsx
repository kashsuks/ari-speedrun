import { useState } from "react";
import { api, ariUrl, type Analysis, type DecisionPayload } from "./api.ts";
import { CopyButton } from "./bits.tsx";

type Decision = DecisionPayload["decision"];

const VERB: Record<Decision, string> = { approve: "Approve", changes: "Request changes", reject: "Reject" };

/** Drafts are prefilled from Claude, edited here, and only sent to Ari after an explicit confirm. */
function draftFor(a: Analysis, d: Decision) {
  const ai = a.ai;
  if (!ai) return { note: "", audit: "", technicalFeatures: "" };
  if (d === "approve") {
    return ai.recommendation === "approve"
      ? { note: ai.noteToMaker, audit: ai.auditNote, technicalFeatures: ai.technicalFeatures }
      : { note: "", audit: "", technicalFeatures: "" };
  }
  if (ai.recommendation === d) return { note: ai.noteToMaker, audit: ai.returnReason || ai.auditNote, technicalFeatures: "" };
  return { note: "", audit: "", technicalFeatures: "" };
}

export function DecisionPanel({ analysis: a, onDecided }: { analysis: Analysis; onDecided: () => void }) {
  const r = a.review;
  const initial: Decision = a.ai?.recommendation ?? "approve";
  const [decision, setDecision] = useState<Decision>(initial);
  const [drafts, setDrafts] = useState<Record<Decision, ReturnType<typeof draftFor>>>(() => ({
    approve: draftFor(a, "approve"),
    changes: draftFor(a, "changes"),
    reject: draftFor(a, "reject"),
  }));
  const [checks, setChecks] = useState<boolean[]>(() => r.checklist.map(() => false));
  const [fields, setFields] = useState<Record<string, unknown>>({});
  const [fixChecks, setFixChecks] = useState<string[]>([]);
  const [deflateHours, setDeflateHours] = useState("");
  const [deflationReason, setDeflationReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft = drafts[decision];
  const set = (k: keyof typeof draft, v: string) => setDrafts((d) => ({ ...d, [decision]: { ...d[decision], [k]: v } }));

  if (a.decided) {
    return (
      <section className="decision done">
        <h3>Decided from this dashboard: {a.decided.decision}</h3>
        <span className="muted">{a.decided.at}</span>
      </section>
    );
  }

  const problems: string[] = [];
  if (!draft.note.trim()) problems.push("Note to maker is required");
  if (!draft.audit.trim()) problems.push("Audit note is required");
  if (decision === "approve") {
    if (draft.audit.trim().length < 100) problems.push(`Audit note needs ${100 - draft.audit.trim().length} more characters for an approval`);
    if (r.rules.hoursJustification && !draft.technicalFeatures.trim()) problems.push("Technical features are required");
    if (checks.some((c) => !c)) problems.push("Tick every checklist item");
    for (const f of r.customFields) if (f.required && !fields[f.key]) problems.push(`"${f.label}" is required`);
    const missingFix = r.fixes.filter((f) => !fixChecks.includes(f.reviewId));
    if (missingFix.length) problems.push("Confirm the requested fixes were addressed");
  }
  const deflateSeconds = deflateHours ? Math.round(Number(deflateHours) * 3600) : null;
  if (deflateSeconds && !deflationReason.trim()) problems.push("Explain the deflation");
  const lockedByOther = !!(a.queue.claim && !a.queue.claim.mine);

  async function send() {
    setSending(true);
    setError(null);
    try {
      await api.decide(a.programId, a.shipId, {
        decision,
        note: draft.note,
        audit: draft.audit,
        technicalFeatures: decision === "approve" ? draft.technicalFeatures : "",
        checks: decision === "approve" ? checks : [],
        fieldValues: fields,
        fixChecks,
        deflateSeconds: decision === "approve" ? deflateSeconds : null,
        deflationReason: decision === "approve" ? deflationReason : "",
      });
      setConfirming(false);
      onDecided();
    } catch (e) {
      const err = e as Error & { body?: { problems?: { message: string }[] } };
      setError([err.message, ...(err.body?.problems?.map((p) => p.message) ?? [])].join(" · "));
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="decision">
      <div className="tabs">
        {(["approve", "changes", "reject"] as Decision[]).map((d) => (
          <button key={d} className={`${decision === d ? "on" : ""} ${d}`} onClick={() => setDecision(d)}>
            {VERB[d]}
            {a.ai?.recommendation === d ? " ★" : ""}
          </button>
        ))}
      </div>

      {decision !== "approve" && a.ai?.changeInstructions && a.ai.recommendation === decision && (
        <div className="instructions">
          <b>What the maker needs to change</b>
          <p>{a.ai.changeInstructions}</p>
        </div>
      )}

      <Field label="Note to maker (shared)" value={draft.note} onChange={(v) => set("note", v)} rows={decision === "approve" ? 3 : 5} />
      {r.snippets.length > 0 && (
        <div className="snippets">
          <span className="muted">Snippets:</span>
          {r.snippets.map((sn) => (
            <button key={sn.id} className="ghost small" title={sn.body} onClick={() => set("note", draft.note ? `${draft.note}\n\n${sn.body}` : sn.body)}>
              /{sn.name}
            </button>
          ))}
        </div>
      )}
      <Field
        label={decision === "approve" ? `Justification / audit note (internal, ${draft.audit.trim().length}/100+)` : "Justification (internal, short)"}
        value={draft.audit}
        onChange={(v) => set("audit", v)}
        rows={decision === "approve" ? 6 : 2}
      />
      {decision === "approve" && (
        <>
          <Field label="Technical features (internal)" value={draft.technicalFeatures} onChange={(v) => set("technicalFeatures", v)} rows={3} />
          {r.rules.allowDeflation && (
            <div className="deflate">
              <label>
                Deflate by (hours)
                <input type="number" min="0" step="0.1" value={deflateHours} onChange={(e) => setDeflateHours(e.target.value)} />
              </label>
              {deflateHours && <input placeholder="Why the hours were cut" value={deflationReason} onChange={(e) => setDeflationReason(e.target.value)} />}
            </div>
          )}
          {r.fixes.length > 0 && (
            <div className="checklist">
              <b>Requested fixes from earlier reviews</b>
              {r.fixes.map((f) => (
                <label key={f.reviewId}>
                  <input
                    type="checkbox"
                    checked={fixChecks.includes(f.reviewId)}
                    onChange={(e) => setFixChecks((x) => (e.target.checked ? [...x, f.reviewId] : x.filter((id) => id !== f.reviewId)))}
                  />
                  <span>
                    {f.note} <span className="muted">({f.reviewerName}, {f.when})</span>
                  </span>
                </label>
              ))}
            </div>
          )}
          {r.checklist.length > 0 && (
            <div className="checklist">
              <b>Program checklist</b>
              {r.checklist.map((c, i) => (
                <label key={i}>
                  <input type="checkbox" checked={checks[i]} onChange={(e) => setChecks((x) => x.map((v, j) => (j === i ? e.target.checked : v)))} />
                  <span>{c.label}</span>
                </label>
              ))}
            </div>
          )}
        </>
      )}
      {r.customFields.length > 0 && (
        <div className="checklist">
          <b>Program fields</b>
          {r.customFields.map((f) =>
            f.type === "checkbox" ? (
              <label key={f.key} title={f.description}>
                <input type="checkbox" checked={fields[f.key] === true} onChange={(e) => setFields((x) => ({ ...x, [f.key]: e.target.checked }))} />
                <span>
                  {f.label} <span className="muted">{f.description}</span>
                </span>
              </label>
            ) : (
              <label key={f.key} className="textfield">
                {f.label}
                <input value={String(fields[f.key] ?? "")} onChange={(e) => setFields((x) => ({ ...x, [f.key]: e.target.value }))} />
              </label>
            ),
          )}
        </div>
      )}

      <div className="submit">
        {problems.length > 0 && <div className="muted problems">{problems.join(" · ")}</div>}
        {lockedByOther && <div className="banner warn">{a.queue.claim!.byName} has this ship claimed in Ari.</div>}
        <button className={`primary ${decision}`} disabled={problems.length > 0 || sending} onClick={() => setConfirming(true)}>
          {VERB[decision]} in Ari…
        </button>
        <a className="muted small" href={ariUrl(a.programId, a.shipId)} target="_blank" rel="noreferrer">
          or paste these into Ari yourself ↗
        </a>
      </div>
      {error && <div className="banner fail">{error}</div>}

      {confirming && (
        <div className="modal" onClick={() => !sending && setConfirming(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>
              {VERB[decision]} “{r.ship.title}”?
            </h3>
            <p>
              This claims the ship in Ari and submits the decision as you. Ari sends it to the program right away
              {decision === "approve" ? " (or holds it for second pass)." : "."}
            </p>
            <div className="preview">
              <b>Note to maker</b>
              <p>{draft.note}</p>
              <b>Audit</b>
              <p>{draft.audit}</p>
              {decision === "approve" && (
                <>
                  <b>Technical features</b>
                  <p>{draft.technicalFeatures}</p>
                </>
              )}
            </div>
            <div className="row">
              <button className="ghost" disabled={sending} onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button className={`primary ${decision}`} disabled={sending} onClick={send}>
                {sending ? "Sending…" : `Yes, ${VERB[decision].toLowerCase()}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Field({ label, value, onChange, rows }: { label: string; value: string; onChange: (v: string) => void; rows: number }) {
  return (
    <label className="field">
      <span className="flabel">
        {label} <CopyButton text={value} />
      </span>
      <textarea rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
