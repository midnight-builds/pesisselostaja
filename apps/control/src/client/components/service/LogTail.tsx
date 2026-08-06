import { useCallback, useEffect, useState } from "react";
import type { LiveState, LogLine } from "../../../shared/types";
import { api } from "../../api";
import { bytes, fiTimeSec } from "../../format";

/** Loki ja koneen tila huoltoarkissa (#188).
 *
 *  Tämä on ohjaamon **ainoa tekninen taso** (#176): SSH:ta ei käytetä, joten
 *  jokaisen vianetsinnän on onnistuttava täältä. Siksi lokirivit näytetään
 *  sellaisenaan, koneen kielellä — kääntäminen operaattorin kielelle tehdään
 *  ottelupäivän polulla, ja se on juuri se, mitä täällä ei haluta.
 *
 *  Sama koskee palvelimen `headline`-lausetta: se ei päädy tilakorttiin (#186),
 *  koska se puhuu ffmpeg-koodeista ja commit-tunnisteista. Täällä se on
 *  arvokas, koska se on tiivistelmä siitä mitä kone ajattelee juuri nyt.
 *
 *  Vuotorajaus pysyy: rivit tulevat palvelimelta eikä käyttöliittymä lisää
 *  niihin polkuja, env-arvoja eikä stream keytä (#176). */

interface Props {
  live: LiveState | null;
}

type Level = "" | "info" | "warn" | "error";

const LEVELS: Array<{ value: Level; label: string }> = [
  { value: "", label: "Kaikki" },
  { value: "info", label: "Tapahtumat" },
  { value: "warn", label: "Varoitukset" },
  { value: "error", label: "Virheet" },
];

export function LogTail({ live }: Props) {
  const [level, setLevel] = useState<Level>("");
  const [lines, setLines] = useState<LogLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(async (which: Level) => {
    try {
      setLines(await api.log(80, which === "" ? undefined : which));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void read(level);
  }, [read, level]);

  return (
    <section className="sheet__section" data-testid="log-tail">
      <h3 className="sheet__heading">Loki</h3>

      {/* Koneen tila yhtenä rivinä: levytila on se, joka kaataa ajon
          hiljaisimmin, ja headline kertoo mistä kone itse on huolissaan. */}
      {live && (
        <p className="sheet__note" data-testid="machine-state">
          Levytilaa {bytes(live.system.diskFreeBytes)} vapaana. {live.headline}
        </p>
      )}

      <div className="sheet__filters">
        {LEVELS.map((option) => (
          <button
            key={option.value || "all"}
            type="button"
            className={`chip ${level === option.value ? "chip--on" : ""}`}
            onClick={() => setLevel(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {error && <p className="sheet__lead is-fail">Lokia ei saada luettua: {error}</p>}

      {lines && lines.length === 0 && <p className="muted">Ei rivejä tällä suodattimella.</p>}

      {lines && lines.length > 0 && (
        <ul className="logtail" data-testid="log-lines">
          {lines.map((line, index) => (
            <li key={`${line.ts}-${index}`} className={`logtail__row logtail__row--${line.level}`}>
              <span className="logtail__time num">{fiTimeSec(line.ts)}</span>
              {/* Lähde näkyviin, koska loki on nyt kahden unitin lomitus (#232):
                  relayn rivit kertovat mitä lähetykselle tapahtui, ohjaamon
                  rivit mitä ohjaamo päätti. Vanha palvelin ei lähetä kenttää,
                  ja silloin rivi näytetään ilman merkintää — arvaus "relay"
                  olisi juuri se valhe, jota tässä ollaan poistamassa. */}
              <span className="logtail__unit">{line.unit === "control" ? "ohjaamo" : line.unit === "relay" ? "relay" : ""}</span>
              <span className="logtail__msg">{line.msg}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
