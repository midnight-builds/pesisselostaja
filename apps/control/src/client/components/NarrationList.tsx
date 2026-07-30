import type { NarrationLine, RelayProcess, RelayTelemetry } from "../../shared/types";
import { fiTimeSec } from "../format";

/** Two-phase list, straight from the relay's timeline (issue #97): a line
 *  appears dim when the relay DECIDED to say it and lights up when the clip
 *  actually reached the mixer. A third state, muted, is the one that matters
 *  most — the relay said it while ffmpeg was not attached, so nobody heard it. */

interface Props {
  lines: NarrationLine[];
  /** Null when the relay has published no telemetry for this match. With the
   *  relay running that means an old deploy, and an empty list would otherwise
   *  read as "nothing has been said". */
  telemetry: RelayTelemetry | null;
  relay: RelayProcess;
  limit?: number;
}

export function NarrationList({ lines, telemetry, relay, limit = 12 }: Props) {
  // The relay's own order, newest at the top. Deliberately NOT sorted by
  // timestamp: several clips can land inside the same second, and sorting on a
  // shared timestamp shuffled them (#98).
  const newestFirst = lines.slice(-limit).reverse();
  const missingTelemetry = telemetry === null && relay.active;

  return (
    <section className="card narration">
      <h2 className="card__title">Selostukset</h2>
      {missingTelemetry && (
        <p className="muted">
          Relay ei julkaise telemetriaa — aja <code>npm run relay:deploy</code> ajokopion päivittämiseksi.
        </p>
      )}
      {!missingTelemetry && newestFirst.length === 0 && <p className="muted">Ei selostuksia vielä.</p>}
      <ul className="narration__list">
        {newestFirst.map((line) => {
          const state = line.muted ? "muted" : line.spokenAt ? "spoken" : "queued";
          return (
            <li key={line.id} className={`narration__row narration__row--${state}`}>
              <span className="narration__time num">
                {fiTimeSec(line.spokenAt ?? line.detectedAt)}
              </span>
              <span className="narration__text">{line.text}</span>
              {state === "queued" && <span className="narration__tag">jonossa</span>}
              {state === "muted" && (
                <span className="narration__tag narration__tag--muted">ei kuulunut</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
