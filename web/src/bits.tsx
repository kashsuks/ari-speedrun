import { useState } from "react";
import type { Level } from "./api.ts";

export const CHECK_LABELS: Record<string, string> = {
  readme: "README",
  demo: "Demo",
  doubleDip: "Double-dip",
  fraud: "Fraud squad",
  commits: "Commits",
  hackatime: "Hackatime",
};

export function LevelDot({ level, title }: { level: Level; title?: string }) {
  return <span className={`dot ${level}`} title={title} />;
}

export function RecBadge({ rec, confidence }: { rec: string | null; confidence?: string | null }) {
  if (!rec) return <span className="pill">pending</span>;
  const cls = rec === "approve" ? "pass" : rec === "changes" ? "warn" : "fail";
  return (
    <span className={`pill ${cls}`} title={confidence ? `${confidence} confidence` : undefined}>
      {rec}
      {confidence === "low" ? "?" : ""}
    </span>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="ghost small"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}
