import { useEffect, useRef, useState } from "react";
import type { ControlKnobs, LiveState, MatchState, RelayTelemetry } from "../../shared/types";
import { TELEMETRY_STALE_MS } from "../../shared/types";
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
function sourceFact(telemetry: RelayTelemetry | null, relayActive: boolean): Fact {
  const label = "Raakalähetys";
  // Ilman ajossa olevaa relayta tilannekuva kertoo menneisyydestä: kukaan ei
  // juuri nyt katso raakalähetystä. Vihreä "kuva tulee kentältä" pysähtyneen
  // relayn vieressä olisi täsmälleen se ristiriita, jota ei ehdi lukea kahdesti.
  if (!relayActive || !telemetry) return { label, value: "Ei tietoa", tone: "warn" };
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
    case "unknown":
      return { label, value: "Ei tietoa", tone: "warn" };
    default: {
      // Relayn uusi lähdetila EI saa pudota hiljaa "ei tietoa" -riville: juuri
      // niin kävi `ended`ille (#103) ja `no_signal`ille (#104), ja tilarivi
      // sanoi "ei tietoa" täsmälleen silloin kun relay kertoi tarkasti. Tämä
      // rivi kaataa käännöksen sen sijaan — ja ajossa jäljelle jää sama
      // rehellinen "ei tietoa" eikä poikkeus operaattorin ruudulle.
      const unreachable: never = telemetry.source.state;
      void unreachable;
      return { label, value: "Ei tietoa", tone: "warn" };
    }
  }
}

/** Relayn tilannekuva vain silloin kun se on tuore.
 *
 *  `RelayTelemetry.at` on relayn oma kirjoitushetki, ja pysähtynyt relay jättää
 *  viimeisen tilannekuvansa levylle sellaisenaan. Ilman tätä vertailua kortti
 *  näyttäisi kymmenen minuuttia vanhaa "kuuluu lähetyksessä" -riviä vihreänä —
 *  sopimus sanoo tämän ääneen (`shared/types.ts`, `TELEMETRY_STALE_MS`), ja
 *  palvelin ajaa samaa sääntöä omalle puolelleen. Palvelimen kelloa käytetään,
 *  ei puhelimen: väärässä ajassa oleva puhelin hylkäisi tuoreen kuvan. */
function freshTelemetry(live: LiveState): RelayTelemetry | null {
  if (!live.telemetry) return null;
  const at = Date.parse(live.telemetry.at);
  const now = Date.parse(live.now);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return live.telemetry;
  return now - at > TELEMETRY_STALE_MS ? null : live.telemetry;
}

/** Ottelun tilanne pesäpallona, ei juoksujen summana (#229).
 *
 *  `totalHome`/`totalAway` ovat koko ottelun juoksusummat, ja ne ovat oikea
 *  luku vain silloin kun jaksoja on yksi — juuri sellaisia olivat kaikki
 *  koeajot ennen 5.8.2026, joten vika ei voinut näkyä aiemmin. Jaksopelissä
 *  summa ei ole ottelun tilanne missään vaiheessa: ratkaisevat jaksovoitot, ja
 *  käynnissä olevalla jaksolla on oma lukunsa. Kortti sanoi 6–12 samalla kun
 *  selostus sanoi oikein "toinen jakso, tilanne 0–2".
 *
 *  Kun yhtään jaksoa ei ole vielä ratkennut, jaksovoitot eivät kerro mitään
 *  (0–0) ja rivi on pelkkä käynnissä olevan jakson tilanne. Se on samalla
 *  yhden jakson otteluiden koko totuus, joten leirimuoto ei tarvitse
 *  erikoistapausta. */
export function scoreValue(match: MatchState): string {
  const home = match.home ?? "Koti";
  const away = match.away ?? "Vieras";
  const current = match.currentPeriod == null ? undefined : match.periodScores[match.currentPeriod];
  const decided = match.periodsWonHome + match.periodsWonAway;

  if (decided === 0) {
    // Ei vielä ratkenneita jaksoja: näytetään käynnissä oleva jakso, ja jos
    // sitäkään ei ole, summa on tässä tilanteessa sama asia.
    const score = current ?? { home: match.totalHome, away: match.totalAway };
    return `${home} ${score.home} – ${score.away} ${away}`;
  }

  const won = `${home} ${match.periodsWonHome} – ${match.periodsWonAway} ${away} jaksoissa`;
  // Ottelun päätyttyä käynnissä olevaa jaksoa ei ole; silloin jaksovoitot ovat
  // lopputulos eikä perään kuulu mitään.
  return current ? `${won} · ${periodName(match.currentPeriod)} ${current.home}–${current.away}` : won;
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

/** Hälytys: jotain, mikä ei mahdu viiteen tietoon eikä saa jäädä sanomatta.
 *
 *  Nämä ovat kortin ainoat rivit, jotka syntyvät muusta kuin ketjun tai ottelun
 *  tilasta — ja siksi niitä on täsmälleen kaksi. Kumpikin on hiljainen vika:
 *  ruutu näyttää muuten terveeltä, ja kumpikin päättyy lähetyksen menetykseen
 *  jos sitä ei huomata. Palvelimen oma `headline` ei kelpaa tähän (#176), joten
 *  ne johdetaan samasta datasta operaattorin kielelle.
 *
 *  Loput huoltoluontoinen — lokit, levylukemat, valtuutus — kuuluu
 *  huoltoarkkiin (#188), ei ottelupäivän polulle. */
function alertsFor(live: LiveState): string[] {
  const out: string[] = [];
  // Levytila ennen muuta: täysi levy pilaa tallenteen eikä vain hidasta.
  if (live.system.diskCritical) {
    out.push("Levytila on lopussa — lähetys katkeaa, ellei tilaa vapauteta.");
  }
  // #118: ohjaamon työ ja ajossa oleva relay ovat eri otteluista. Rivit
  // näyttäisivät muuten vihreää, mutta säädöt kirjoittuvat väärän ottelun
  // control-tiedostoon eikä ajossa oleva relay näe niitä koskaan — eli juuri
  // nämä kaksi nappia lakkaavat vaikuttamasta mihinkään, hiljaa.
  //
  // Luetaan kehyksen omasta kentästä (#202). Ennen tämä pääteltiin
  // telemetriasta — jonka palvelin nollaa nimenomaan ristiriidassa, koska se
  // on luettu työn ottelulla eli väärän. Rivi ei siis voinut näkyä koskaan:
  // kun ristiriita oli, telemetria oli null; kun telemetria ei ollut null,
  // ristiriitaa ei ollut.
  if (live.conflict) {
    out.push("Säädöt eivät mene perille: lähetys ajaa eri ottelua kuin ohjaamo.");
  }
  return out;
}

/** Ohjaamon oma leikkaus viiveelle (`server/relay.ts`). Sama raja paikallisesti,
 *  jotta ruudulla näkyvä luku on se, jonka palvelin oikeasti asettaa — muuten
 *  ylärajassa naputtelu näyttäisi kasvavaa lukua, jota relay ei koskaan saa. */
const DELAY_MIN_MS = 0;
const DELAY_MAX_MS = 15_000;

/** Kuinka kauan paikallista arvoa uskotaan, ellei palvelin vahvista sitä.
 *
 *  Ilman määräaikaa jokainen hukkunut vastaus jäädyttäisi luvun ruudulle
 *  pysyvästi: kortti näyttäisi säätöä, jota relay ei ole koskaan nähnyt.
 *  Aggregaattori tikittää 5 s välein, joten kaksi kierrosta riittää. */
const PENDING_GRACE_MS = 10_000;

interface Props {
  live: LiveState;
  notify: (kind: "ok" | "error", text: string) => void;
}

interface Pending {
  knobs: ControlKnobs;
  /** Palvelimen kello, jonka jälkeen paikallisesta arvosta luovutaan. */
  until: number;
}

export function MatchGlance({ live, notify }: Props) {
  /** Juuri lähetetty säätö, jota SSE ei ole vielä ehtinyt kertoa takaisin.
   *  Ilman tätä nappi näyttäisi sekunnin ajan siltä ettei se tehnyt mitään —
   *  ja viivettä säädetään korvakuulolta, monta napautusta peräkkäin. */
  const [pending, setPending] = useState<Pending | null>(null);
  /** Kasvava juokseva numero: vain viimeisimmän napautuksen vastaus saa
   *  kirjoittaa ruudulle. Neljä nopeaa napautusta lähettää neljä pyyntöä, ja
   *  ilman tätä hitain vastaus voisi palauttaa ruudulle vanhemman arvon. */
  const tap = useRef(0);
  const served = live.knobs;
  const nowMs = Number.isFinite(Date.parse(live.now)) ? Date.parse(live.now) : Date.now();

  useEffect(() => {
    if (!pending) return;
    const agreed =
      served != null &&
      served.narrationDelayMs === pending.knobs.narrationDelayMs &&
      served.announceBatterChanges === pending.knobs.announceBatterChanges;
    // Joko palvelin sanoi saman, tai paikallinen arvo on elänyt tarpeeksi
    // kauan ilman vahvistusta. Kumpikin päättää sen: jäätynyt luku ruudulla on
    // pahempi kuin hetken välkähdys takaisin palvelimen arvoon.
    if (agreed || nowMs > pending.until) setPending(null);
  }, [served, pending, nowMs]);

  const knobs = pending?.knobs ?? served;

  /** Näytä uusi arvo heti, lähetä se, ja anna vain viimeisimmän vastauksen
   *  korjata näkymä. */
  const apply = (optimistic: ControlKnobs, call: () => Promise<ControlKnobs>) => {
    tap.current += 1;
    const mine = tap.current;
    setPending({ knobs: optimistic, until: nowMs + PENDING_GRACE_MS });
    void call()
      .then((result) => {
        if (tap.current === mine) setPending({ knobs: result, until: nowMs + PENDING_GRACE_MS });
      })
      .catch((err: unknown) => {
        if (tap.current === mine) setPending(null);
        notify("error", err instanceof Error ? err.message : String(err));
      });
  };

  const nudge = (deltaMs: number) => {
    if (!knobs) return;
    const next = Math.min(DELAY_MAX_MS, Math.max(DELAY_MIN_MS, knobs.narrationDelayMs + deltaMs));
    apply({ ...knobs, narrationDelayMs: next }, () => api.delayNudge(deltaMs));
  };

  const toggleBatterChanges = () => {
    if (!knobs) return;
    const next = !knobs.announceBatterChanges;
    apply({ ...knobs, announceBatterChanges: next }, () => api.knobs({ announceBatterChanges: next }));
  };

  const telemetry = freshTelemetry(live);
  const alerts = alertsFor(live);
  const facts = [
    narrationFact(telemetry, live.relay.active),
    sourceFact(telemetry, live.relay.active),
    ...matchFacts(live.match),
  ];

  return (
    <div className="glance" data-testid="match-glance">
      {alerts.map((text) => (
        <p key={text} className="alert" data-testid="glance-alert">
          {text}
        </p>
      ))}

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
              disabled={!knobs}
              onClick={() => nudge(500)}
            >
              <span className="btn__big">Puhui liian aikaisin</span>
              <span className="btn__sub">odota kauemmin</span>
            </button>
            <button
              type="button"
              className="btn btn--nudge"
              disabled={!knobs}
              onClick={() => nudge(-500)}
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
          disabled={!knobs}
          onClick={toggleBatterChanges}
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
