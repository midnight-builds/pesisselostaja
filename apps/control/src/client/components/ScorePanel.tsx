import type { MatchState } from "../../shared/types";
import { periodName, periodShort } from "../format";

/** Scoreboard. One scoring marking = one run; per-period rows come straight
 *  from the server's derived state, we only lay them out. */

interface Props {
  match: MatchState;
}

export function ScorePanel({ match }: Props) {
  if (match.matchId == null) {
    return (
      <section className="card score score--empty">
        <p className="muted">Ei ottelua seurannassa.</p>
      </section>
    );
  }

  const home = match.home ?? "Koti";
  const away = match.away ?? "Vieras";
  const batting = match.battingTeam;
  const palot = match.palot ?? 0;

  return (
    <section className="card score">
      <div className="score__teams">
        <TeamColumn
          name={home}
          runs={match.totalHome}
          periods={match.periodsWonHome}
          batting={batting != null && batting === home}
        />
        <div className="score__mid">
          <span className="score__period">{periodName(match.currentPeriod)}</span>
          <span className="score__dash">–</span>
          {match.finished && <span className="score__finished">päättynyt</span>}
        </div>
        <TeamColumn
          name={away}
          runs={match.totalAway}
          periods={match.periodsWonAway}
          batting={batting != null && batting === away}
        />
      </div>

      {match.periodScores.length > 0 && (
        <div className="score__periods">
          {match.periodScores.map((p, i) => (
            <span key={i} className="score__chip">
              <span className="score__chip-label">{periodShort(i)}</span>
              <span className="num">
                {p.home}–{p.away}
              </span>
            </span>
          ))}
        </div>
      )}

      <div className="score__palot">
        <span className="score__palot-label">Palot</span>
        <span className="score__palot-dots">
          {[0, 1, 2].map((i) => (
            <span key={i} className={`palo ${i < palot ? "palo--on" : ""}`} />
          ))}
        </span>
        <span className="score__batting">
          {batting ? `${batting} sisävuorossa` : "sisävuoro ei tiedossa"}
        </span>
      </div>
    </section>
  );
}

function TeamColumn({
  name,
  runs,
  periods,
  batting,
}: {
  name: string;
  runs: number;
  periods: number;
  batting: boolean;
}) {
  return (
    <div className={`score__team ${batting ? "score__team--batting" : ""}`}>
      <span className="score__name">{name}</span>
      <span className="score__runs num">{runs}</span>
      <span className="score__pips">
        {[0, 1].map((i) => (
          <span key={i} className={`pip ${i < periods ? "pip--on" : ""}`} />
        ))}
      </span>
    </div>
  );
}
