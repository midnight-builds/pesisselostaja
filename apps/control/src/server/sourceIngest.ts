/** Lähteen sisääntulon tila YouTube-API:sta, julkaistuna relaylle (issue #104,
 *  vaihe 1).
 *
 *  **Miksi ohjaamo katsoo eikä relay.** Google-tunnukset ovat vain täällä: yksi
 *  refresh_tokenin omistaja on tarkoitus, koska kaksi pollaajaa jakaisi saman
 *  kiintiön ja kaksi uusijaa kilpailisi samasta tokenista. Yhtä tärkeää on
 *  ettei lähetyksen jatkuminen saa riippua Google-yhteydestä: relay lukee
 *  valmiin havainnon tiedostosta ja pärjää ilman sitä.
 *
 *  **Vaihe 1 vain julkaisee.** Kukaan ei vielä toimi tämän tiedon perusteella —
 *  relay ohittaa tuntemattoman control-avaimen. Siksi mikään täällä ei myöskään
 *  saa kaataa mitään: pahin mahdollinen lopputulos on, että `error`-kenttä
 *  kertoo miksi havaintoa ei ole.
 *
 *  **Miksi oma silmukka eikä live.ts:n tikit.** live.ts pollaa 5 s ja 10 s
 *  välein; YouTube Data API:n kiintiö on 10 000 yksikköä vuorokaudessa ja
 *  kierros maksaa 1–2. 30 s välein se on ~240 yksikköä tunnissa, 5 s välein se
 *  olisi ~1400 — eli yksi pitkä leiripäivä söisi koko päivän kiintiön, myös
 *  lähetysten luonnilta. */

import type { Job, SourceIngest } from "../shared/types.js";
import { GoogleAuthError, getQuotaRemaining, getTokenFingerprint } from "./googleAuth.js";
import { getActiveJob } from "./jobs.js";
import { getRelayProcess, readRunningMatchId, writeSourceIngest } from "./relay.js";
import {
  getStreamStatus,
  listBroadcasts,
  YouTubeApiError,
  type BroadcastSummary,
  type StreamStatus,
} from "./youtube.js";
import { parseYouTubeVideoId } from "./youtubeUrl.js";

/** Perusväli. Riittävän tiheä, jotta katvekuvapäätös (vaihe 2) tapahtuu
 *  puolessa minuutissa, ja riittävän harva, ettei kiintiö ole uhattuna. */
const BASE_INTERVAL_MS = 30_000;
/** Katto sekä backoffille että "ei korjaannu itsestään" -tilanteille. */
const MAX_INTERVAL_MS = 300_000;
/** Eksponentiaalinen backoff transienteille virheille. */
const BACKOFF_STEPS = [30_000, 60_000, 120_000, MAX_INTERVAL_MS];

/** Kuinka vanha havainto on ohjaamon tilarivillä vielä käyttökelpoinen.
 *  4× perusväli, eli kolme peräkkäistä epäonnistunutta kierrosta ennen kuin
 *  rivi lakkaa uskomasta havaintoa.
 *
 *  Vaiheen 2 relay soveltaa OMAA rajaansa eikä lue tätä vakiota: se on eri
 *  prosessi eri riskillä (väärä katvekuvapäätös maksaa katsojille enemmän kuin
 *  väärä väri tilarivillä), ja sen on kestettävä myös se että ohjaamo on
 *  kokonaan alhaalla. */
export const SOURCE_INGEST_STALE_MS = 120_000;

/** `YouTubeApiError`in viesti sisältää koko JSON-virherungon. Se ei mahdu
 *  tiedostoon jonka relay jäsentää joka pollilla, eikä operaattorin puhelimen tilariville. */
const MAX_ERROR_LENGTH = 200;

/** Kun token on vanhentunut (needsReauth), pollaus vaikenee kunnes tunnukset
 *  vaihtuvat. Lukko avataan heti kun tokenin sormenjälki muuttuu — uusi
 *  kirjautuminen ylikirjoittaa tokenin käymättä nollan kautta, joten pelkkä
 *  tiedoston olemassaolo ei kertoisi siitä mitään. Aikakatkaisu on varmistus
 *  sen varalta ettei sormenjälki jostain syystä muutu (esim. sama tiedosto
 *  palautettuna varmuuskopiosta): ilman sitä polleri voisi jäädä pysyvästi
 *  sokeaksi. */
const REAUTH_RETRY_MS = 15 * 60_000;

/** Kiintiöyksiköt jotka jätetään koskemattomaksi lähetysten LUONNILLE.
 *
 *  Prioriteettijärjestys, tärkein ensin: 1) lähetysten luonti — ilman
 *  lähetystä ei ole mitään selostettavaa, ja luonti epäonnistuu lopullisesti
 *  kiintiön loputtua; 2) selostuksen jatkuminen — se ei kuluta kiintiötä
 *  lainkaan eikä siis ole uhattuna; 3) tämä havainto, joka on vain lisätieto
 *  tilariville. Yön yli päällä jäänyt relay polttaisi 16 tunnissa ~3840
 *  yksikköä juuri ennen aamun lähetysten luontia (kiintiöpäivä vaihtuu
 *  Tyynenmeren keskiyöllä = klo 10 Suomen aikaa), joten havainto väistää.
 *
 *  500 = yhden ottelun lähetyspari maksaa noin 300, ja pieni marginaali sen
 *  päälle. */
const QUOTA_RESERVE = 500;

export interface SourceIngestPollerDeps {
  getActiveJob: () => Promise<Job | null>;
  isRelayActive: () => Promise<boolean>;
  /** Mitä ottelua relay itse kertoo ajavansa, tai null kun tuoretta
   *  telemetriaa ei ole. */
  getRunningMatchId: () => Promise<number | null>;
  /** Tunnisteet tallennetulle tokenille: null = tokenia ei ole, muuten arvo
   *  joka muuttuu uudelleenkirjautumisessa. */
  getTokenFingerprint: () => Promise<string | null>;
  getQuotaRemaining: () => Promise<number>;
  fetchBroadcast: (videoId: string) => Promise<BroadcastSummary | null>;
  fetchStream: (streamId: string) => Promise<StreamStatus | null>;
  writeIngest: (matchId: number, ingest: SourceIngest) => Promise<void>;
  now: () => number;
}

export interface SourceIngestPoller {
  current(): SourceIngest | null;
  /** Miksi juuri nyt ei pollata — ohjaamon tilarivi näyttää tämän. */
  reason(): string | null;
  stop(): void;
}

const DEFAULT_DEPS: SourceIngestPollerDeps = {
  getActiveJob,
  isRelayActive: async () => (await getRelayProcess()).active,
  getRunningMatchId: () => readRunningMatchId(),
  getTokenFingerprint,
  getQuotaRemaining: () => getQuotaRemaining(),
  // Tyhjä tulos id-haussa on normaali vastaus (video ei ole omalla kanavalla),
  // ei virhe — ks. listBroadcasts.
  fetchBroadcast: async (videoId) => (await listBroadcasts({ id: videoId }))[0] ?? null,
  fetchStream: getStreamStatus,
  writeIngest: writeSourceIngest,
  now: Date.now,
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(text: string): string {
  return text.length <= MAX_ERROR_LENGTH ? text : `${text.slice(0, MAX_ERROR_LENGTH - 1)}…`;
}

type Gate =
  | { ok: true; job: Job; videoId: string; fingerprint: string }
  | { ok: false; reason: string };

/** Polleri. Kahva eikä moduulitason singleton: testit eivät saa jakaa tilaa
 *  eivätkä ajastimet jäädä roikkumaan prosessin loppuun. */
export function createSourceIngestPoller(deps: Partial<SourceIngestPollerDeps> = {}): SourceIngestPoller {
  const d: SourceIngestPollerDeps = { ...DEFAULT_DEPS, ...deps };

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ingest: SourceIngest | null = null;
  let reason: string | null = null;
  let intervalMs = BASE_INTERVAL_MS;
  /** Milloin needsReauth-virhe kirjattiin, tai null kun lukkoa ei ole. */
  let reauthLockedAt: number | null = null;
  /** Tokenin sormenjälki lukon asettamishetkellä. Kun se muuttuu, operaattori
   *  on kirjautunut uudelleen ja lukko on tarpeeton. */
  let reauthLockFingerprint: string | null = null;
  /** Montako peräkkäistä kierrosta on vastannut "lähetystä ei löytynyt". */
  let notFoundStreak = 0;

  /** Portit. Yksikään näistä ei kutsu YouTubea, ja yksikään ei heitä:
   *  epäonnistunut porttitarkistus on "ei tietoa", ei kaatuminen. */
  async function evaluateGates(): Promise<Gate> {
    try {
      const job = await d.getActiveJob();
      if (!job) return { ok: false, reason: "ei aktiivista työtä" };
      // getActiveJob palauttaa myös viimeisimmän ajastetun työn kun mikään ei
      // ole ajossa. Ilman tätä porttia poltettaisiin 240 yksikköä tunnissa
      // HUOMISEN ottelun videosta ja kirjoitettaisiin väärä matchId.
      if (job.status !== "live" && job.status !== "arming") {
        return { ok: false, reason: `työ on tilassa "${job.status}" — raakalähetystä ei pollata vielä` };
      }
      if (!(await d.isRelayActive())) return { ok: false, reason: "relay ei ole käynnissä" };

      // Ajossa oleva relay ei riitä: sen on ajettava TÄTÄ ottelua. Kun ottelu A
      // on yhä lähetyksessä (itsesammutus kesken) ja operaattori aktivoi
      // ottelun B, getActiveJob palauttaa B:n mutta relay ajaa yhä A:ta —
      // silloin pollattaisiin väärän ottelun lähdettä, kirjoitettaisiin
      // .control-<B>.jsoniin jota kukaan ei lue, ja tilarivi liittäisi B:n
      // havainnon A:n riville: "syöte ei virtaa" täysin terveestä lähetyksestä.
      //
      // Totuuden lähde on relay itse (CLAUDE.md, "yksi totuuslähde"): se
      // kirjoittaa telemetriansa noin pollivälin tahdissa. `.env.relay` ei
      // kelpaisi tähän — se kirjoitetaan jo aktivoinnissa, ennen relayn
      // uudelleenkäynnistystä, joten se on ennuste eikä havainto.
      const runningMatchId = await d.getRunningMatchId();
      if (runningMatchId === null) {
        return { ok: false, reason: "relaylta ei ole tuoretta telemetriaa" };
      }
      if (runningMatchId !== job.matchId) {
        return { ok: false, reason: `relay ajaa toista ottelua (${runningMatchId})` };
      }

      const videoId = parseYouTubeVideoId(job.sourceUrl);
      if (!videoId) return { ok: false, reason: "lähde-URLista ei saa videoId:tä" };
      // Lähteeksi on liitetty selostetun lähetyksen URL. Vaiheessa 2 tämä olisi
      // takaisinkytkentä: relay katsoisi omaa ulostuloaan ja päättelisi siitä
      // onko sen sisääntulo elossa.
      if (job.targetVideoId && videoId === job.targetVideoId) {
        return {
          ok: false,
          reason: "lähde-URL osoittaa selostettuun lähetykseen — korjaa työn lähde-URL",
        };
      }

      const fingerprint = await d.getTokenFingerprint();
      if (fingerprint === null) {
        // Uusi kirjautuminen alkaa aina puhtaalta: kun tokenia ei ole
        // lainkaan, vanha reauth-lukko on merkityksetön.
        reauthLockedAt = null;
        reauthLockFingerprint = null;
        return { ok: false, reason: "Google-tiliä ei ole yhdistetty" };
      }

      // Kiintiöportti viimeisenä ja vasta tässä: se on laskurin luku levyltä,
      // ja aiemmat portit ovat halvempia. Ks. QUOTA_RESERVE.
      const remaining = await d.getQuotaRemaining();
      if (remaining < QUOTA_RESERVE) {
        return {
          ok: false,
          reason: `YouTube-kiintiöstä jäljellä vain ${remaining} yksikköä — havainto väistää lähetysten luonnin tieltä`,
        };
      }
      return { ok: true, job, videoId, fingerprint };
    } catch (err) {
      return { ok: false, reason: truncate(`porttien tarkistus epäonnistui: ${messageOf(err)}`) };
    }
  }

  /** Havainto muistiin ja tiedostoon. Kirjoitus tehdään JOKA kierroksella,
   *  myös kun mikään ei muuttunut: relay ylikirjoittaa koko control-tiedoston
   *  käynnistyessään, joten avaimen palautuminen relayn restartin jälkeen saa
   *  kestää korkeintaan yhden pollausvälin. */
  async function publish(matchId: number, value: SourceIngest): Promise<void> {
    const capped: SourceIngest = { ...value, error: value.error ? truncate(value.error) : null };
    ingest = capped;
    try {
      await d.writeIngest(matchId, capped);
      reason = null;
    } catch (err) {
      // Havainto on olemassa, mutta relay ei näe sitä — se on nimenomaan
      // tilarivin asia kertoa.
      reason = truncate(`havainnon kirjoitus epäonnistui: ${messageOf(err)}`);
    }
  }

  function increaseBackoff(): void {
    intervalMs = BACKOFF_STEPS.find((step) => step > intervalMs) ?? MAX_INTERVAL_MS;
  }

  async function observe(job: Job, videoId: string, fingerprint: string): Promise<void> {
    const observedAt = new Date(d.now()).toISOString();
    /** Tila-kentät ovat aina null virhetilanteessa: vanhentunut "active" olisi
     *  vaiheessa 2 vaarallisempi kuin tietämättömyys. */
    const blank = { observedAt, videoId, lifeCycleStatus: null, streamStatus: null, healthStatus: null };

    try {
      const broadcast = await d.fetchBroadcast(videoId);
      if (!broadcast) {
        notFoundStreak += 1;
        // Yleensä pysyvä tilanne, ei transientti: lähde ei ole omalla kanavalla
        // eikä API näe sitä lainkaan (yt-dlp näkee — signaalit täydentävät
        // toisiaan). Ei ole mitään syytä hakata rajapintaa 30 s välein.
        //
        // Ensimmäinen tyhjä vastaus ei silti riitä todisteeksi: juuri luotu
        // lähetys voi puuttua listauksesta hetken (eventual consistency).
        // Yksi uusinta perusvälillä säästää 5 minuutin sokeuden heti ottelun
        // alussa ja maksaa yhden kiintiöyksikön.
        await publish(job.matchId, { ...blank, error: "lähdelähetystä ei löytynyt tältä kanavalta" });
        intervalMs = notFoundStreak >= 2 ? MAX_INTERVAL_MS : BASE_INTERVAL_MS;
        return;
      }
      notFoundStreak = 0;

      // Ilman boundStreamId:tä toista kutsua ei tehdä lainkaan — se säästäisi
      // yksikön eikä kertoisi mitään: sitomatonta striimiä ei voi kysyä.
      const stream = broadcast.boundStreamId ? await d.fetchStream(broadcast.boundStreamId) : null;

      await publish(job.matchId, {
        observedAt,
        videoId,
        lifeCycleStatus: broadcast.lifeCycleStatus,
        streamStatus: stream?.streamStatus ?? null,
        healthStatus: stream?.healthStatus ?? null,
        error: null,
      });
      intervalMs = BASE_INTERVAL_MS;
      return;
    } catch (err) {
      if (err instanceof GoogleAuthError && err.needsReauth) {
        // Backoff ei auta vanhentuneeseen tokeniin: se korjaantuu vain
        // kirjautumalla. Kirjataan kerran ja vaietaan.
        reauthLockedAt = d.now();
        reauthLockFingerprint = fingerprint;
        await publish(job.matchId, {
          ...blank,
          error: `Google-yhteys vaatii uuden kirjautumisen: ${messageOf(err)}`,
        });
        intervalMs = MAX_INTERVAL_MS;
        return;
      }
      if (err instanceof YouTubeApiError && (err.status === 401 || err.status === 403)) {
        // Kiintiö loppu tai oikeudet puuttuvat — kumpikaan ei korjaannu
        // minuutissa, joten pitkä väli.
        await publish(job.matchId, {
          ...blank,
          error: `YouTube epäsi kutsun (HTTP ${err.status}): ${messageOf(err)}`,
        });
        intervalMs = MAX_INTERVAL_MS;
        return;
      }
      // Verkko, 5xx, 429: nämä korjaantuvat itsestään, joten yritetään
      // uudelleen — mutta harvenevasti.
      await publish(job.matchId, { ...blank, error: `lähteen tilaa ei saatu: ${messageOf(err)}` });
      increaseBackoff();
    }
  }

  async function tick(): Promise<void> {
    const gate = await evaluateGates();
    if (!gate.ok) {
      // Vanhaa havaintoa ei jätetä näkyviin: tilarivi ei saa näyttää eilistä
      // totuutta siitä että syöte virtaa.
      ingest = null;
      reason = gate.reason;
      intervalMs = BASE_INTERVAL_MS;
      // Portti voi olla kiinni siksi että työ vaihtui; edellisen ottelun
      // "ei löytynyt" -sarja ei kerro uudesta lähteestä mitään.
      notFoundStreak = 0;
      return;
    }

    if (reauthLockedAt !== null) {
      // Sormenjälki on vaihtunut = operaattori on kirjautunut uudelleen, ja
      // lukko avataan heti eikä vasta aikakatkaisun jälkeen. Ilman tätä polleri
      // olisi sokea 15 minuuttia vaikka yhteys korjattiin sekunneissa.
      const reauthed = gate.fingerprint !== reauthLockFingerprint;
      if (!reauthed && d.now() - reauthLockedAt < REAUTH_RETRY_MS) {
        ingest = null;
        reason = "Google-yhteys vaatii uuden kirjautumisen";
        intervalMs = MAX_INTERVAL_MS;
        return;
      }
      reauthLockedAt = null;
      reauthLockFingerprint = null;
    }

    reason = null;
    await observe(gate.job, gate.videoId, gate.fingerprint);
  }

  const loop = async (): Promise<void> => {
    if (stopped) return;
    try {
      await tick();
    } catch (err) {
      // tick() ei saisi heittää; jos se silti heittää, silmukka jatkaa.
      console.error("[control] lähteen tilan pollaus kaatui:", err);
    }
    if (stopped) return;
    // Ketjutettu setTimeout eikä setInterval: väli muuttuu backoffin myötä.
    timer = setTimeout(() => void loop(), intervalMs);
    // Ajastin ei saa pitää prosessia hengissä sammutuksen jälkeen.
    timer.unref?.();
  };

  // Ensimmäinen katsaus heti: ohjaamon uudelleenkäynnistys kesken ottelun ei
  // saa maksaa puolta minuuttia sokeutta.
  void loop();

  return {
    current: () => ingest,
    reason: () => reason,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
