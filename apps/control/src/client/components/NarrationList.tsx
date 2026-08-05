import type { NarrationLine } from "../../shared/types";
import { fiTimeSec } from "../format";

/** Selostuslista — ottelunaikaisen kertasilmäyksen diagnoosiväline (#170).
 *
 *  Kaksivaiheinen lista suoraan relayn omalta aikajanalta (#97): rivi ilmestyy
 *  vaimeana kun relay PÄÄTTI sanoa sen ja kirkastuu kun klippi oikeasti pääsi
 *  mikseriin. Kolmas tila, "ei kuulunut", on se joka merkitsee eniten — relay
 *  puhui ffmpegin ollessa irti, eikä kukaan kuullut.
 *
 *  Tämä on ainoa ottelunaikainen lohko, jonka pituutta ei voi rajata etukäteen,
 *  joten se vierii sisäisesti. Sivu itse ei vieri (#173): viisi tietoa ja kaksi
 *  säätöä pysyvät paikoillaan silloinkin kun lista on täynnä. */

interface Props {
  lines: NarrationLine[];
  /** Näytetään vain uusimmat: puhelimen ruudulle mahtuu muutama, ja vanhemmat
   *  ovat lokin asia. Uusin ylimpänä, relayn omassa järjestyksessä — EI
   *  aikaleiman mukaan lajiteltuna, koska useampi klippi osuu samaan sekuntiin
   *  ja lajittelu sekoitti ne (#98). */
  limit?: number;
}

export function NarrationList({ lines, limit = 20 }: Props) {
  const newestFirst = lines.slice(-limit).reverse();

  return (
    <section className="narration" data-testid="narration-list">
      <h2 className="card__title">Selostukset</h2>
      {newestFirst.length === 0 && <p className="muted">Ei selostuksia vielä.</p>}
      <ul className="narration__list">
        {newestFirst.map((line) => {
          const state = line.muted ? "muted" : line.spokenAt ? "spoken" : "queued";
          return (
            <li key={line.id} className={`narration__row narration__row--${state}`}>
              <span className="narration__time num">{fiTimeSec(line.spokenAt ?? line.detectedAt)}</span>
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
