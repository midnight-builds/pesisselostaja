import { useCallback, useEffect, useState } from "react";
import type { SchedulerDecision, SchedulerState } from "../../shared/types";
import { api } from "../api";
import { fiTimeSec } from "../format";
import { ConfirmButton } from "./ConfirmButton";

/** Ajastin: näyttää mitä se tekisi, ja antaa kytkeä sen päälle.
 *
 *  Ajastin on ollut palvelimella valmiina mutta ilman käyttöliittymää, eli
 *  ainoa tapa kytkeä se oli `curl`. Se ei ollut vahinko vaan varotoimi:
 *  automaattinen relayn käynnistys on juuri se asia joka ei saa yllättää
 *  kesken aamun lähetyksen. Tämä kortti pitää saman varovaisuuden voimassa
 *  kolmella tavalla:
 *
 *  1. **Oletus on pois päältä** ja pysyy sellaisena — kortti ei koskaan kytke
 *     itseään, se vain näyttää tilan jonka palvelin kertoo.
 *  2. **`wouldHaveDone` on näkyvin asia kortissa.** Se on kuivaharjoitus:
 *     mitä ajastin OLISI tehnyt juuri nyt, ilman yhtään sivuvaikutusta.
 *     Operaattorin kuuluu katsoa sitä ottelun tai kaksi ennen kuin luottaa.
 *  3. **Päälle kytkeminen vaatii vahvistuksen**, pois kytkeminen ei. Se on
 *     tarkoituksellisen epäsymmetristä: virittäminen antaa koneelle luvan
 *     aloittaa lähetys itse, purkaminen vain ottaa luvan pois. */

/** Tyypitetty SchedulerDecisionilla, ei stringillä: uusi päätöslaji rikkoo
 *  typecheckin sen sijaan että ruudulle ilmestyisi raaka tunniste. */
const DECISION_WORDS: Record<SchedulerDecision, string> = {
  idle: "ei työtä jota odottaa",
  waiting: "odottaa lähteen alkamista",
  start: "käynnistäisi relayn",
  "blocked-preflight": "preflight esti",
  "blocked-disk": "levytila kriittinen",
  "blocked-busy": "toinen ajo on kesken",
  "source-error": "lähteestä ei saatu selvää",
  "start-failed": "käynnistys epäonnistui",
};

export function SchedulerCard({ notify }: { notify: (kind: "ok" | "error", text: string) => void }) {
  const [state, setState] = useState<SchedulerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await api.scheduler());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    // Ajastimen tila ei kulje SSE:ssä, joten se haetaan omalla kevyellä
    // pollilla. 10 s riittää: kortti kertoo päätöksiä, ei sekuntikelloa.
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const setEnabled = async (enabled: boolean) => {
    setBusy(true);
    try {
      setState(await api.schedulerEnable(enabled));
      notify("ok", enabled ? "Ajastin kytketty päälle." : "Ajastin kytketty pois päältä.");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <section className="card">
        <h2 className="card__title">Ajastin</h2>
        <div className="warnbox warnbox--fail">{error}</div>
      </section>
    );
  }

  if (!state) {
    return (
      <section className="card">
        <h2 className="card__title">Ajastin</h2>
        <p className="muted">Haetaan…</p>
      </section>
    );
  }

  // Pois päältä ollessa kuivaharjoitus on se joka kertoo totuuden; päällä
  // ollessa se on lastAction. Sama kenttä ruudulla, eri lähde.
  const shown = state.enabled ? state.lastAction : state.wouldHaveDone;

  return (
    <section className="card" data-card="scheduler">
      <h2 className="card__title">Ajastin</h2>

      <div className={`statusline statusline--${state.enabled ? "on" : "off"}`}>
        <strong>{state.enabled ? "PÄÄLLÄ" : "POIS PÄÄLTÄ"}</strong>
        <span className="muted">
          {state.enabled
            ? "Ajastin saa käynnistää relayn itse."
            : "Ajastin laskee päätökset mutta ei tee mitään."}
        </span>
      </div>

      {state.nextJob ? (
        <dl className="kv">
          <dt>Seuraava työ</dt>
          <dd>
            {state.nextJob.home} – {state.nextJob.away}
            {state.nextJob.startsAt && ` klo ${fiTimeSec(state.nextJob.startsAt)}`}
          </dd>
          <dt>Lähde</dt>
          <dd>{state.nextJob.sourceDetail ?? state.nextJob.sourceState}</dd>
        </dl>
      ) : (
        <p className="muted">Ei työtä jota odottaa.</p>
      )}

      {shown && (
        <div className="warnbox">
          <strong>
            {state.enabled ? "Viimeisin päätös" : "Olisi tehnyt"}: {DECISION_WORDS[shown.decision]}
          </strong>
          <span className="warnbox__detail">{shown.reason}</span>
          <span className="muted">
            {fiTimeSec(shown.at)}
            {!shown.applied && " — pelkkä laskelma, ei sivuvaikutuksia"}
          </span>
        </div>
      )}

      <p className="muted">
        Tarkistettu {fiTimeSec(state.lastCheckAt)}, seuraava {Math.round(state.nextCheckInMs / 1000)} s kuluttua.
      </p>

      {state.enabled ? (
        <button type="button" className="btn btn--wide" disabled={busy} onClick={() => void setEnabled(false)}>
          Kytke ajastin pois
        </button>
      ) : (
        <ConfirmButton
          className="btn--wide"
          label="Kytke ajastin päälle"
          confirmLabel="Varmista: kone saa käynnistää lähetyksen"
          disabled={busy}
          onConfirm={() => void setEnabled(true)}
        />
      )}
    </section>
  );
}
