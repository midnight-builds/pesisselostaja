import { useEffect, useMemo, useRef, useState } from "react";
import type { LogLine } from "../../shared/types";
import { api } from "../api";
import { fiTimeSec } from "../format";

/** Newest first. New lines only jump the list to the top while the operator is
 *  already at the top — once they scroll down to read something, the list
 *  freezes until they come back. */

type Level = LogLine["level"];

const LEVELS: Array<{ id: Level; label: string }> = [
  { id: "debug", label: "Kaikki" },
  { id: "info", label: "Info" },
  { id: "warn", label: "Varoitus" },
  { id: "error", label: "Virhe" },
];

const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

interface Props {
  lines: LogLine[];
  notify: (kind: "ok" | "error", text: string) => void;
}

export function LogView({ lines, notify }: Props) {
  const [level, setLevel] = useState<Level>("info");
  const [fetched, setFetched] = useState<LogLine[]>([]);
  const [pinned, setPinned] = useState(true);
  const [loading, setLoading] = useState(false);
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .log(300, level === "debug" ? undefined : level)
      .then((rows) => {
        if (!cancelled) setFetched(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) notify("error", err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [level, notify]);

  const rows = useMemo(() => {
    const seen = new Set<string>();
    const merged: LogLine[] = [];
    for (const line of [...lines, ...fetched]) {
      if (RANK[line.level] < RANK[level]) continue;
      const key = `${line.ts}|${line.level}|${line.msg}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(line);
    }
    return merged.sort((a, b) => b.ts.localeCompare(a.ts));
  }, [lines, fetched, level]);

  // Keep the viewport glued to the newest line only while the user is there.
  useEffect(() => {
    if (pinned && scroller.current) scroller.current.scrollTop = 0;
  }, [rows, pinned]);

  return (
    <div className="view view--log">
      <div className="log__bar">
        <div className="chips">
          {LEVELS.map((l) => (
            <button
              key={l.id}
              type="button"
              className={`chip ${level === l.id ? "chip--on" : ""}`}
              onClick={() => setLevel(l.id)}
            >
              {l.label}
            </button>
          ))}
        </div>
        {!pinned && (
          <button
            type="button"
            className="linkbtn"
            onClick={() => {
              if (scroller.current) scroller.current.scrollTop = 0;
              setPinned(true);
            }}
          >
            ↑ Uusimpiin
          </button>
        )}
      </div>

      <div
        className="log__scroll"
        ref={scroller}
        onScroll={(e) => setPinned(e.currentTarget.scrollTop < 24)}
      >
        {loading && rows.length === 0 && <p className="muted log__empty">Haetaan lokia…</p>}
        {!loading && rows.length === 0 && <p className="muted log__empty">Ei rivejä.</p>}
        <ul className="log__list">
          {rows.map((line, i) => (
            <li key={`${line.ts}-${i}`} className={`logrow logrow--${line.level}`}>
              <span className="logrow__ts num">{fiTimeSec(line.ts)}</span>
              <span className="logrow__level">{line.level}</span>
              <span className="logrow__msg">
                {line.code && <span className="logrow__code">{line.code}</span>}
                {line.msg}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
