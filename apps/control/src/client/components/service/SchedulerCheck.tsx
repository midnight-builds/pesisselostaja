import { useEffect, useState } from "react";
import type { SchedulerState } from "../../../shared/types";
import { api } from "../../api";

/** Käynnistysvahdin kytkin huoltoarkissa (#188, #208).
 *
 *  `StartGuard`in oma kommentti on aina sanonut että kytkin on täällä, mutta
 *  sitä ei ollut: `schedulerEnable` esiintyi koko clientissä kerran ja aina
 *  arvolla `true`, ja tila on pysyvä (`run/scheduler.json`). Ensimmäisen
 *  mountin jälkeen vahti oli siis päällä ikuisesti — myös palvelimen
 *  uudelleenkäynnistysten yli ja päivinä, joina kukaan ei ole kentällä.
 *
 *  `scheduler.ts` kirjaa säännön sanasta sanaan: *"OFF by default … a hand-run
 *  broadcast must never be ambushed by automation that woke up on its own."*
 *  Ilman kytkintä käsiajoa ei voi suojata, eikä kuiva-ajoa (`wouldHaveDone`,
 *  "Olisi tehnyt: …") pääse katsomaan kertaakaan ennen kuin vahti ohjaa
 *  relayta oikeassa ottelussa.
 *
 *  Huoltoarkissa eikä ottelupäivän polulla, koska tämä on kerran tehtävä
 *  valinta eikä ottelun aikana käytettävä säädin (#170). */

interface Props {
  notify: (kind: "ok" | "error", text: string) => void;
}

export function SchedulerCheck({ notify }: Props) {
  const [state, setState] = useState<SchedulerState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stopped = false;
    api.scheduler().then(
      (next) => !stopped && setState(next),
      () => !stopped && setState(null),
    );
    return () => {
      stopped = true;
    };
  }, []);

  const flip = async () => {
    if (!state || busy) return;
    setBusy(true);
    try {
      setState(await api.schedulerEnable(!state.enabled));
      notify(
        "ok",
        state.enabled
          ? "Käynnistysvahti kytketty pois — mitään ei käynnistetä itsestään."
          : "Käynnistysvahti kytketty päälle.",
      );
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Kuiva-ajon rivi on koko syy siihen, että vahdin uskaltaa kytkeä päälle:
  // pois päältä oleva ajastin laskee silti koko päätöksen ja kertoo mitä se
  // olisi tehnyt, kirjoittamatta mitään.
  const dryRun = state && !state.enabled ? state.wouldHaveDone : null;

  return (
    <section className="sheet__section" data-testid="scheduler-check">
      <h3 className="sheet__heading">Käynnistysvahti</h3>

      <p className={`sheet__lead ${state?.enabled ? "is-ok" : "is-warn"}`}>
        {state === null
          ? "Tarkistetaan…"
          : state.enabled
            ? "Selostus käynnistyy itsestään, kun raakalähetys alkaa."
            : "Vahti on pois päältä — mitään ei käynnistetä itsestään."}
      </p>

      {state && (
        <button
          type="button"
          className={`toggle ${state.enabled ? "toggle--on" : ""}`}
          role="switch"
          aria-checked={state.enabled}
          disabled={busy}
          onClick={() => void flip()}
          data-testid="scheduler-toggle"
        >
          <span className="toggle__label">Käynnistä selostus itsestään</span>
          <span className="toggle__hint">
            Pois päältä käsin ajettu lähetys on suojassa automatiikalta.
          </span>
        </button>
      )}

      {dryRun && <p className="sheet__note">Olisi tehnyt: {dryRun.reason}</p>}
    </section>
  );
}
