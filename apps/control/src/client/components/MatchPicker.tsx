import { useCallback, useEffect, useState } from "react";
import type { DayMatches, MatchOption } from "../../shared/types";
import { api } from "../api";
import { isSelectableStart } from "../../shared/jobState";
import { fiDate, fiTime, isPastMatch, parseMatchId, shiftIsoDate, todayInFinland } from "../format";

/** Ottelun valinta — etusivu silloin kun aktiivista ottelua ei ole (#173).
 *
 *  Valinta ON työn luonti: erillistä "Luo työ" -vahvistusta ei ole (#171/4),
 *  eikä valinta ole monivalinta niin kuin vanhassa Ottelut-välilehdessä. Yksi
 *  napautus = yksi ottelu = yksi työ, ja siitä eteenpäin etusivu on sen työn
 *  tilakortti.
 *
 *  Suodattimet eivät ole koristetta: leiripäivänä päivässä on ~200 ottelua
 *  kolmellakymmenellä kentällä, ja ajastettava hukkuu listaan ilman niitä.
 *  Menneet piilotetaan oletuksena samasta syystä (#128). */

interface Props {
  notify: (kind: "ok" | "error", text: string) => void;
  /** Kutsutaan kun työ on luotu palvelimelle. Valinnan totuuslähde on
   *  palvelin, joten tässä ei palauteta mitään tilaa — vain luotu työ, jonka
   *  kuori näyttää siihen asti kunnes sama työ saapuu SSE-virrassa. */
  onSelected: (job: Awaited<ReturnType<typeof api.createJob>>) => void;
}

const ALL = "__all__";

export function MatchPicker({ notify, onSelected }: Props) {
  const [date, setDate] = useState(todayInFinland);
  const [day, setDay] = useState<DayMatches | null>(null);
  const [loading, setLoading] = useState(false);
  const [stadium, setStadium] = useState(ALL);
  const [series, setSeries] = useState(ALL);
  const [showPast, setShowPast] = useState(false);
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (target: string) => {
      setLoading(true);
      try {
        setDay(await api.matches(target));
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
    setStadium(ALL);
    setSeries(ALL);
    void load(date);
  }, [date, load]);

  const select = async (matchId: number) => {
    if (busy) return;
    setBusy(true);
    try {
      const job = await api.createJob({ matchId });
      // Käsin syötetyn ottelu-ID:n aloitusaika tiedetään vasta nyt: jos ottelu
      // alkoi liian kauan sitten, palvelin ei pitäisi tätä työtä valintana ja
      // kortti jäisi näyttämään valmistelua jota ei ole. Sanotaan se ääneen ja
      // siivotaan syntynyt työ pois.
      if (!isSelectableStart(job.startsAt, Date.now())) {
        await api.patchJob(job.id, { status: "cancelled" }).catch(() => undefined);
        notify("error", `${job.home} – ${job.away} alkoi liian kauan sitten — sitä ei voi enää selostaa.`);
        return;
      }
      setManual("");
      onSelected(job);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const filtered = (day?.matches ?? [])
    .filter((m) => stadium === ALL || m.stadium === stadium)
    .filter((m) => series === ALL || m.seriesName === series)
    .slice()
    .sort((a, b) => (a.startsAt ?? "").localeCompare(b.startsAt ?? ""));

  // Luetaan renderissä eikä tilasta: lista päivittyy päivän vaihtuessa ja
  // suodattimia koskettaessa, eikä minuutin tarkkuus ole tässä arvokkaampi
  // kuin ajastin joka herättäisi näkymän taustalla.
  const nowMs = Date.now();
  // Käynnissä olevaa ottelua ei piiloteta koskaan: juuri siihen voi joutua
  // palaamaan kesken päivän.
  const matches = filtered.filter(
    (m) => showPast || m.status === "live" || !isPastMatch(m.startsAt, nowMs),
  );
  const hiddenCount = filtered.length - matches.length;
  const manualId = parseMatchId(manual);

  return (
    <section className="card picker">
      <h2 className="card__title">Valitse ottelu</h2>

      <div className="dayrow">
        <button type="button" className="btn btn--ghost" aria-label="Edellinen päivä" onClick={() => setDate(shiftIsoDate(date, -1))}>
          ‹
        </button>
        <input
          className="field__input dayrow__input"
          type="date"
          aria-label="Päivä"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <button type="button" className="btn btn--ghost" aria-label="Seuraava päivä" onClick={() => setDate(shiftIsoDate(date, 1))}>
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

      <div className="picker__filters">
        <Select label="Kenttä" value={stadium} options={day?.stadiums ?? []} onChange={setStadium} allLabel="Kaikki kentät" />
        <Select label="Sarja" value={series} options={day?.seriesNames ?? []} onChange={setSeries} allLabel="Kaikki sarjat" />
      </div>

      {loading && <p className="muted">Haetaan…</p>}
      {!loading && matches.length === 0 && <p className="muted">Ei otteluita näillä suodattimilla.</p>}

      <ul className="mlist">
        {matches.map((m) => (
          <MatchRow
            key={m.id}
            match={m}
            /* Ottelua, jota ei enää selosteta, ei tarjota valittavaksi: palvelin
               ei pitäisi sellaista työtä valintana (getActiveJob), joten
               napautus näyttäisi tekevän jotain ja tila palaisi tähän ilman
               selitystä. Rivi jää näkyviin, koska päivän kulku on tietoa. */
            tooLate={!isSelectableStart(m.startsAt, nowMs)}
            disabled={busy}
            onSelect={() => void select(m.id)}
          />
        ))}
      </ul>

      {/* Kytkin on näkyvissä aina, myös kun piilotettavaa ei ole: menneen
          päivän kohdalla kaikki ottelut ovat menneitä, ja ilman näkyvää
          kytkintä lista näyttäisi vain tyhjältä — piilotettua ei osaa etsiä. */}
      <button type="button" className="linkbtn picker__past" onClick={() => setShowPast(!showPast)}>
        {showPast
          ? "Piilota menneet ottelut"
          : hiddenCount > 0
            ? `Näytä menneet (${hiddenCount})`
            : "Näytä menneet"}
      </button>

      <div className="picker__manual">
        <span className="field__label">Ottelu-ID tai osoite</span>
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
            ? "Jos ottelu ei näy listassa, liitä sen osoite."
            : manualId != null
              ? `Tunnistettu ottelu-ID ${manualId}`
              : "Osoitteesta ei löydy ottelu-ID:tä."}
        </p>
        <button
          type="button"
          className="btn btn--primary btn--wide"
          disabled={busy || manualId == null}
          onClick={() => manualId != null && void select(manualId)}
        >
          Valitse tämä ottelu
        </button>
      </div>
    </section>
  );
}

function MatchRow({
  match,
  tooLate,
  disabled,
  onSelect,
}: {
  match: MatchOption;
  tooLate: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button type="button" className="mrow" disabled={disabled || tooLate} onClick={onSelect}>
        <span className="mrow__time num">{fiTime(match.startsAt)}</span>
        <span className="mrow__body">
          <span className="mrow__teams">
            {match.home} – {match.away}
          </span>
          <span className="mrow__meta">
            {tooLate
              ? "Alkoi liian kauan sitten — ei enää selostettavissa"
              : [match.seriesName, match.stadium].filter(Boolean).join(" · ") || "—"}
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
      <select className="field__input" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
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
