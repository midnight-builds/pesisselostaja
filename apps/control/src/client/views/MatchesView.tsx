import { useCallback, useEffect, useState } from "react";
import type { DayMatches, MatchOption } from "../../shared/types";
import { api } from "../api";
import { fiDate, fiTime, parseMatchId, shiftIsoDate, todayInFinland } from "../format";

/** Day → stadium → tick the matches. A day can hold 200 matches across 30
 *  series, so the filters are not optional decoration. */

interface Props {
  notify: (kind: "ok" | "error", text: string) => void;
  onJobCreated: () => void;
}

const ALL = "__all__";

export function MatchesView({ notify, onJobCreated }: Props) {
  const [date, setDate] = useState(todayInFinland);
  const [day, setDay] = useState<DayMatches | null>(null);
  const [loading, setLoading] = useState(false);
  const [stadium, setStadium] = useState<string>(ALL);
  const [series, setSeries] = useState<string>(ALL);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (target: string) => {
      setLoading(true);
      try {
        const data = await api.matches(target);
        setDay(data);
      } catch (err) {
        setDay(null);
        notify("error", err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [notify],
  );

  useEffect(() => {
    setPicked(new Set());
    setStadium(ALL);
    setSeries(ALL);
    void load(date);
  }, [date, load]);

  const matches = (day?.matches ?? [])
    .filter((m) => stadium === ALL || m.stadium === stadium)
    .filter((m) => series === ALL || m.seriesName === series)
    .slice()
    .sort((a, b) => (a.startsAt ?? "").localeCompare(b.startsAt ?? ""));

  const toggle = (id: number) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  const createJobs = async (ids: number[]) => {
    if (ids.length === 0) return;
    setBusy(true);
    let created = 0;
    try {
      for (const matchId of ids) {
        await api.createJob({ matchId });
        created += 1;
      }
      notify("ok", created === 1 ? "Työ luotu" : `${created} työtä luotu`);
      setPicked(new Set());
      setManual("");
      onJobCreated();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify("error", created > 0 ? `${created} luotu, sitten virhe: ${msg}` : msg);
    } finally {
      setBusy(false);
    }
  };

  const manualId = parseMatchId(manual);

  return (
    <div className="view">
      <section className="card">
        <h2 className="card__title">Päivä</h2>
        <div className="dayrow">
          <button type="button" className="btn btn--ghost" onClick={() => setDate(shiftIsoDate(date, -1))}>
            ‹
          </button>
          <input
            className="field__input dayrow__input"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <button type="button" className="btn btn--ghost" onClick={() => setDate(shiftIsoDate(date, 1))}>
            ›
          </button>
        </div>
        <p className="field__hint">
          {fiDate(`${date}T12:00:00Z`)} · ajat Suomen aikaa
          {date !== todayInFinland() && (
            <button type="button" className="linkbtn" onClick={() => setDate(todayInFinland())}>
              tänään
            </button>
          )}
        </p>
      </section>

      <section className="card">
        <h2 className="card__title">Suodattimet</h2>
        <Select
          label="Kenttä"
          value={stadium}
          options={day?.stadiums ?? []}
          onChange={setStadium}
          allLabel="Kaikki kentät"
        />
        <Select
          label="Sarja"
          value={series}
          options={day?.seriesNames ?? []}
          onChange={setSeries}
          allLabel="Kaikki sarjat"
        />
      </section>

      <section className="card">
        <h2 className="card__title">
          Ottelut {day && <span className="muted">({matches.length})</span>}
        </h2>
        {loading && <p className="muted">Haetaan…</p>}
        {!loading && matches.length === 0 && <p className="muted">Ei otteluita näillä suodattimilla.</p>}
        <ul className="mlist">
          {matches.map((m) => (
            <MatchRow key={m.id} match={m} checked={picked.has(m.id)} onToggle={() => toggle(m.id)} />
          ))}
        </ul>
      </section>

      <section className="card">
        <h2 className="card__title">Ottelu-ID tai osoite</h2>
        <input
          className="field__input"
          type="text"
          inputMode="text"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="146210 tai https://www.pesistulokset.fi/…"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
        />
        <p className="field__hint">
          {manual.trim().length === 0
            ? "Liitä osoite tai kirjoita ID."
            : manualId != null
              ? `Tunnistettu ottelu-ID ${manualId}`
              : "Osoitteesta ei löydy ottelu-ID:tä."}
        </p>
        <button
          type="button"
          className="btn btn--primary btn--wide"
          disabled={busy || manualId == null}
          onClick={() => manualId != null && void createJobs([manualId])}
        >
          Luo työ ID:stä
        </button>
      </section>

      <div className="sticky-action">
        <button
          type="button"
          className="btn btn--primary btn--wide"
          disabled={busy || picked.size === 0}
          onClick={() => void createJobs([...picked])}
        >
          {picked.size === 0 ? "Luo työ" : `Luo työ (${picked.size})`}
        </button>
      </div>
    </div>
  );
}

function MatchRow({
  match,
  checked,
  onToggle,
}: {
  match: MatchOption;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={`mrow ${checked ? "mrow--on" : ""}`}
        onClick={onToggle}
        aria-pressed={checked}
      >
        <span className={`checkbox ${checked ? "checkbox--on" : ""}`} aria-hidden="true" />
        <span className="mrow__time num">{fiTime(match.startsAt)}</span>
        <span className="mrow__body">
          <span className="mrow__teams">
            {match.home} – {match.away}
          </span>
          <span className="mrow__meta">
            {[match.seriesName, match.stadium].filter(Boolean).join(" · ") || "—"}
          </span>
        </span>
        {match.status === "live" && <span className="tag tag--live">LIVE</span>}
        {match.status === "finished" && <span className="tag">{match.resultString ?? "päättyi"}</span>}
      </button>
    </li>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
  allLabel,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  allLabel: string;
}) {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <select className="field__input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value={ALL}>{allLabel}</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </div>
  );
}
