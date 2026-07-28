import type { Health } from "../../shared/types";
import type { LiveConnectionStatus } from "../api";

/** The first thing read in bright sunlight: a colour, a word, one sentence.
 *  Everything else on the live view is secondary to this block. */

const WORDS: Record<Health, string> = {
  ok: "Kunnossa",
  warn: "Huomio",
  fail: "Vika",
  idle: "Valmiudessa",
};

interface Props {
  health: Health;
  headline: string;
  sub?: string | null;
  connection: LiveConnectionStatus;
}

export function HealthBanner({ health, headline, sub, connection }: Props) {
  return (
    <section className={`health health--${health}`} aria-live="polite">
      <div className="health__top">
        <span className="health__word">{WORDS[health]}</span>
        {connection !== "open" && (
          <span className="health__conn">
            {connection === "connecting" ? "yhdistetään…" : "yhteys poikki"}
          </span>
        )}
      </div>
      <p className="health__headline">{headline}</p>
      {sub && <p className="health__sub">{sub}</p>}
    </section>
  );
}
