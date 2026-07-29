import type { NarrationLine } from "../../shared/types";
import { fiTimeSec } from "../format";

/** Two-phase list: a line appears dim when the event is detected and lights up
 *  when the relay actually speaks it. Phase A telemetry never sets spokenAt,
 *  so in practice everything renders "jonossa" for now — both states are built
 *  so phase B needs no UI work. */

interface Props {
  lines: NarrationLine[];
  limit?: number;
}

export function NarrationList({ lines, limit = 12 }: Props) {
  const newestFirst = [...lines]
    .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))
    .slice(0, limit);

  return (
    <section className="card narration">
      <h2 className="card__title">Selostukset</h2>
      {newestFirst.length === 0 && <p className="muted">Ei selostuksia vielä.</p>}
      <ul className="narration__list">
        {newestFirst.map((line) => {
          const spoken = line.spokenAt != null;
          return (
            <li
              key={line.id}
              className={`narration__row ${spoken ? "narration__row--spoken" : "narration__row--queued"}`}
            >
              <span className="narration__time num">
                {fiTimeSec(spoken ? line.spokenAt : line.detectedAt)}
              </span>
              <span className="narration__text">{line.text}</span>
              {!spoken && <span className="narration__tag">jonossa</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
