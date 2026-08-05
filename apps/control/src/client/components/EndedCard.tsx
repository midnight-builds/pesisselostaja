import type { Job, LiveState } from "../../shared/types";
import { duration, fiTime } from "../format";

/** Päättynyt-tila: siivous näkyviin (#187).
 *
 *  Ottelupäivä päättyy tähän korttiin. Sen tehtävä ei ole raportoida ottelua —
 *  tulokset ovat tulospalvelussa ja tallenne YouTubessa — vaan vastata siihen
 *  yhteen kysymykseen, jonka takia operaattori vielä avaa puhelimen: **jäikö
 *  jotain päälle?** Siksi kortissa on kolme asiaa ja tässä järjestyksessä:
 *
 *   1. mitä ohjaamo TEKI (#171: teot näkyviin, koska hard stop tehdään ilman
 *      vahvistusta — teko jota ei näytetä on teko jota ei voi tarkistaa);
 *   2. mistä lopetus pääteltiin (useampi riippumaton päättymisindikaattori);
 *   3. linkki tallenteeseen.
 *
 *  Epäonnistunut teko on ainoa käskymuotoinen rivi koko kortissa: silloin
 *  lähetys on yhä auki, eikä sitä sulje kukaan muu (#121:n roskaa työntävä
 *  lähetys). Kaikki muu on mennyttä aikamuotoa — kone kertoo mitä se teki.
 *
 *  Jälkihoitoa EI ole (#170): soittolista valitaan jo luontihetkellä (#177),
 *  joten tässä ei ole nappeja. Seuraavan ottelun valinta on kortin alla oleva
 *  valitsin, jonka kuori näyttää kaikille päättyneille töille (`isJobClosed`). */

interface Props {
  job: Job;
  live: LiveState | null;
}

/** Tallenteen osoite. Sama video kuin lähetys: YouTube tarjoilee päättyneen
 *  lähetyksen samalla watch-linkillä, joten uutta tietoa ei tarvita. */
function recordingUrl(job: Job): string | null {
  return job.targetVideoId ? `https://www.youtube.com/watch?v=${job.targetVideoId}` : null;
}

/** Kuinka kauan selostus oli ajossa. Molemmat päät työstä, ei kellosta: puhelin
 *  voi olla väärässä ajassa, ja väärä kesto kortissa lähettäisi etsimään vikaa
 *  ajosta joka meni hyvin. */
function ranFor(job: Job): string | null {
  if (!job.startedAt || !job.endedAt) return null;
  const from = Date.parse(job.startedAt);
  const to = Date.parse(job.endedAt);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return duration(Math.round((to - from) / 1000));
}

export function EndedCard({ job, live }: Props) {
  void live;
  const cleanup = job.cleanup;
  const url = recordingUrl(job);
  const ran = ranFor(job);
  const unfinished = cleanup?.actions.filter((action) => !action.ok) ?? [];

  return (
    <div className="ended" data-testid="ended-card">
      {/* Ilman siivousmerkintää ohjaamo ei ollut katsomassa kun ajo päättyi:
          sovittelu sulki työn jälkikäteen. Se on rehellinen tyhjä eikä vika,
          mutta silloin lähetysten tilasta ei ole näyttöä — ja juuri siitä on
          kysymys. */}
      {!cleanup && (
        <p className="ended__note" data-testid="ended-unwitnessed">
          Ohjaamo ei ollut katsomassa, kun lähetys päättyi. Tarkista YouTubesta, että
          molemmat lähetykset ovat päättyneet.
        </p>
      )}

      {cleanup && (
        <>
          <p className="ended__lead">
            {unfinished.length > 0
              ? "Lähetys päättyi, mutta jotain jäi kesken."
              : "Lähetys päättyi ja lähetykset ovat kiinni."}
          </p>

          <ul className="checks" data-testid="ended-actions">
            {/* Tyhjä tekolista EI ole puuttuva siivous vaan tavallisin
                lopputulos: normaalissa lopetuksessa selostetun lähetyksen
                sulkee YouTube itse, eikä raakalähetykseen kosketa koskaan
                ottelun päälle (CLAUDE.md). Se sanotaan ääneen, koska "ei
                rivejä" näyttäisi siltä että siivous unohtui. */}
            {cleanup.actions.length === 0 && (
              <li className="check check--ok">
                <span className="check__mark" aria-hidden="true">
                  ·
                </span>
                <span className="check__detail">
                  Ohjaamon ei tarvinnut koskea lähetyksiin — selostettu lähetys sulkeutui itse.
                </span>
              </li>
            )}
            {cleanup.actions.map((action) => (
              <li key={action.what} className={`check check--${action.ok ? "fixed" : "fail"}`}>
                <span className="check__mark" aria-hidden="true">
                  {action.ok ? "↺" : "✗"}
                </span>
                <span className="check__detail">
                  {action.what}
                  {action.detail ? ` ${action.detail}` : ""}
                </span>
              </li>
            ))}
          </ul>

          {/* Perusteet, eivät tekoja: nämä kertovat MISTÄ lopetus pääteltiin,
              ja kolme riippumatonta havaintoa on eri asia kuin yksi (#171). */}
          {cleanup.indicators.length > 0 && (
            <div className="ended__why" data-testid="ended-indicators">
              <p className="ended__whyLabel">Näin lopetus tunnistettiin</p>
              <ul className="ended__list">
                {cleanup.indicators.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <dl className="facts">
        <div className="fact fact--idle">
          <dt className="fact__label">Päättyi</dt>
          <dd className="fact__value">{job.endedAt ? `klo ${fiTime(job.endedAt)}` : "–"}</dd>
        </div>
        <div className="fact fact--idle">
          <dt className="fact__label">Kesto</dt>
          <dd className="fact__value">{ran ?? "–"}</dd>
        </div>
      </dl>

      {url ? (
        <a className="btn btn--ghost btn--wide" href={url} target="_blank" rel="noreferrer">
          Avaa tallenne
        </a>
      ) : (
        <p className="muted">Tallenteen osoitetta ei ole tiedossa.</p>
      )}
    </div>
  );
}
