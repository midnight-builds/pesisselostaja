/** Kohteen eli selostetun lähetyksen tila YouTube-API:sta (issue #250).
 *
 *  `sourceIngest.ts`:n peilikuva, mutta katsottava lähetys on se johon relay
 *  TYÖNTÄÄ eikä se josta se lukee — ja siksi tämän havainnon painoarvo on
 *  toinen. Lähteen tilasta relay on itse paras todistaja; kohteen tilasta se
 *  ei tiedä mitään, koska RTMP-työntö onnistuu myös kuolleeseen lähetykseen.
 *  16.8.2026 (ottelu 136771) YouTuben autostop päätti selostetun lähetyksen
 *  kesken ottelun, relay työnsi loppuottelun kuolleeseen kohteeseen, ja asia
 *  selvisi vasta käsin tarkistamalla. Tämä polleri on se tarkistus.
 *
 *  Toisin kuin lähteen havaintoa, tätä ei kirjoiteta relayn control-tiedostoon:
 *  relay ei voi tehdä tiedolle mitään (kohteen kuolema vaatii operaattorin ja
 *  uuden lähetyksen), joten havainto elää vain ohjaamon muistissa ja kulkee
 *  LiveStaten mukana tilakortille, otsikkoon ja push-ilmoitukseen.
 *
 *  Kiintiöstä sama laskelma kuin lähteellä: oma 30 s silmukka eikä live.ts:n
 *  5 s tikit, ja kierros maksaa 1–2 yksikköä 10 000:n päiväkiintiöstä. */

import type { Job, TargetIngest } from "../shared/types.js";
import { GoogleAuthError, getQuotaRemaining, getTokenFingerprint } from "./googleAuth.js";
import { getActiveJob } from "./jobs.js";
import { getRelayProcess, readRunningMatchId } from "./relay.js";
import {
  getStreamStatus,
  listBroadcasts,
  YouTubeApiError,
  type BroadcastSummary,
  type StreamStatus,
} from "./youtube.js";

/** Perusväli. Kohteen kuolema on toipumiskelpoinen vain niin kauan kuin
 *  ottelua on jäljellä, joten puoli minuuttia on hälytykselle riittävän nopea
 *  — ja kiintiölle riittävän harva. */
const BASE_INTERVAL_MS = 30_000;
/** Katto sekä backoffille että "ei korjaannu itsestään" -tilanteille. */
const MAX_INTERVAL_MS = 300_000;
/** Eksponentiaalinen backoff transienteille virheille. */
const BACKOFF_STEPS = [30_000, 60_000, 120_000, MAX_INTERVAL_MS];

/** Montako peräkkäistä tyhjää vastausta tarvitaan ennen kuin lähetys
 *  julistetaan poissaolevaksi (#252). Yksi ei riitä: juuri luotu lähetys voi
 *  puuttua listauksesta hetken (eventual consistency), ja väärä hälytys kesken
 *  ottelun on kallis. Kaksi kierrosta = enintään minuutti armonaikaa. */
const NOT_FOUND_CONFIRM_STREAK = 2;

/** Ks. sourceIngest.ts: virheteksti ei saa olla koko JSON-virherunko. */
const MAX_ERROR_LENGTH = 200;

/** Reauth-lukko: sama mekanismi ja sama perustelu kuin lähteen pollerissa. */
const REAUTH_RETRY_MS = 15 * 60_000;

/** Sama varaus kuin lähteen pollerissa ja samasta syystä: lähetysten luonti
 *  menee jokaisen havainnon edelle. Kaksi polleria kuluttavat samaa laskuria,
 *  ja kumpikin väistää itsenäisesti saman rajan alla. */
const QUOTA_RESERVE = 500;

export interface TargetIngestPollerDeps {
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
  now: () => number;
}

export interface TargetIngestPoller {
  current(): TargetIngest | null;
  /** Miksi juuri nyt ei pollata — ohjaamon tilarivi näyttää tämän. */
  reason(): string | null;
  stop(): void;
}

const DEFAULT_DEPS: TargetIngestPollerDeps = {
  getActiveJob,
  isRelayActive: async () => (await getRelayProcess()).active,
  getRunningMatchId: () => readRunningMatchId(),
  getTokenFingerprint,
  getQuotaRemaining: () => getQuotaRemaining(),
  // Tyhjä tulos id-haussa on normaali vastaus, ei virhe — ks. listBroadcasts.
  // Kohteelle se on silti aina outo: ohjaamo loi lähetyksen omalle kanavalleen.
  fetchBroadcast: async (videoId) => (await listBroadcasts({ id: videoId }))[0] ?? null,
  fetchStream: getStreamStatus,
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
export function createTargetIngestPoller(deps: Partial<TargetIngestPollerDeps> = {}): TargetIngestPoller {
  const d: TargetIngestPollerDeps = { ...DEFAULT_DEPS, ...deps };

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ingest: TargetIngest | null = null;
  let reason: string | null = null;
  let intervalMs = BASE_INTERVAL_MS;
  /** Milloin needsReauth-virhe kirjattiin, tai null kun lukkoa ei ole. */
  let reauthLockedAt: number | null = null;
  /** Tokenin sormenjälki lukon asettamishetkellä. */
  let reauthLockFingerprint: string | null = null;
  /** Montako peräkkäistä kierrosta on vastannut "lähetystä ei löytynyt". */
  let notFoundStreak = 0;

  /** Portit. Samat kuin lähteen pollerissa ja samoista syistä: yksikään ei
   *  kutsu YouTubea, yksikään ei heitä, ja vuotava portti polttaisi kiintiön
   *  huomisen ottelun kohteesta. */
  async function evaluateGates(): Promise<Gate> {
    try {
      const job = await d.getActiveJob();
      if (!job) return { ok: false, reason: "ei aktiivista työtä" };
      if (job.status !== "live" && job.status !== "arming") {
        return { ok: false, reason: `työ on tilassa "${job.status}" — kohdetta ei pollata vielä` };
      }
      if (!(await d.isRelayActive())) return { ok: false, reason: "relay ei ole käynnissä" };

      // Sama ottelukohtainen portti kuin lähteellä: kun relay ajaa vielä
      // edellistä ottelua, tämän työn kohteeseen ei työnnetä mitään, ja sen
      // (mahdollisesti aivan oikein päättynyt) tila hälyttäisi turhaan uuden
      // ottelun nimissä.
      const runningMatchId = await d.getRunningMatchId();
      if (runningMatchId === null) {
        return { ok: false, reason: "relaylta ei ole tuoretta telemetriaa" };
      }
      if (runningMatchId !== job.matchId) {
        return { ok: false, reason: `relay ajaa toista ottelua (${runningMatchId})` };
      }

      // Kohteen videoId on työssä suoraan — URL-jäsennystä ei tarvita.
      const videoId = job.targetVideoId;
      if (!videoId) return { ok: false, reason: "työllä ei ole selostettua lähetystä" };

      const fingerprint = await d.getTokenFingerprint();
      if (fingerprint === null) {
        reauthLockedAt = null;
        reauthLockFingerprint = null;
        return { ok: false, reason: "Google-tiliä ei ole yhdistetty" };
      }

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

  function publish(value: TargetIngest): void {
    ingest = { ...value, error: value.error ? truncate(value.error) : null };
    reason = null;
  }

  function increaseBackoff(): void {
    intervalMs = BACKOFF_STEPS.find((step) => step > intervalMs) ?? MAX_INTERVAL_MS;
  }

  async function observe(videoId: string, fingerprint: string): Promise<void> {
    const observedAt = new Date(d.now()).toISOString();
    /** Tila-kentät ovat aina null virhetilanteessa: hälytys tehdään vain
     *  varmasta havainnosta, ei vanhasta tai puuttuvasta. */
    const blank = {
      observedAt,
      videoId,
      lifeCycleStatus: null,
      streamStatus: null,
      healthStatus: null,
      notFound: "no" as const,
    };

    try {
      const broadcast = await d.fetchBroadcast(videoId);
      if (!broadcast) {
        notFoundStreak += 1;
        // Ohjaamo loi tämän lähetyksen omalle kanavalleen ja kysyy sitä sen
        // omalla id:llä, joten tyhjä vastaus on YouTuben oma vastaus "tätä
        // lähetystä ei ole" — ei epäonnistunut haku (#252). Ensimmäinen tyhjä
        // on silti armonaikaa, koska juuri luotu lähetys voi puuttua
        // listauksesta hetken; kaksi peräkkäistä on näyttö poistosta.
        const confirmed = notFoundStreak >= NOT_FOUND_CONFIRM_STREAK;
        publish({
          ...blank,
          notFound: confirmed ? "confirmed" : "unconfirmed",
          // Varmistettu tyhjä EI ole virhe: `error` varataan tietämättömyydelle
          // ("emme saaneet vastausta"), ja kuluttajat hylkäävät virhehavainnot.
          // Jos poisto merkittäisiin virheeksi, se jäisi vihreäksi juuri siinä
          // tilanteessa, jota varten vahti on olemassa.
          error: confirmed ? null : "selostettua lähetystä ei löytynyt kanavalta",
        });
        // Ei taka-askelta: varmistuttuaan tilanne on hälytys, jota operaattori
        // katsoo ruudulta, ja 5 min väli tarkoittaisi että myös YouTuben
        // mahdollinen korjaantuminen näkyisi vasta 5 min päästä. Kysely maksaa
        // saman kuin terve kierros, joten mitään ei säästettäisi.
        intervalMs = BASE_INTERVAL_MS;
        return;
      }
      notFoundStreak = 0;

      // Kohteen striimi kertoo ottaako YouTube meidän työntömme vastaan —
      // ainoa suunta josta relayn oma kirjanpito ei voi kertoa mitään.
      const stream = broadcast.boundStreamId ? await d.fetchStream(broadcast.boundStreamId) : null;

      publish({
        observedAt,
        videoId,
        lifeCycleStatus: broadcast.lifeCycleStatus,
        streamStatus: stream?.streamStatus ?? null,
        healthStatus: stream?.healthStatus ?? null,
        notFound: "no",
        error: null,
      });
      intervalMs = BASE_INTERVAL_MS;
      return;
    } catch (err) {
      if (err instanceof GoogleAuthError && err.needsReauth) {
        reauthLockedAt = d.now();
        reauthLockFingerprint = fingerprint;
        publish({ ...blank, error: `Google-yhteys vaatii uuden kirjautumisen: ${messageOf(err)}` });
        intervalMs = MAX_INTERVAL_MS;
        return;
      }
      if (err instanceof YouTubeApiError && (err.status === 401 || err.status === 403)) {
        publish({ ...blank, error: `YouTube epäsi kutsun (HTTP ${err.status}): ${messageOf(err)}` });
        intervalMs = MAX_INTERVAL_MS;
        return;
      }
      publish({ ...blank, error: `selostetun lähetyksen tilaa ei saatu: ${messageOf(err)}` });
      increaseBackoff();
    }
  }

  async function tick(): Promise<void> {
    const gate = await evaluateGates();
    if (!gate.ok) {
      // Vanhaa havaintoa ei jätetä näkyviin — eikä varsinkaan vanhaa
      // "complete"-havaintoa, joka portin sulkeuduttua kuuluisi jo päättyneelle
      // ajolle ja hälyttäisi väärin.
      ingest = null;
      reason = gate.reason;
      intervalMs = BASE_INTERVAL_MS;
      notFoundStreak = 0;
      return;
    }

    if (reauthLockedAt !== null) {
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
    await observe(gate.videoId, gate.fingerprint);
  }

  const loop = async (): Promise<void> => {
    if (stopped) return;
    try {
      await tick();
    } catch (err) {
      // tick() ei saisi heittää; jos se silti heittää, silmukka jatkaa.
      console.error("[control] selostetun lähetyksen tilan pollaus kaatui:", err);
    }
    if (stopped) return;
    // Ketjutettu setTimeout eikä setInterval: väli muuttuu backoffin myötä.
    timer = setTimeout(() => void loop(), intervalMs);
    timer.unref?.();
  };

  // Ensimmäinen katsaus heti: ohjaamon uudelleenkäynnistys kesken ottelun ei
  // saa maksaa puolta minuuttia sokeutta — kohteen kuolema huomataan juuri
  // tällaisissa katkoissa tai ei ollenkaan.
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
