/** The live aggregator: one background poller that assembles the single
 *  LiveState the phone renders, so N connected clients cost one set of polls
 *  instead of N.
 *
 *  Where the values come from, in order of preference (issue #97):
 *
 *  1. **The relay's own telemetry** — `status-<ID>.json` and
 *     `timeline-<ID>.ndjson`, read in telemetry.ts. Anything the relay knows is
 *     read from there and never recomputed: it is the only process that knows
 *     what was said, in which wording, and whether ffmpeg was attached to hear
 *     it. Two counters counting the same thing always diverge, and on 29.7.2026
 *     they diverged live in three separate ways in one match.
 *  2. **Outside evidence** — systemd's unit state, journald, the machine's
 *     vitals, and the pesistulokset feed for the scoreboard. Used for what the
 *     relay cannot know about itself, and as the fallback while no telemetry
 *     exists (relay not started, or a deploy older than PR #93).
 *
 *  Where a value is still a guess, it is marked as one rather than dressed up. */

import type {
  ChainStatus,
  ControlKnobs,
  Health,
  Job,
  LiveState,
  LogLine,
  MatchState,
  NarrationLine,
  RelayProcess,
  RelayTelemetry,
  SourceIngest,
  SystemState,
} from "../shared/types.js";
import { closeRunningJob, getActiveJob, markRunStarted, reconcileOpenJobs } from "./jobs.js";
import { readLog } from "./journal.js";
import { getMatchState } from "./matches.js";
import { getRelayProcess, readKnobs, readRunningStatus, type RunningStatus } from "./relay.js";
import { SOURCE_INGEST_STALE_MS } from "./sourceIngest.js";
import { getSystemState } from "./system.js";
import { NarrationTimeline, readRelayStatus } from "./telemetry.js";
import { transitionBroadcast, type TransitionResult } from "./youtube.js";
import { parseYouTubeVideoId } from "./youtubeUrl.js";
import { CONFIG } from "./config.js";

/** systemd, machine vitals and journald: cheap, local, and the things that go
 *  wrong fastest. */
const FAST_POLL_MS = 5000;
/** pesistulokset: a shared public API the relay is already polling every 3 s.
 *  10 s is plenty for a scoreboard a human reads, and it keeps our load off a
 *  service we don't own. */
const MATCH_POLL_MS = 10_000;

/** Enough scrollback for the health rules (respawn counting, heartbeat) without
 *  pushing a fat payload to a phone on mobile data every 5 s. */
const LOG_LINES = 50;

/** How old a relay snapshot may be before we stop treating it as fact. The
 *  relay rewrites it every poll (3 s by default, 60 s at the configurable
 *  ceiling), so a minute and a half is "several missed writes", not "one slow
 *  cycle". Past this we fall back to outside evidence instead of showing a
 *  stopped relay's last good state as current. */
const TELEMETRY_STALE_MS = 90_000;
/** Kuinka paljon relayn oma aloitushetki saa olla työn aloitushetkeä aiempi
 *  ennen kuin status tulkitaan eri ajoksi (#123:n siivouksen tuoreusvartija).
 *  Relay käynnistyy ja kirjoittaa ensimmäisen statuksensa sekunteja ennen kuin
 *  ohjaamo ehtii leimata työn käyntiin, joten pieni pelivara on normaalia. */
const RUN_START_TOLERANCE_MS = 30_000;
/** Kuinka kauan relayn on oltava alhaalla ennen kuin avoin työ tulkitaan
 *  päättyneen ajon jäänteeksi (#118:n sovittelu). Relayn oma uudelleen-
 *  käynnistys kestää muutaman sekunnin, ja sen aikana slotin vapauttaminen
 *  veisi operaattorilta säätimet kesken lähetyksen. */
const RECONCILE_SETTLE_MS = 30_000;
/** Grace before "ffmpeg is not attached" counts against the headline. The
 *  reader attaches a second or two after ffmpeg spawns, and a warning that
 *  fires on every single start is a warning nobody reads. */
const READER_GRACE_SEC = 60;

/** Window for "is this still happening" judgements on log evidence. Two minutes
 *  covers several relay poll cycles and one heartbeat, so a single slow cycle
 *  can't flip a row to red. */
const RECENT_WINDOW_MS = 2 * 60 * 1000;
/** Two ffmpeg exits inside the window is flapping, not bad luck. */
const RESPAWN_WARN_COUNT = 2;
/** A narration backlog this deep means synthesis is losing to the feed. */
const QUEUE_WARN_CLIPS = 10;

type ChainKey = ChainStatus["key"];

/** Error bookkeeping is per SOURCE, not per chain row: several reads feed the
 *  relay row, and if they shared a key a later success would quietly erase an
 *  earlier failure — the exact "shows green while it's broken" bug this whole
 *  view exists to prevent. */
type SourceKey = ChainKey | "job" | "knobs" | "log" | "telemetry";

export interface LiveAggregator {
  subscribe(fn: (state: LiveState) => void): () => void;
  current(): LiveState;
  stop(): void;
}

/** Optional injection point. The aggregator defaults to the real job store; the
 *  override exists so a test can drive the whole state machine without a job
 *  file on disk, and so index.ts can hand in the store it already imported. */
export interface LiveAggregatorOptions {
  getActiveJob?: () => Promise<Job | null>;
  /** Same reason as getActiveJob: a test drives the run-start and run-end
   *  edges without a job file on disk. */
  closeRunningJob?: (jobId: string | null) => Promise<Job | null>;
  markRunStarted?: (matchId: number) => Promise<Job | null>;
  /** Mitä ottelua relay OIKEASTI ajaa (relay.ts:n readRunningStatus, lähteenä
   *  relayn oma status-tiedosto). Tämä on se havainto jota vasten työ sidotaan
   *  — ilman sitä sidonta oli pelkkä arvaus jonon järjestyksestä (#118).
   *  mtime kulkee mukana, koska pelkkä tuoreus ei erota tätä ajoa edellisestä. */
  getRunningStatus?: () => Promise<RunningStatus | null>;
  /** Avointen töiden sovittelu käynnistyksessä ja sen jälkeen. Injektoitava
   *  samasta syystä kuin muutkin työjonon kutsut. */
  reconcileOpenJobs?: (runningMatchId: number | null, now?: number) => Promise<Job[]>;
  /** Lähteen tilan polleri (sourceIngest.ts). Aggregaattori ei omista sitä:
   *  polleri pollaa omalla 30 s välillään kiintiön takia, ja tämä vain kysyy
   *  sen viimeisimmän tuloksen jokaisella tikillä. */
  getSourceIngest?: () => { ingest: SourceIngest | null; reason: string | null };
  /** Hard stopin siivous (#123): lähetyksen lopetus YouTubessa. Injektoitava,
   *  jotta testi ajaa laskevan reunan koskematta YouTube-API:in. */
  transitionBroadcast?: (videoId: string) => Promise<TransitionResult>;
  /** Relayn viimeisin snapshot laskevalla reunalla. Luetaan tiedostosta
   *  uudestaan eikä muistista, koska relay kirjoittaa `endReason`in vasta
   *  juuri ennen sammumistaan — muistissa oleva snapshot on yleensä sitä
   *  vanhempi. */
  readTelemetry?: (matchId: number) => Promise<RelayTelemetry | null>;
  /** Saako raakalähetykseen koskea. Oletus CONFIG.hardStopSource (false). */
  hardStopSource?: boolean;
}

// ------------------------------------------------------------ empty defaults

function emptyRelay(): RelayProcess {
  return {
    activeState: "unknown",
    active: false,
    uptimeSec: null,
    deployedCommit: null,
    nRestarts: null,
  };
}

function emptyMatch(): MatchState {
  return {
    matchId: null,
    home: null,
    away: null,
    periodScores: [],
    totalHome: 0,
    totalAway: 0,
    periodsWonHome: 0,
    periodsWonAway: 0,
    currentPeriod: null,
    palot: null,
    battingTeam: null,
    finished: false,
    eventCount: 0,
    lastEventAt: null,
  };
}

function emptySystem(): SystemState {
  return {
    diskFreeBytes: 0,
    diskTotalBytes: 0,
    // Not "critical" until measured: an unread disk must not fire the hard stop.
    diskCritical: false,
    memFreeBytes: 0,
    memTotalBytes: 0,
    load1: 0,
    cpuCount: 0,
  };
}

// ------------------------------------------------------------- log utilities

function isRecent(line: LogLine, now: number): boolean {
  const ts = Date.parse(line.ts);
  return Number.isFinite(ts) && now - ts <= RECENT_WINDOW_MS;
}

function lastMatching(log: LogLine[], pattern: RegExp): LogLine | null {
  for (let i = log.length - 1; i >= 0; i--) {
    if (pattern.test(log[i].msg)) return log[i];
  }
  return null;
}

/** Log phrases we key on. These are the relay's current Finnish wording, i.e.
 *  the same temporary contract journal.ts's level heuristic lives under: phase B
 *  replaces every one of them with a stable event code. Kept in one table so
 *  that replacement is a single edit. */
const PHRASE = {
  ffmpegStart: /Käynnistetään ffmpeg/i,
  ffmpegEnd: /ffmpeg päättyi/i,
  // Sanamuoto on relayn oma (apps/broadcast) eikä sanaston mukainen
  // "raakalähetys": tämä on hakuehto toisen sovelluksen lokitekstiin, joten se
  // on pakko pitää sellaisenaan kunnes relay siirtyy tapahtumakoodeihin.
  sourceNotLive: /Lähde ei ole vielä livenä/i,
  heartbeat: /Sydänääni: relay käynnissä/i,
  targetBlamed: /KOHTEESEEN/,
} as const;

/** ffmpeg exits inside the recent window. One is normal (a scheduled URL
 *  refresh, a brief RTMP blip); a stream of them is the classic "kuva pätkii"
 *  symptom the operator needs to hear about before viewers do. */
function countRecentRespawns(log: LogLine[], now: number): number {
  return log.filter((line) => isRecent(line, now) && PHRASE.ffmpegEnd.test(line.msg)).length;
}

/** The heartbeat line carries the only queue depth we have in phase A:
 *  "Sydänääni: relay käynnissä 120s, selostusjonossa 2 klippiä." */
function parseQueueDepth(log: LogLine[]): { clips: number; at: number } | null {
  const line = lastMatching(log, PHRASE.heartbeat);
  if (!line) return null;
  const match = /selostusjonossa (\d+) klippiä/.exec(line.msg);
  if (!match) return null;
  return { clips: Number(match[1]), at: Date.parse(line.ts) };
}

// --------------------------------------------------------- health & headline

export interface Snapshot {
  now: number;
  job: Job | null;
  relay: RelayProcess;
  match: MatchState;
  system: SystemState;
  /** The relay's own snapshot, or null when it has written none for this match.
   *  Pass it through `freshTelemetry` before believing it — see
   *  TELEMETRY_STALE_MS. */
  telemetry: RelayTelemetry | null;
  log: LogLine[];
  /** Per-source failures from this cycle; a failed source can't be judged
   *  healthy just because its last known value looked fine. */
  errors: Map<SourceKey, string>;
  /** Ohjaamon oma YouTube-havainto lähteestä. Valinnainen, koska se lisättiin
   *  olemassa olevaan tyyppiin; puuttuva ja null tarkoittavat samaa asiaa
   *  ("ei havaintoa"), eikä kumpikaan saa muuttaa yhtään terveyspäätöstä
   *  entisestään. */
  sourceIngest?: SourceIngest | null;
  /** Pollerin syy sille ettei havaintoa juuri nyt ole. */
  sourceIngestReason?: string | null;
  /** Ottelu jota relay oikeasti ajaa, relayn oman status-tiedoston mukaan.
   *  null = ei näyttöä (relay alhaalla, tai juuri käynnistynyt eikä ole vielä
   *  ehtinyt kirjoittaa). Erottelu on olennainen: "ei tiedetä" ei ole sama asia
   *  kuin "ajaa väärää ottelua". */
  runningMatchId?: number | null;
}

/** Onko ohjaamon työ ja relayn oikea ajo eri otteluista. Vaatii NÄYTÖN
 *  molemmista: ilman havaintoa (null) ei väitetä ristiriitaa. */
function matchIdConflict(snap: Snapshot): { job: number; running: number } | null {
  const running = snap.runningMatchId ?? null;
  if (!snap.job || running === null) return null;
  return running === snap.job.matchId ? null : { job: snap.job.matchId, running };
}

function minutes(sec: number | null): string {
  if (sec === null) return "kesto tuntematon";
  return sec < 60 ? `${sec} s` : `${Math.round(sec / 60)} min`;
}

/** The relay's snapshot, but only while it is still current AND the unit is up.
 *  Two guards, because both failure modes are real: a relay that stopped
 *  writing leaves its last (now false) snapshot behind, and a finished run
 *  leaves a whole file describing a broadcast that ended hours ago. The
 *  narration list deliberately does NOT go through this — a past match's lines
 *  are history, not a claim about right now. */
function freshTelemetry(snap: Snapshot): RelayTelemetry | null {
  const telemetry = snap.telemetry;
  if (!telemetry || !snap.relay.active) return null;
  const at = Date.parse(telemetry.at);
  if (!Number.isFinite(at) || snap.now - at > TELEMETRY_STALE_MS) return null;
  // Kolmas vartija (#118): oikean ottelun snapshot. Väärään työhön sidottuna
  // ohjaamo luki toisen ottelun status-tiedostoa ja piirsi sen tämän hetken
  // lähetykseksi — hiljainen väärä data on tässä pahin lopputulos, joten
  // mieluummin ei tietoa kuin toisen ottelun tieto.
  if (snap.job && telemetry.matchId !== snap.job.matchId) return null;
  // Ja sama sääntö toisin päin: kun työ itse on eri ottelusta kuin ajossa
  // oleva, työn ottelun telemetria on määritelmän mukaan väärän ottelun —
  // vaikka se täsmääkin työhön. Ilman tätä ketjurivit piirtäisivät vihreää
  // edellisen ottelun statuksesta samalla kun otsikko huutaa ristiriitaa.
  if (matchIdConflict(snap)) return null;
  return telemetry;
}

/** The one sentence the operator reads standing in a field, in priority order.
 *  Every rule is a decision, not a formula — hence the comments. First match
 *  wins, so the order below IS the policy. */
export function deriveHealth(snap: Snapshot): { health: Health; headline: string } {
  const { job, relay, match, system } = snap;
  const respawns = countRecentRespawns(snap.log, snap.now);

  // 1. Disk before anything else. The global operating rule stops all writing
  //    work below the floor, and a full disk corrupts a recording rather than
  //    merely degrading it — so it outranks even a dead relay.
  if (system.diskCritical) {
    return {
      health: "fail",
      headline: "Levytila lopussa — pysäytä kirjoittavat ajot ennen kuin jatkat",
    };
  }

  // 2. If we couldn't read the job store or systemd, we don't know what SHOULD
  //    be running — and "unknown" must read as a problem, never as calm.
  const blind = snap.errors.get("job") ?? snap.errors.get("relay");
  if (blind) {
    return { health: "fail", headline: `Tilaa ei saatu luettua: ${blind}` };
  }

  // 3. A job that believes it is live while the unit is down is the worst
  //    silent failure we have: nothing is being broadcast and nothing says so.
  if (job?.status === "live" && !relay.active) {
    return {
      health: "fail",
      headline: `Relay ei ole käynnissä (${relay.activeState}) vaikka lähetyksen pitäisi olla ajossa`,
    };
  }

  // 3b. Ohjaamon työ ja relayn oikea ajo ovat eri otteluista (#118). Sama
  //     luokka hiljaista vikaa kuin sääntö 3, ja pahempi seurauksiltaan: rivit
  //     näyttävät vihreää, mutta säätimet kirjoittuvat väärän ottelun
  //     control-tiedostoon eikä ajossa oleva relay näe niitä koskaan.
  const conflict = matchIdConflict(snap);
  if (conflict) {
    return {
      health: "fail",
      headline: `Relay ajaa ottelua ${conflict.running}, ohjaamon työ on ottelusta ${conflict.job} — säätimet eivät mene perille`,
    };
  }

  // 4. No work at all. Checked before the "all good" rules so an idle box reads
  //    as idle instead of as a healthy broadcast.
  if (!job) {
    return relay.active
      ? {
          // Someone started the unit by hand, or a previous job vanished. Not
          // broken — but the UI's controls no longer describe what is running.
          health: "warn",
          headline: `Relay on käynnissä ilman ohjaussovelluksen työtä (${minutes(relay.uptimeSec)})`,
        }
      : { health: "idle", headline: "Ei aktiivista lähetystä" };
  }

  // 5. Narration going nowhere. The relay says the source is live but ffmpeg
  //    never attached to the narration FIFO, so every clip is counted, deduped
  //    and thrown away unheard. This looked exactly like a healthy broadcast in
  //    match 145889 on 29.7.2026 and cost five minutes of narration including
  //    two runs — the reason the relay reports readerAttached at all. Ranked
  //    above flapping: gaps in the audio beat no audio at all.
  const telemetry = freshTelemetry(snap);
  if (
    telemetry &&
    telemetry.source.state === "live" &&
    !telemetry.readerAttached &&
    telemetry.uptimeSec > READER_GRACE_SEC
  ) {
    const muted = telemetry.narration.muted;
    return {
      health: "warn",
      headline: `ffmpeg ei ole kytkeytynyt — selostus ei kuulu${muted > 0 ? ` (${muted} vaimennettua)` : ""}`,
    };
  }

  // 6. Flapping. The stream technically exists but viewers hear gaps, so this
  //    is a warning the operator can act on (check the phone's uplink) rather
  //    than a failure we should escalate.
  if (respawns >= RESPAWN_WARN_COUNT) {
    return {
      health: "warn",
      headline: `ffmpeg respawnasi ${respawns}× viime minuutteina — kuva pätkii`,
    };
  }

  // 7. Relay up, match still going: the normal, boring, good case. The duration
  //    is the detail the operator actually wants ("42 min").
  if (relay.active && !match.finished) {
    return { health: "ok", headline: `Lähetys kunnossa, ${minutes(relay.uptimeSec)}` };
  }

  // 8. Match over but the unit still up — expected: the relay shuts itself down
  //    once the source ends, and we never cut it short (uptime first).
  if (relay.active && match.finished) {
    return { health: "ok", headline: "Ottelu päättyi — relay sammuu itse kun raakalähetys loppuu" };
  }

  // 9. Job exists, relay down, but the job isn't claiming to be live: waiting
  //    for kickoff or already wrapped up.
  if (job.status === "finished" || job.status === "cancelled") {
    return { health: "idle", headline: "Työ on päättynyt" };
  }
  if (job.status === "failed") {
    return { health: "fail", headline: "Työ epäonnistui — katso loki" };
  }
  return { health: "idle", headline: "Relay ei ole käynnissä — odotetaan käynnistystä" };
}

// -------------------------------------------------------------- status chain

function chainRow(key: ChainKey, label: string, health: Health, detail: string): ChainStatus {
  return { key, label, health, detail };
}

/** Raakalähetys-rivin sääntö YouTube-havainnolle: **API-havainto voi vain lisätä
 *  epäilystä, ei koskaan tuottaa vihreää.**
 *
 *  Kaksi mielipidettä samasta rivistä on juuri se ongelma jonka issue #97
 *  poistaa: relayn oma loki kertoo mitä relay näkee, ja jos ohjaamon havainto
 *  saisi ylikirjoittaa sen, rivin väri riippuisi siitä kumpi ehti ensin. Siksi
 *  lokipohjainen logiikka päättää lähtötason ja havainto saa korkeintaan
 *  pudottaa ok → warn. Failiin ei mennä: vaihe 1 on julkaisu, eikä kukaan vielä
 *  toimi tämän tiedon perusteella.
 *
 *  Vanhentunut tai virheellinen havainto ei muuta terveyttä lainkaan —
 *  tietämättömyys ei ole todiste. */
function applySourceIngest(
  row: { health: Health; detail: string },
  snap: Snapshot,
  now: number
): { health: Health; detail: string } {
  const ingest = snap.sourceIngest ?? null;
  const notes: string[] = [];
  let health = row.health;
  const doubt = (): void => {
    // Vain ok → warn. Idle pysyy idlenä (relay ei lue raakalähetystä, joten
    // syötteen tila ei kerro rivistä mitään), fail pysyy failina.
    if (health === "ok") health = "warn";
  };

  const ageMs = ingest ? now - Date.parse(ingest.observedAt) : NaN;
  // Ikä on oltava välillä [0, raja]. Negatiivinen ikä tarkoittaa aikaleimaa
  // tulevaisuudessa (kello siirtynyt kirjoituksen jälkeen, käsin muokattu
  // tiedosto) — ilman alarajaa sellainen havainto olisi IKUISESTI "tuore" ja
  // ohjaisi tilariviä siitä eteenpäin.
  const fresh =
    ingest !== null &&
    ingest.error === null &&
    Number.isFinite(ageMs) &&
    ageMs >= 0 &&
    ageMs <= SOURCE_INGEST_STALE_MS;

  if (!fresh) {
    if (ingest !== null) {
      notes.push(ingest.error ? "YouTube: havaintoa ei saatu" : "YouTube: havainto vanhentunut");
    }
  } else if (ingest) {
    if (ingest.lifeCycleStatus === "complete") {
      notes.push("YouTube: raakalähetys on päättynyt");
      // Relay yhä ajossa vaikka raakalähetys on suljettu: se on epäilystä, ei
      // vielä vikaa — relay sammuu itse kun raakalähetys loppuu.
      if (snap.relay.active) doubt();
    }
    if (ingest.streamStatus === "active") {
      // Ainoa arvo joka tarkoittaa että dataa virtaa sisään. Se ei nosta
      // terveyttä, vain vahvistaa mitä rivi jo sanoo.
      notes.push("YouTube: syöte aktiivinen");
    } else if (ingest.streamStatus !== null) {
      notes.push(`YouTube: syöte ei virtaa (${ingest.streamStatus})`);
      doubt();
    }
  }

  // Pollerin syy näytetään AINA kun se on asetettu, myös silloin kun havainto
  // on olemassa. Havainto muistissa ei tarkoita että se olisi julkaistu: kun
  // kirjoitus control-tiedostoon epäonnistuu (levy täynnä, vain luku), polleri
  // asettaa syyn mutta pitää havainnon — ja ilman tätä riviä operaattori lukisi
  // "syöte aktiivinen" vihreänä tilanteessa jossa relay ei ole nähnyt yhtäkään
  // havaintoa.
  //
  // Ilman työtä syy on aina "ei aktiivista työtä", jonka rivi sanoo jo itse.
  if (snap.job && snap.sourceIngestReason) {
    notes.push(`YouTube: ${snap.sourceIngestReason}`);
    // Syy + olemassa oleva havainto = julkaisu on poikki (portin sulkeutuessa
    // polleri nollaa havainnon). Se on tiedetty vika eikä tietämättömyys,
    // joten se saa pudottaa rivin ok → warn.
    if (ingest !== null) doubt();
  }

  return {
    health,
    detail: notes.length > 0 ? [row.detail, ...notes].join(" · ") : row.detail,
  };
}

/** The relay's own source states, in the operator's words. "scheduled" is
 *  healthy, not a warning: the relay is waiting for a stream that has not begun
 *  yet, which is where every broadcast starts.
 *
 *  Palauttaa {health, detail} eikä valmista riviä, koska ohjaamon oma
 *  YouTube-havainto täydentää tätä jälkikäteen (applySourceIngest).
 *
 *  `ended` ja `no_signal` tulivat relaylle vasta issueiden #103 ja #104
 *  myötä. Ilman omia haaroja ne putoaisivat defaultiin ja rivi sanoisi
 *  "relay ei kerro lähteen tilaa" juuri silloin kun relay kertoo sen hyvin
 *  tarkasti — kaksi eri tilaa naamioituneena telemetrian puutteeksi. */
function sourceFromTelemetry(telemetry: RelayTelemetry): { health: Health; detail: string } {
  const detail = telemetry.source.detail;
  switch (telemetry.source.state) {
    case "live":
      return { health: "ok", detail: detail ?? "ffmpeg kiinni raakalähetyksessä" };
    case "scheduled":
      return { health: "ok", detail: `ei vielä livenä — ${detail ?? "relay odottaa"}` };
    case "resolving":
      return { health: "ok", detail: "haetaan raakalähetyksen osoitetta yt-dlp:llä" };
    case "failed":
      return { health: "fail", detail: detail ?? "raakalähetyksen avaus epäonnistui" };
    case "ended":
      // Kuvaaja lopetti raakalähetyksen (#103). Ottelun jälkeen normaali, terve
      // lopputila: relay sammuu itse. Kesken ottelun sama tila tarkoittaa
      // että lähetys on kuolemassa ennen aikojaan — silloin ei saa näyttää
      // vihreää "siistiä lopetusta" (adversaarilöydös #117:n arviosta).
      if (!telemetry.match.finished) {
        return { health: "warn", detail: detail ?? "raakalähetys päättyi kesken ottelun" };
      }
      return {
        health: "ok",
        detail: detail ?? "raakalähetys päättyi — selostettu lähetys lopetetaan siististi",
      };
    case "reconnecting":
      // ffmpeg ei ole juuri nyt käynnissä (#122). Keltainen eikä vihreä,
      // koska tällä hetkellä kohteeseen ei työnnetä mitään — juuri tämä hetki
      // näytti ennen vihreältä ("ffmpeg kiinni raakalähetyksessä") koko sen ajan kun
      // sama 34 s häntä respawnattiin kolmesti ottelussa 145900.
      //
      // Terve osoitteenkierrätys käy myös tästä, mutta sen katko kestää
      // sekunteja: ohjaamo ehtii nähdä sen korkeintaan yhden pollin ajan, ja
      // silloinkin rivi lukee mitä oikeasti tapahtuu. Väärä vihreä maksaa
      // enemmän kuin ohimenevä keltainen.
      return { health: "warn", detail: detail ?? "ffmpeg ei ole käynnissä — yhdistetään uudelleen" };
    case "no_signal":
      // Katvekuva päällä (#104): RTMP-työntö jatkuu ja selostus kuuluu, mutta
      // KUVA ON POIKKI. Tämän on näkyttävä keltaisena, koska juuri tässä
      // tilassa lähetys näyttää ulospäin sujuvalta — issuen oma rajaus on
      // ettei katve saa peittää ongelmaa operaattorilta.
      return {
        health: "warn",
        detail: `katvekuva päällä — kuva poikki, selostus jatkuu${detail ? ` (${detail})` : ""}`,
      };
    default:
      return { health: "warn", detail: "relay ei kerro lähteen tilaa" };
  }
}

/** Six dots, each one sentence. Any source that threw this cycle is red with
 *  its own error text — a stale green here would be a lie. */
export function buildChain(snap: Snapshot, knobs: ControlKnobs | null): ChainStatus[] {
  const { job, relay, match, system, errors, now } = snap;
  const telemetry = freshTelemetry(snap);
  const rows: ChainStatus[] = [];

  // --- Raakalähetys: the YouTube live the camera phone pushes into, which we
  // only ever read. The relay
  // reports its own view of it (yt-dlp result + ffmpeg session), so we quote
  // that. The log fallback below is only for a relay too old to publish
  // telemetry — and it is the one that produced #102, where a working stream
  // read as "ei havaintoa lähteestä lokissa" once the start line scrolled out
  // of the 50-line window.
  const notLive = lastMatching(snap.log, PHRASE.sourceNotLive);
  const ffmpegStart = lastMatching(snap.log, PHRASE.ffmpegStart);
  let source: { health: Health; detail: string };
  if (!job) {
    source = { health: "idle", detail: "ei aktiivista työtä" };
  } else if (!job.sourceUrl) {
    source = { health: "warn", detail: "raakalähetyksen URL puuttuu työstä" };
  } else if (!relay.active) {
    source = { health: "idle", detail: "relay ei lue raakalähetystä" };
  } else if (telemetry) {
    source = sourceFromTelemetry(telemetry);
  } else if (notLive && (!ffmpegStart || Date.parse(notLive.ts) > Date.parse(ffmpegStart.ts))) {
    // Waiting for a scheduled start is a normal, healthy state — the relay
    // sleeps and rechecks without burning its give-up window.
    source = { health: "ok", detail: "ei vielä livenä — relay odottaa" };
  } else if (ffmpegStart) {
    source = { health: "ok", detail: "ffmpeg kiinni raakalähetyksessä" };
  } else {
    source = {
      health: "warn",
      detail: "relay ei julkaise telemetriaa eikä lokissa ole havaintoa raakalähetyksestä",
    };
  }
  // Ohjaamon YouTube-havainto vasta tämän jälkeen: se ei korvaa relayn omaa
  // havaintoa, vaan täydentää sitä (ks. applySourceIngest).
  const withIngest = applySourceIngest(source, snap, now);
  rows.push(chainRow("source", "Raakalähetys", withIngest.health, withIngest.detail));

  // --- Relay: the one row we can state as fact. All four reads that describe
  // the relay (unit state, journal, job store, control file) surface here,
  // because a failure in any of them means this row's green is unverified.
  const respawns = countRecentRespawns(snap.log, now);
  const relayError =
    errors.get("relay") ??
    errors.get("log") ??
    errors.get("job") ??
    errors.get("knobs") ??
    errors.get("telemetry");
  const relayConflict = matchIdConflict(snap);
  if (relayError) {
    rows.push(chainRow("relay", "Relay", "fail", relayError));
  } else if (relayConflict) {
    rows.push(
      chainRow(
        "relay",
        "Relay",
        "fail",
        `ajaa ottelua ${relayConflict.running}, työ on ottelusta ${relayConflict.job}`
      )
    );
  } else if (relay.active && respawns >= RESPAWN_WARN_COUNT) {
    rows.push(chainRow("relay", "Relay", "warn", `${respawns} ffmpeg-respawnia viime minuutteina`));
  } else if (relay.active) {
    const commit = relay.deployedCommit ? `, commit ${relay.deployedCommit}` : "";
    rows.push(chainRow("relay", "Relay", "ok", `${relay.activeState}, ${minutes(relay.uptimeSec)}${commit}`));
  } else if (job?.status === "live") {
    rows.push(chainRow("relay", "Relay", "fail", `${relay.activeState} — lähetyksen pitäisi olla ajossa`));
  } else {
    rows.push(chainRow("relay", "Relay", "idle", relay.activeState));
  }

  // --- Jono: narration waiting for synthesis + mixing. The relay counts both
  // the queue and whether anyone is listening; the heartbeat parse below is
  // again only the pre-telemetry fallback.
  const queue = parseQueueDepth(snap.log);
  const delay = knobs ? `, viive ${knobs.narrationDelayMs} ms` : "";
  if (!relay.active) {
    rows.push(chainRow("queue", "Jono", "idle", "ei ajossa"));
  } else if (telemetry) {
    const { pendingClips, readerAttached, narration } = telemetry;
    if (!readerAttached) {
      // The clip is decided, deduped and counted — and then dropped, because
      // there is no reader on the FIFO. Silence that looks like narration.
      rows.push(
        chainRow("queue", "Jono", "warn", `ffmpeg ei kuuntele — ${narration.muted} vaimennettua selostusta${delay}`)
      );
    } else if (pendingClips >= QUEUE_WARN_CLIPS) {
      rows.push(chainRow("queue", "Jono", "warn", `${pendingClips} klippiä jonossa — selostus jää jälkeen${delay}`));
    } else {
      rows.push(
        chainRow("queue", "Jono", "ok", `${pendingClips} klippiä jonossa, ${narration.spoken} puhuttu${delay}`)
      );
    }
  } else if (!queue || !Number.isFinite(queue.at) || now - queue.at > RECENT_WINDOW_MS) {
    // The heartbeat is periodic; its absence while the relay is up means either
    // a very young run or a loop that has stopped reporting.
    rows.push(chainRow("queue", "Jono", "warn", `ei tuoretta sydänääntä lokissa${delay}`));
  } else if (queue.clips >= QUEUE_WARN_CLIPS) {
    rows.push(chainRow("queue", "Jono", "warn", `${queue.clips} klippiä jonossa — selostus jää jälkeen${delay}`));
  } else {
    rows.push(chainRow("queue", "Jono", "ok", `${queue.clips} klippiä jonossa${delay}`));
  }

  // --- Kohde: the second, narrated broadcast we push to. YouTube's own view of
  // it needs Google auth, which is phase B — until then we can only report what
  // we configured and what ffmpeg blamed when it died.
  const targetBlamed = lastMatching(snap.log, PHRASE.targetBlamed);
  const targetError = errors.get("target");
  if (targetError) {
    // Hard stopin siivous epäonnistui (#123). Tämä on juuri se tilanne jossa
    // kohde voi jäädä työntämään roskaa, joten se ei saa jäädä pelkkään
    // journaliin — operaattorin on tiedettävä että lopetus on kesken.
    rows.push(chainRow("target", "Kohde", "fail", targetError));
  } else if (!job) {
    rows.push(chainRow("target", "Kohde", "idle", "ei aktiivista työtä"));
  } else if (!job.targetStreamKey) {
    rows.push(chainRow("target", "Kohde", "fail", "stream key puuttuu — ei mihin pushata"));
  } else if (targetBlamed && isRecent(targetBlamed, now)) {
    rows.push(chainRow("target", "Kohde", "fail", "ffmpeg syytti kohdetta — tarkista stream key"));
  } else if (relay.active) {
    rows.push(chainRow("target", "Kohde", "ok", `push ${job.targetRtmpUrl}`));
  } else {
    rows.push(chainRow("target", "Kohde", "idle", "ei pushia"));
  }

  // --- API: pesistulokset, which the control app reads only for the
  // scoreboard — the narration list comes from the relay (issue #97).
  const apiError = errors.get("api");
  if (apiError) {
    rows.push(chainRow("api", "Tulospalvelu", "fail", apiError));
  } else if (!job) {
    rows.push(chainRow("api", "Tulospalvelu", "idle", "ei pollata ilman työtä"));
  } else if (match.eventCount === 0) {
    // Normal before the scorer opens the match — worth showing, not worth
    // alarming about.
    rows.push(chainRow("api", "Tulospalvelu", "warn", "0 tapahtumaa — ottelua ei ole vielä avattu"));
  } else {
    rows.push(chainRow("api", "Tulospalvelu", "ok", `${match.eventCount} tapahtumaa`));
  }

  // --- Järjestelmä: the box itself.
  const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} Gt`;
  if (errors.has("system")) {
    rows.push(chainRow("system", "Järjestelmä", "fail", errors.get("system") ?? "vitaalien luku epäonnistui"));
  } else if (system.diskCritical) {
    rows.push(chainRow("system", "Järjestelmä", "fail", `levytila ${gb(system.diskFreeBytes)} — alle rajan`));
  } else if (system.cpuCount > 0 && system.load1 > system.cpuCount * 1.5) {
    rows.push(chainRow("system", "Järjestelmä", "warn", `kuorma ${system.load1.toFixed(2)} / ${system.cpuCount} ydintä`));
  } else {
    rows.push(chainRow("system", "Järjestelmä", "ok", `${gb(system.diskFreeBytes)} vapaana, kuorma ${system.load1.toFixed(2)}`));
  }

  return rows;
}

// ------------------------------------------------------------------ the loop

export function startLiveAggregator(opts: LiveAggregatorOptions = {}): LiveAggregator {
  const readActiveJob = opts.getActiveJob ?? getActiveJob;
  const closeRunningJobFn = opts.closeRunningJob ?? closeRunningJob;
  const markRunStartedFn = opts.markRunStarted ?? markRunStarted;
  const getRunningStatusFn = opts.getRunningStatus ?? (() => readRunningStatus());
  const reconcileOpenJobsFn = opts.reconcileOpenJobs ?? reconcileOpenJobs;
  const transitionBroadcastFn = opts.transitionBroadcast ?? ((videoId: string) => transitionBroadcast(videoId));
  const readTelemetryFn = opts.readTelemetry ?? readRelayStatus;
  const hardStopSourceEnabled = opts.hardStopSource ?? CONFIG.hardStopSource;
  const subscribers = new Set<(state: LiveState) => void>();
  const errors = new Map<SourceKey, string>();
  let stopped = false;

  let job: Job | null = null;
  let relay = emptyRelay();
  let system = emptySystem();
  let match = emptyMatch();
  let knobs: ControlKnobs | null = null;
  let log: LogLine[] = [];
  let telemetry: RelayTelemetry | null = null;
  /** Relayn oma näyttö siitä mitä se ajaa. Luetaan joka nopealla tikillä. */
  let runningMatchId: number | null = null;
  /** Milloin relay nähtiin ensimmäisen kerran alhaalla yhtäjaksoisesti. null =
   *  relay on ajossa. Sovittelu odottaa tätä, jotta relayn oma uudelleen-
   *  käynnistys (~4 s) ei näytä päättyneeltä ajolta. */
  let relayDownSince: number | null = null;
  /** Tail of the running match's timeline. Recreated when the job's match
   *  changes; null when there is no job to read one for. */
  let timeline: NarrationTimeline | null = null;
  let timelineMatchId = -1;
  let narration: NarrationLine[] = [];

  let state: LiveState = assemble();

  function assemble(): LiveState {
    // Havainto luetaan pollerin muistista joka kokoamisella: se on synkroninen
    // ja ilmainen, eikä aggregaattorin tikkien tarvitse tietää pollerin omasta
    // 30 s rytmistä.
    const source = opts.getSourceIngest?.() ?? { ingest: null, reason: null };
    const snap: Snapshot = {
      now: Date.now(),
      job,
      relay,
      match,
      system,
      telemetry,
      log,
      errors,
      sourceIngest: source.ingest,
      sourceIngestReason: source.reason,
      runningMatchId,
    };
    const { health, headline } = deriveHealth(snap);
    // Ristiriidassa työ ja ajo ovat eri otteluista, ja BÅDE telemetria että
    // selostuslista on luettu työn ottelulla (`job.matchId`) — siis väärän.
    // Selostuslista ohittaa muuten tuoreusvartijan tarkoituksella (mennyt ajo
    // on historiaa), mutta tässä se piirtäisi toisen ottelun rivit tämän
    // hetken lähetyksenä ilman mitään merkkiä siitä (#118). Ei tietoa on
    // parempi kuin väärän ottelun tieto; otsikko kertoo miksi se on tyhjä.
    const conflicted = matchIdConflict(snap) !== null;
    return {
      // Server time: the phone's clock can be off, and "N s sitten" computed
      // against a wrong clock is worse than no timestamp.
      now: new Date().toISOString(),
      health,
      headline,
      chain: buildChain(snap, knobs),
      relay,
      match,
      system,
      knobs,
      sourceIngest: source.ingest,
      job,
      telemetry: conflicted ? null : telemetry,
      narration: conflicted ? [] : narration,
      log,
    };
  }

  function publish(): void {
    state = assemble();
    for (const fn of subscribers) {
      try {
        fn(state);
      } catch {
        // A broken SSE writer must not take down the poller for everyone else.
      }
    }
  }

  /** Every source is wrapped: one failing API must not stop the other five from
   *  updating, and the failure is recorded so its own chain row goes red
   *  instead of quietly showing the last good value. */
  async function track<T>(key: SourceKey, read: () => Promise<T>, apply: (value: T) => void): Promise<void> {
    try {
      apply(await read());
      errors.delete(key);
    } catch (err) {
      errors.set(key, err instanceof Error ? err.message : String(err));
    }
  }

  /** Miksi status-tiedoston `hard_stop` EI kelpaa tämän ajon syyksi, tai null
   *  kun se kelpaa. Erillinen funktio, jotta jokainen hylkäysperuste on
   *  testattavissa ja näkyy lokissa omalla nimellään. */
  function hardStopSnapshotStaleReason(
    snapshot: RelayTelemetry,
    current: Job,
    now: number
  ): string | null {
    if (snapshot.matchId !== current.matchId) {
      return `status kertoo ottelusta ${snapshot.matchId}, työ on ottelusta ${current.matchId}`;
    }
    const writtenAt = Date.parse(snapshot.at);
    if (!Number.isFinite(writtenAt)) return "statuksen aikaleima ei jäsenny";
    if (now - writtenAt > TELEMETRY_STALE_MS) {
      return `status on ${Math.round((now - writtenAt) / 1000)} s vanha`;
    }
    // Relayn oma aloitushetki ennen työn aloitushetkeä = eri ajo.
    const jobStartedAt = current.startedAt ? Date.parse(current.startedAt) : null;
    const runStartedAt = Date.parse(snapshot.startedAt);
    if (jobStartedAt !== null && Number.isFinite(jobStartedAt) && Number.isFinite(runStartedAt)) {
      if (runStartedAt < jobStartedAt - RUN_START_TOLERANCE_MS) {
        return "status on työtä vanhemmasta ajosta";
      }
    }
    return null;
  }

  /** Hard stopin siivous (#123). Ajetaan vain kun relayn oma telemetria kertoo
   *  että se sammutti itsensä takarajan takia (`endReason === "hard_stop"`) —
   *  siis ottelu oli päättynyt ja lähde oireili. Normaalissa lopetuksessa ei
   *  tehdä mitään: kohdelähetyksen sulkee YouTuben `enableAutoStop`, ja
   *  lähdettä ei kosketa lainkaan.
   *
   *  Lähteen sammutus on lisäksi lipun takana (CONTROL_HARD_STOP_SOURCE) —
   *  lähde on toisen ihmisen lähetys.
   *
   *  Ei koskaan heitä: kaikki menee errors-Mappiin ja lokiin, jotta työn
   *  sulkeminen ehtii tapahtua joka tapauksessa. */
  async function runHardStopCleanup(current: Job, now: number): Promise<void> {
    try {
      // Vain oikeasti käynnissä ollut ajo. Ehto on `startedAt` eikä status
      // "live", jotta sama siivous kelpaa myös sovittelun sulkemalle työlle
      // (joka on jo "finished"): ilman sitä ohjaamon uudelleenkäynnistys
      // päättyneen hard stopin jälkeen jättäisi kohde- JA lähdelähetyksen
      // päälle, mikä on juuri se vika jonka #123 poisti. Leimaamaton työ taas
      // tarkoittaa ettei relay koskaan päässyt liikkeelle — sen ajon hard
      // stopia ei ole olemassa, ja levyllä oleva syy on silloin väistämättä
      // EDELLISEN ajon.
      if (!current.startedAt) return;
      const snapshot = await readTelemetryFn(current.matchId);
      if (snapshot?.endReason !== "hard_stop") {
        return; // normaali lopetus (tai vanha deploy joka ei kerro syytä)
      }
      // Tuoreusvartija. Relay kirjoittaa statuksen kokonaan yli heti
      // käynnistyessään, joten normaali uusi ajo nollaa vanhan syyn — mutta jos
      // relay ei koskaan ehdi kirjoittaa (kaatuu ExecStartissa, config heittää),
      // levylle jää edellisen ajon "hard_stop". Ilman tätä vartijaa ohjaamo
      // sammuttaisi sen perusteella lähetykset, jotka ovat vasta alkamassa —
      // pahimmillaan toisen ihmisen lähdelähetyksen. Vaaditaan siis että
      // snapshot kuuluu TÄHÄN ajoon: oikea ottelu, tuore kirjoitus, ja relayn
      // oma aloitushetki vähintään työn aloitushetkestä.
      const staleReason = hardStopSnapshotStaleReason(snapshot, current, now);
      if (staleReason) {
        console.warn(
          `[control] hard stop -siivous ohitettu: status-tiedoston syy ei kuulu tähän ajoon (${staleReason})`
        );
        return;
      }
      const sourceVideoId = parseYouTubeVideoId(current.sourceUrl);
      const targets: Array<{ label: string; videoId: string | null; allowed: boolean; why: string }> = [
        { label: "kohde", videoId: current.targetVideoId, allowed: true, why: "" },
        {
          label: "lähde",
          videoId: sourceVideoId,
          allowed: hardStopSourceEnabled,
          why: "CONTROL_HARD_STOP_SOURCE ei ole päällä",
        },
      ];
      for (const target of targets) {
        if (!target.videoId) {
          console.warn(`[control] hard stop -siivous: ${target.label}lähetyksen video id ei tiedossa, ohitetaan`);
          continue;
        }
        if (!target.allowed) {
          console.warn(
            `[control] hard stop -siivous: ${target.label}lähetystä ${target.videoId} EI kosketa — ${target.why}`
          );
          continue;
        }
        try {
          const result = await transitionBroadcastFn(target.videoId);
          console.log(
            `[control] hard stop -siivous: ${target.label} ${target.videoId} (${result.lifeCycleStatus ?? "?"}) — ${result.reason}`
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[control] hard stop -siivous: ${target.label} ${target.videoId} epäonnistui: ${msg}`);
          errors.set("target", `hard stop -siivous (${target.label}) epäonnistui: ${msg}`);
        }
      }
    } catch (err) {
      // Telemetrian luku tai muu odottamaton: siivous jää tekemättä, työ
      // suljetaan silti.
      errors.set("target", `hard stop -siivous kaatui: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The relay shuts ITSELF down when the source ends — we never cut it short
   *  (uptime first), so a broadcast routinely finishes with nobody calling
   *  /api/relay/stop. This poller is the only always-on observer of that
   *  moment, so it is the one that lets go of the broadcast slot.
   *
   *  Falling edge only. "Relay is inactive" on its own is the normal state of a
   *  job that has been armed but not started yet, and closing that would cancel
   *  the next broadcast before it began (#101). */
  let relayWasActive = false;
  /** Työ jonka kanssa relay viimeksi nähtiin ajossa; ks. followRunEdges. */
  let runningJob: Job | null = null;
  /** Ottelu jonka ristiriidasta on jo varoitettu lokiin. Ilman tätä 5 s tikki
   *  kirjoittaisi saman rivin journaliin 12 kertaa minuutissa. */
  let conflictLoggedFor: number | null = null;

  /** Havainto siitä mitä relay ajaa — mutta vain jos sen kirjoitti TÄMÄ ajo.
   *
   *  Relay päivittää status-tiedoston vielä sammuessaan, joten päättyneen ajon
   *  tiedosto pysyy `readRunningStatus`in tuoreusikkunassa (60 s) minuutin
   *  ajan sen jälkeen kun mitään ei enää aja. Ilman tätä vartijaa sovittelu
   *  peruisi juuri aktivoidun SEURAAVAN ottelun työn, koska edellisen ottelun
   *  status yhä "kertoo" mitä relay muka ajaa — ja sidonta leimaisi työn
   *  käyntiin relayn ollessa alhaalla. mtime unitin käynnistyshetkeä vasten
   *  erottaa nämä täsmällisesti.
   *
   *  `activating` ei kelvo: ActiveEnterTimestamp osoittaa silloin vielä
   *  edelliseen ajoon, jolloin vanha tiedosto näyttäisi tämän ajon
   *  kirjoittamalta. */
  function trustedRunningMatchId(status: RunningStatus | null): number | null {
    if (!status) return null;
    if (relay.activeState !== "active" || relay.uptimeSec === null) return null;
    const unitStartedMs = Date.now() - relay.uptimeSec * 1000;
    return status.mtimeMs >= unitStartedMs ? status.matchId : null;
  }

  /** Sitoo armatun työn siihen ajoon jota relay OIKEASTI ajaa.
   *
   *  EI reunalaukaistu, toisin kuin sulkeminen: relay kirjoittaa
   *  `run/status-<matchId>.json`:nsa vasta sekunteja unitin aktivoitumisen
   *  jälkeen, joten reunahetkellä näyttöä ei yleensä vielä ole. Kertalaukaus
   *  jättäisi työn pysyvästi "arming"-tilaan ilman `startedAt`ia — siksi
   *  yritetään joka tikillä, kunnes näyttö löytyy tai relay sammuu.
   *
   *  Ennen tätä valinta oli "ensimmäinen arming-työ tiedostojärjestyksessä",
   *  joka 30.7.2026 sitoi ottelun 145900 ajon edellisen illan työhön (#118). */
  async function bindArmedJob(): Promise<void> {
    const current = job;
    if (current?.status !== "arming") return;
    if (runningMatchId === null) return; // ei näyttöä vielä — uusi yritys seuraavalla tikillä
    if (runningMatchId !== current.matchId) {
      // Puuttuva sidonta on parempi kuin väärä: ristiriita näkyy otsikossa ja
      // Relay-rivillä, ja operaattori näkee mitä relay oikeasti ajaa.
      if (conflictLoggedFor !== runningMatchId) {
        conflictLoggedFor = runningMatchId;
        console.warn(
          `[control] työtä ei sidota: relay ajaa ottelua ${runningMatchId}, avoin työ on ottelusta ${current.matchId}`
        );
      }
      return;
    }
    conflictLoggedFor = null;
    const started = await markRunStartedFn(runningMatchId);
    if (started) job = started;
  }

  /** Sulkee slotissa olevat työt jotka eivät ole se ajo joka oikeasti tapahtuu.
   *
   *  Tämä on lääke tilaan johon laskeva reuna ei koskaan yllä: reuna vaatii
   *  että ohjaamo oli katsomassa kun relay sammui, joten ohjaamon
   *  uudelleenkäynnistyksen yli jäänyt työ on sille ikuisesti näkymätön (#118,
   *  #101). Näyttöä vaaditaan aina — arvaus tässä sulkisi käynnissä olevan
   *  lähetyksen työn. */
  async function reconcileSlot(now: number): Promise<void> {
    let closed: Job[];
    if (relay.active) {
      if (runningMatchId === null) return; // ajossa, mutta ei tiedetä mitä
      closed = await reconcileOpenJobsFn(runningMatchId, now);
    } else {
      if (relayDownSince === null || now - relayDownSince < RECONCILE_SETTLE_MS) return;
      closed = await reconcileOpenJobsFn(null, now);
    }
    for (const c of closed) {
      console.warn(
        `[control] sovittelu sulki avoimen työn ${c.id} (ottelu ${c.matchId}) tilaan ${c.status}`
      );
      // Sama siivous kuin laskevalla reunalla: ohjaamon uudelleenkäynnistys ei
      // saa olla se ero, jäävätkö lähetykset päälle. Ajetaan sulkemisen
      // JÄLKEEN — siivous ei saa estää slotin vapautumista — ja sen omat
      // vartijat (oikea ottelu, tuore status, oikea ajo) päättävät edelleen
      // tehdäänkö mitään. Vanhentunut näyttö tarkoittaa että siivous jää
      // tekemättä; se on tarkoituksellista, ei unohdus.
      await runHardStopCleanup(c, now);
      if (job?.id === c.id) job = c;
    }
  }

  async function followRunEdges(): Promise<void> {
    const now = Date.now();
    const wasActive = relayWasActive;
    relayWasActive = relay.active;
    if (relay.active) relayDownSince = null;
    else if (relayDownSince === null) relayDownSince = now;

    // Työ jonka kanssa relay nähtiin ajossa. Laskeva reuna sulkee TÄMÄN eikä
    // sitä joka sattuu pitämään slottia sulkemishetkellä: force-aktivointi
    // ("lopeta edellinen ja aktivoi tämä", index.ts) pysäyttää relayn ja
    // vaihtaa slotin haltijan saman pyynnön sisällä, jolloin reuna ehti perua
    // juuri armatun SEURAAVAN ottelun työn ennen kuin sitä oli käynnistetty.
    if (relay.active && (job?.status === "arming" || job?.status === "live")) {
      runningJob = job;
    }

    try {
      // Falling edge: the run is over. Edge-triggered on purpose — "relay is
      // inactive" on its own is the normal state of a job that has been armed
      // but not started yet, and closing that would cancel the next broadcast
      // before it began (#101).
      const current = runningJob;
      if (wasActive && !relay.active && current) {
        // Hard stopin siivous ENNEN sulkemista: closeRunningJob nollaa
        // aktiivisen työn, jolloin sekä targetVideoId että sourceUrl katoavat
        // käsistä. Oma try/catch, koska siivous ei saa koskaan estää työn
        // sulkemista — muuten yksi YouTube-virhe jättäisi työn "live"-tilaan ja
        // lukitsisi seuraavan ottelun.
        await runHardStopCleanup(current, now);
        // Nimetty työ: poller sulkee sen ajon jota se seurasi, ei sitä joka
        // sattuu olemaan slotissa sulkemishetkellä.
        const closed = await closeRunningJobFn(current.id);
        if (closed && job?.id === closed.id) job = closed;
        runningJob = null;
      }
      await bindArmedJob();
      await reconcileSlot(now);
    } catch (err) {
      // Surfaced on the relay row rather than swallowed: a job stuck in
      // "arming" blocks the next match, and the operator has to know now.
      errors.set("job", err instanceof Error ? err.message : String(err));
    }
  }

  let fastBusy = false;
  async function tickFast(): Promise<void> {
    if (stopped || fastBusy) return; // a slow systemctl must not stack up calls
    fastBusy = true;
    try {
      await track("relay", getRelayProcess, (value) => {
        relay = value;
      });
      await track("system", getSystemState, (value) => {
        system = value;
      });
      await track("log", () => readLog({ limit: LOG_LINES }), (value) => {
        log = value;
      });
      // The job file is a local read; it drives which match we poll, so it has
      // to refresh at the fast cadence rather than the match one.
      await track("job", readActiveJob, (value) => {
        job = value;
      });
      // Mitä relay oikeasti ajaa. Luetaan ENNEN reunoja, koska sekä sidonta
      // että sovittelu tarvitsevat sen. Oma vartija: tämä on hakemistoluku,
      // eikä sen epäonnistuminen saa estää työn sulkemista — silloin
      // runningMatchId jää nulliksi ja molemmat odottavat näyttöä.
      try {
        runningMatchId = trustedRunningMatchId(await getRunningStatusFn());
      } catch {
        runningMatchId = null;
      }
      // Ilman unitin käynnistyshetkeä työtä ei voi sitoa mihinkään, eikä hard
      // stopin siivousta voi tehdä — mutta kaikki rivit näyttäisivät vihreää.
      // Ainoa tunnettu syy on ettei systemd:n aikaleima jäsenny (vyöhyke-
      // lyhenne UTC:n sijaan), ja se on juuri sellainen hiljainen vika jonka
      // takia tämä koko korjaus tehtiin: sanotaan se ääneen.
      if (relay.activeState === "active" && relay.uptimeSec === null) {
        errors.set(
          "job",
          "systemd ei kerro relayn käynnistyshetkeä (ActiveEnterTimestamp) — työtä ei voi sitoa ajossa olevaan otteluun"
        );
      }
      await followRunEdges();
      if (job) {
        const matchId = job.matchId;
        await track("knobs", () => readKnobs(matchId), (value) => {
          knobs = value;
        });
        // The relay's own telemetry: two local file reads, so it belongs on the
        // fast cadence — a narration line the operator can already hear should
        // not wait ten seconds to appear on the phone.
        await track("telemetry", () => pollTelemetry(matchId), () => undefined);
      } else {
        knobs = null;
        telemetry = null;
        timeline = null;
        narration = [];
      }
      publish();
    } finally {
      fastBusy = false;
    }
  }

  /** Reads what the relay published about itself. Both halves are wrapped by
   *  one `track` key: they describe the same source, and a partial success
   *  ("status fine, timeline unreadable") must not read as healthy. */
  async function pollTelemetry(matchId: number): Promise<void> {
    if (!timeline || timelineMatchId !== matchId) {
      timeline = new NarrationTimeline(matchId);
      timelineMatchId = matchId;
      narration = [];
    }
    telemetry = await readRelayStatus(matchId);
    await timeline.poll();
    narration = timeline.lines();
  }

  let matchBusy = false;
  async function tickMatch(): Promise<void> {
    if (stopped || matchBusy) return;
    // Never poll pesistulokset without a job: it is someone else's public API
    // and an idle control app has no business hitting it at all.
    if (!job) {
      match = emptyMatch();
      return;
    }
    matchBusy = true;
    const matchId = job.matchId;
    try {
      await track("api", () => getMatchState(matchId), (value) => {
        match = value;
      });
      publish();
    } finally {
      matchBusy = false;
    }
  }

  const fastTimer = setInterval(() => void tickFast(), FAST_POLL_MS);
  const matchTimer = setInterval(() => void tickMatch(), MATCH_POLL_MS);
  // Fill the first snapshot immediately; a client connecting at second 1
  // shouldn't stare at an empty view for a full poll interval.
  void tickFast().then(() => tickMatch());

  return {
    subscribe(fn) {
      subscribers.add(fn);
      // Hand the newcomer the current state right away, so the SSE connection
      // renders before the next tick.
      try {
        fn(state);
      } catch {
        /* see publish() */
      }
      return () => subscribers.delete(fn);
    },
    current() {
      return state;
    },
    stop() {
      stopped = true;
      clearInterval(fastTimer);
      clearInterval(matchTimer);
      subscribers.clear();
    },
  };
}
