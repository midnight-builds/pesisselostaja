import { useEffect, useState } from "react";
import type { ControlKnobs, LiveState, MatchState, RelayTelemetry } from "../../shared/types";
import { api } from "../api";
import { periodName, seconds } from "../format";
import { NarrationList } from "./NarrationList";

/** Ottelunaikainen kertasilmäys (#186).
 *
 *  Ottelun aikana ohjaamo on VIANEPÄILYN KERTASILMÄYS, ei työpöytä (#170):
 *  operaattori vilkaisee puhelinta kesken kuvaamisen, kysyy "kuuluuko selostus
 *  ja näkyykö kuva", ja laittaa puhelimen taskuun. Siksi tässä on täsmälleen
 *  se, mitä inventaario (#169) löysi ottelun aikana oikeasti katsotuksi ja
 *  kosketuksi — viisi tietoa ja kaksi säätöä — eikä mitään muuta:
 *
 *    1. selostuksen tila   2. raakalähetys   3. pistetilanne
 *    4. jakso ja palot     5. sisävuoro
 *    säädöt: selostuksen ajoitus, vaihtoselostus
 *
 *  Alla selostuslista, joka on tämän näkymän diagnoosiväline: se kertoo mitä
 *  selostus sanoi ja kuuliko sitä kukaan. Se on ainoa lohko joka vierii —
 *  viisi tietoa ja kaksi säätöä pysyvät paikoillaan 393 px:n ruudulla (#173).
 *
 *  **Ohjaamosta relayyn on täsmälleen kaksi kosketuspintaa** (#172): `.env.relay`
 *  ja relayn control-tiedosto. Molemmat säädöt tässä menevät jälkimmäistä tietä
 *  olemassa olevien reittien kautta (`/api/knobs`, `/api/knobs/delay-nudge`);
 *  uutta HTTP-kanavaa relayyn ei saa rakentaa, koska relay ajetaan pinnatusta
 *  deployista joka voi olla ohjaamoa vanhempi (#59). */

/** Yhden kertasilmäysrivin sävy. Sama kolmijako kuin muualla kortissa. */
type Tone = "ok" | "warn" | "fail" | "idle";

interface Fact {
  label: string;
  value: string;
  tone: Tone;
}

/** Kuuluuko selostus juuri nyt.
 *
 *  Tärkein yksittäinen tieto koko ottelun aikana: relayn oma kirjanpito voi
 *  näyttää täydeltä ajolta silloinkin kun ffmpeg on irti eikä yksikään klippi
 *  päädy lähetykseen — ottelun 145889 viisi hiljaista minuuttia. Siksi
 *  `readerAttached` on oma punainen rivinsä eikä yksi luku muiden joukossa. */
function narrationFact(telemetry: RelayTelemetry | null, relayActive: boolean): Fact {
  if (!relayActive) return { label: "Selostus", value: "Ei ajossa", tone: "fail" };
  if (!telemetry) return { label: "Selostus", value: "Ei tietoa", tone: "warn" };
  if (!telemetry.readerAttached) {
    return { label: "Selostus", value: "Ei kuulu lähetyksessä", tone: "fail" };
  }
  if (telemetry.pendingClips >= QUEUE_WARN_CLIPS) {
    return { label: "Selostus", value: `Jää jälkeen (${telemetry.pendingClips} jonossa)`, tone: "warn" };
  }
  return { label: "Selostus", value: "Kuuluu lähetyksessä", tone: "ok" };
}

/** Sama raja kuin palvelimen tilarivillä (`live.ts`): kymmenen jonossa olevaa
 *  klippiä tarkoittaa että selostus laahaa kuvan perässä. */
const QUEUE_WARN_CLIPS = 10;

/** Näkyykö kuvauspuhelimen raakalähetys.
 *
 *  Relayn oma `source.detail` EI päädy tänne: se puhuu yt-dlp:n ja ffmpegin
 *  kielellä, eikä sellaista näytetä ottelupäivän polulla (#176). Jokaisella
 *  tilalla on täsmälleen yksi operaattorin lause. */
function sourceFact(telemetry: RelayTelemetry | null): Fact {
  const label = "Raakalähetys";
  if (!telemetry) return { label, value: "Ei tietoa", tone: "warn" };
  switch (telemetry.source.state) {
    case "live":
      return { label, value: "Kuva tulee kentältä", tone: "ok" };
    case "scheduled":
    case "resolving":
      return { label, value: "Kuvaa ei vielä näy", tone: "warn" };
    case "reconnecting":
      return { label, value: "Kuva katkesi — yhdistetään uudelleen", tone: "warn" };
    case "no_signal":
      // Katvekuva päällä (#104): ulospäin lähetys näyttää sujuvalta, mutta kuva
      // on poikki. Tämä on juuri se tila jonka ei saa näyttää vihreältä.
      return { label, value: "Kuva poikki, selostus jatkuu", tone: "warn" };
    case "ended":
      return telemetry.match.finished
        ? { label, value: "Kuvaus päättyi — lähetys lopetetaan", tone: "ok" }
        : { label, value: "Kuvaus loppui kesken ottelun", tone: "warn" };
    case "failed":
      return { label, value: "Kuvaa ei saada", tone: "fail" };
    default:
      return { label, value: "Ei tietoa", tone: "warn" };
  }
}

/** Pistetilanne, jakso ja palot, sisävuoro — kolme tietoa samasta ottelusta.
 *  Yksi merkintä = yksi juoksu; palvelin on jo laskenut nämä, tässä ne vain
 *  asetellaan (CLAUDE.md, `runValueOfSubEvent`). */
function matchFacts(match: MatchState): Fact[] {
  if (match.matchId == null) {
    return [
      { label: "Pisteet", value: "–", tone: "idle" },
      { label: "Jakso", value: "–", tone: "idle" },
      { label: "Sisävuoro", value: "Ei tietoa", tone: "idle" },
    ];
  }
  const home = match.home ?? "Koti";
  const away = match.away ?? "Vieras";
  const palot = match.palot;
  return [
    { label: "Pisteet", value: `${home} ${match.totalHome} – ${match.totalAway} ${away}`, tone: "idle" },
    {
      label: "Jakso",
      // Palot kuuluvat vain sisävuorossa olevalle ja nollautuvat joka vuoron
      // vaihdossa, joten ne luetaan aina jakson vierellä eikä omana lukunaan.
      value: palot == null ? periodName(match.currentPeriod) : `${periodName(match.currentPeriod)}, ${palot} paloa`,
      tone: "idle",
    },
    {
      label: "Sisävuoro",
      value: match.battingTeam ?? "Ei tietoa",
      tone: match.battingTeam ? "idle" : "warn",
    },
  ];
}

interface Props {
  live: LiveState;
  notify: (kind: "ok" | "error", text: string) => void;
}

export function MatchGlance({ live, notify }: Props) {
  const [busy, setBusy] = useState(false);
  /** Juuri lähetetty säätö, jota SSE ei ole vielä ehtinyt kertoa takaisin.
   *  Ilman tätä nappi näyttäisi sekunnin ajan siltä ettei se tehnyt mitään —
   *  ja viivettä säädetään korvakuulolta, monta napautusta peräkkäin. */
  const [pending, setPending] = useState<ControlKnobs | null>(null);
  const served = live.knobs;

  useEffect(() => {
    if (!pending || !served) return;
    if (
      served.narrationDelayMs === pending.narrationDelayMs &&
      served.announceBatterChanges === pending.announceBatterChanges
    ) {
      setPending(null);
    }
  }, [served, pending]);

  const knobs = pending ?? served;

  const send = async (call: () => Promise<ControlKnobs>) => {
    if (busy) return;
    setBusy(true);
    try {
      setPending(await call());
    } catch (err) {
      notify("error", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const facts = [
    narrationFact(live.telemetry, live.relay.active),
    sourceFact(live.telemetry),
    ...matchFacts(live.match),
  ];

  return (
    <div className="glance" data-testid="match-glance">
      <dl className="facts">
        {facts.map((fact) => (
          <div key={fact.label} className={`fact fact--${fact.tone}`}>
            <dt className="fact__label">{fact.label}</dt>
            <dd className="fact__value">{fact.value}</dd>
          </div>
        ))}
      </dl>

      {/* Kaksi säätöä, ei kolmatta. Pollausväli ja delta-haku ovat koneen
          asioita eivätkä ottelupäivän polulla — niiden paikka on huoltoarkissa
          (#188). */}
      <div className="knobs">
        <div className="delay">
          <span className="knob__label">
            Selostuksen ajoitus
            <span className="delay__value num">{knobs ? seconds(knobs.narrationDelayMs) : "–"}</span>
          </span>
          {/* Napit ovat suhteellisia eivätkä absoluuttisia tarkoituksella (#172):
              kalibrointi tehdään korvakuulolta kesken lähetyksen, eikä
              operaattorin pitäisi tarvita tietää nykyistä lukua. Siksi nappi
              nimeää OIREEN, ei arvoa. */}
          <div className="delay__buttons">
            <button
              type="button"
              className="btn btn--nudge"
              disabled={busy || !knobs}
              onClick={() => void send(() => api.delayNudge(500))}
            >
              <span className="btn__big">Puhui liian aikaisin</span>
              <span className="btn__sub">odota kauemmin</span>
            </button>
            <button
              type="button"
              className="btn btn--nudge"
              disabled={busy || !knobs}
              onClick={() => void send(() => api.delayNudge(-500))}
            >
              <span className="btn__big">Puhui liian myöhään</span>
              <span className="btn__sub">puhu aiemmin</span>
            </button>
          </div>
        </div>

        <button
          type="button"
          className={`toggle ${knobs?.announceBatterChanges ? "toggle--on" : ""}`}
          role="switch"
          aria-checked={knobs?.announceBatterChanges ?? false}
          disabled={busy || !knobs}
          onClick={() =>
            void send(() => api.knobs({ announceBatterChanges: !knobs?.announceBatterChanges }))
          }
        >
          <span className="toggle__body">
            <span className="toggle__label">Vaihtoselostus</span>
            <span className="toggle__hint">Lyöjän vaihdot kuulutetaan</span>
          </span>
          <span className="toggle__lamp" aria-hidden="true" />
        </button>
      </div>

      {!knobs && (
        <p className="muted">Selostuksen säätöjä ei saada juuri nyt luettua.</p>
      )}

      <NarrationList lines={live.narration} />
    </div>
  );
}
