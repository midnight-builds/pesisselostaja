import { fetchMatchMetadata, fetchLiveEvents, formatHelsinkiTimestamp, type LiveEventsResult } from "@pesisselostaja/core";
import { EventHistory } from "./eventHistory.js";
import {
  buildPlayerLookup,
  groupSubEventsForSpeech,
  groupToSpeech,
  subEventFeedDetail,
  isRunScoringSubEvent,
  isOutSubEvent,
  isMatchEndSubEvent,
  runValueOfSubEvent,
  eventFingerprint,
  recomputeCurrentOutsKeyed,
  outsThroughSubEvent,
  formatStartupSpeech,
  formatBatTurnChangeSpeech,
  formatSituationSummary,
  formatIdleSummary,
  formatMatchEnd,
  formatWelcomeFiller,
  formatIntroFiller,
  decideFiller,
  periodName,
  type PlayerLookup,
  type SpeechContext,
} from "@pesisselostaja/core";
import {
  loadState,
  saveState,
  getPeriodScore,
  addRun,
  periodsWon,
  periodsPlayed,
  type WatcherState,
} from "./nodeState.js";
import {
  loadPronunciations,
  applyPronunciations,
  preventOrdinalReading,
  type PronunciationRule,
} from "./nodePronunciation.js";
import type { LiveEvent, MatchMetadata } from "@pesisselostaja/core";
import type { SlateSituation, SourceIngestObservation } from "./ffmpegMixer.js";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { logDebug, logError, logInfo, logWarn } from "./log.js";
import type { RelayConfig } from "./config.js";

/** Kuinka usein pollien yhteenveto kirjataan (#120). 20 s on kompromissi:
 *  tiheämpi täyttäisi ohjaamon 50 rivin lokikkunan, harvempi ei erottelisi
 *  145900:n kaltaista ~50 sekunnin katvetta. */
const POLL_SUMMARY_MS = 20_000;

const SUMMARY_EVERY_N = 10;
/** No speech for this long → break the silence with an idle filler. 90 s
 *  (was 2 min): with the pipeline's own latency on top, a 2 min gap already
 *  felt like the narration had died. */
const IDLE_FILLER_MS = 90 * 1000;
/** Pre-game: welcome-filler cadence while waiting for the match to start. */
const WELCOME_FILLER_MS = 90 * 1000;
/** Full events fetch timeout (see apiTimeoutMs() for the effective value).
 *
 *  10 s, not the earlier 4 s: a full events fetch returns the WHOLE match
 *  history, which grows monotonically through the match, so a constant tuned on
 *  an empty history stops fitting later on. A live match logged 12 aborted
 *  fetches in two minutes, in streaks of 3–5, all cut at exactly 4.0 s — i.e.
 *  the timeout, not the API, was the failure (issue #47). Polls are sequential
 *  (each cycle awaits its fetch before the next is scheduled, see run()), so a
 *  longer timeout can never pile requests on top of each other; it only delays
 *  the next poll, and the no-overlap guard resumes the cadence from now. 10 s is
 *  the ceiling proposed in #47 and still well under the failure windows that
 *  decide whether the relay gives up. */
const FULL_FETCH_TIMEOUT_MS = 10_000;
/** Delta poll timeout — the fetch that runs EVERY poll (issues #81, #156).
 *
 *  1 s, retuned from 4 s on the relay's own measurements. #47's "be patient,
 *  the body grows" reasoning never applied here: a delta returns only the new
 *  events, a 304 not even that.
 *
 *  What a whole match measured (136745, 1.8.2026, 104 min, `api.poll_window`):
 *  median 72–83 ms, max typically 90–132 ms — and 67 aborts at exactly 4.0 s,
 *  i.e. the timeout firing, not the API answering slowly. Nothing lands in
 *  between. A delta either answers inside ~150 ms or the connection is stuck,
 *  so this constant is a stuck-connection detector, not a slowness allowance;
 *  1 s is ~7x the observed max and ~6x the p99 measured under camp-day load
 *  against four simultaneously live matches (p50 96 ms, p99 169 ms, max 303 ms;
 *  a cold TCP+TLS+DNS connection was 173 ms).
 *
 *  What this buys, stated honestly: NOT a faster retry. run() sets the next
 *  poll time before the fetch (see the cadence line in run()), so a 4 s abort
 *  overran the 3 s cadence and the retry fired immediately, while a 1 s abort
 *  fits inside the cadence and the retry waits out the remaining ~2 s. The gain
 *  per stuck poll is therefore ~1 s of latency at the head of the speech chain
 *  (fetch -> state -> TTS -> speak) — and, more to the point, a poll cadence
 *  that stops being knocked out of step ~0.6 times a minute. Retrying an
 *  aborted poll immediately instead of waiting for the cadence is the rest of
 *  the win, but it needs a backoff for a genuinely dead API first: issue #52.
 *
 *  NOT floored at `pollIntervalMs` — see apiTimeoutMs(). */
const DELTA_FETCH_TIMEOUT_MS = 1_000;
/** The delta timeout after FETCH_FAILURE_ALARM_STREAK consecutive failures —
 *  i.e. the pre-#156 value, given back exactly when the tight one might be
 *  wrong.
 *
 *  The measurement above says a delta answers in ~80 ms or not at all, but it
 *  was taken against a HEALTHY API. If that ever stops holding — an API that
 *  genuinely answers in 1–4 s — a fixed 1 s limit would abort every single
 *  delta, and the only thing still getting through would be the 60 s resync
 *  full fetch. Narration would run up to a minute behind while the log filled
 *  with timeouts that look identical to the stuck connections this retune was
 *  aimed at. A streak is the one signal that separates the two cases: stuck
 *  connections came in ones (31/31 retries succeeded first try, #156), so a
 *  third failure in a row means the assumption itself is off.
 *
 *  Deliberately NOT a general backoff: the poll cadence still does not flex in
 *  a failure streak, and an aborted poll still waits for the next tick rather
 *  than retrying at once. That is issue #52, and it belongs there. */
const DELTA_FETCH_TIMEOUT_SLOW_MS = 4_000;
/** How many SUCCESSFUL polls the loosened delta timeout stays in force after a
 *  failure streak opened it — the valve's hysteresis.
 *
 *  Without it the valve does nothing it promises. `recordPollSuccess()` clears
 *  the failure streak, so a valve keyed on the streak alone would shut on the
 *  very first poll it helped: against an API that genuinely answers in 1–4 s
 *  the cycle would be 3 aborts at 1 s → one poll at 4 s → success → streak
 *  cleared → back to 1 s → abort. Three deltas out of every four dropped,
 *  fresh data every ~12 s instead of 3 s, and the log full of "HUOM,
 *  hakuvirhesarja" lines that the ohjaamo puts in front of the operator.
 *
 *  10 is chosen from both directions, and deliberately from the small end:
 *  - Long enough to be a state, not a blip. At the 3 s default cadence it is
 *    ~30 s of uninterrupted healthy polling before the tight limit comes back,
 *    while the noise it must ignore is a SINGLE stuck connection (~0.6 per
 *    minute, i.e. one per ~100 polls, 31/31 retries succeeding first try —
 *    #156). Ten clean polls in a row cannot be produced by that noise.
 *  - Short enough to cost almost nothing when the valve opened by accident.
 *    The only price of the loose limit is that a stuck connection is again
 *    waited out for 4 s instead of 1 s, and at that failure rate ten polls
 *    span at most one such connection: ~3 s of extra latency, once, before
 *    the tight limit is back. A much larger N would quietly re-ship the
 *    pre-#156 behaviour for the rest of the match.
 *
 *  Honest residual: a genuinely slow API makes this settle into ~10 good polls
 *  followed by 3 aborts (23 % dropped, against 75 % with no dwell at all), not
 *  a permanently open valve. Closing that gap needs the valve to key on the
 *  MEASURED duration of successful deltas rather than on failures; that is a
 *  bigger change and there is still no match's worth of data showing an API
 *  that behaves this way. */
const DELTA_SLOW_DWELL_POLLS = 10;
/** Metadata (roster) fetch timeout: the startup fetch and the in-match roster
 *  refresh (`maybeRefreshRoster`).
 *
 *  4 s, i.e. the pre-#156 value, DELIBERATELY left alone. It used to share a
 *  constant with the delta poll, which is why #156's retune had to split them:
 *  every number in that measurement is a delta's. Metadata is fetched a handful
 *  of times per match and returns both full rosters, so a delta's spread says
 *  nothing about its spread — and being wrong here is expensive and silent. A
 *  refresh that always times out is swallowed by design (`maybeRefreshRoster`
 *  keeps the names it has), so the relay would speak stale player numbers for
 *  the whole match with nothing but a warning line to show for it.
 *
 *  Retune this from `api.poll_window`'s own `meta` bucket once a match's worth
 *  of it exists — not from the delta numbers. */
const META_FETCH_TIMEOUT_MS = 4_000;

/** Käynnistyshakujen uudelleenyritysten odotukset (#158).
 *
 *  Käynnistyksen haut tehdään vasta kun mikseri jo työntää kuvaa selostettuun
 *  lähetykseen, joten yksi hylätty lupaus kaataisi prosessin ja systemd
 *  käynnistäisi sen 10 s:n päästä uudelleen — katsojalle musta ruutu. Siksi
 *  käynnistys ei koskaan kaadu hakuvirheeseen, vaan yrittää uudelleen kunnes
 *  onnistuu tai relay sammutetaan. Viimeinen arvo toistuu loputtomiin, eli
 *  API:ta ei hakata mutta yhteys palautuu itsestään puolen minuutin sisällä
 *  siitä kun API taas vastaa. */
const STARTUP_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

/** Monennenko epäonnistuneen käynnistysyrityksen jälkeen lokitetaan ERROR
 *  WARNin sijaan: yksittäinen tökkiminen on odotettavaa, mutta jatkuva ei — ja
 *  se pitää näkyä operaattorille ilman että hän lukee koko lokin. */
const STARTUP_RETRY_ERROR_AFTER = 3;

/** Yhden pollausikkunan onnistuneiden hakujen kestot yhdeksi luettavaksi
 *  palaseksi (#156).
 *
 *  Mediaani ja maksimi, ei keskiarvoa: yksi 4 sekunnin haku 20 sadan
 *  millisekunnin haun joukossa siirtäisi keskiarvoa 200 ms:iin ja piilottaisi
 *  sekä normaalin tason että poikkeaman. Mediaani kertoo tason, maksimi
 *  kertoo pahimman — ja juuri niiden välinen ero on se, jonka perusteella
 *  aikakatkaisu asetetaan.
 *
 *  Otos on ikkunakohtainen (nollataan joka yhteenvedossa), joten se ei kasva
 *  ottelun mitassa eikä vuoda muistia. */
/** The three fetch shapes, each with its own timeout and its own duration
 *  sample. They were two ("small" / "full") until #156: lumping the delta poll
 *  together with the metadata fetch meant the shared sample was ~99 % deltas —
 *  3 s cadence against a handful of roster reads — so the metadata fetch was
 *  invisible in the very number used to justify its timeout. */
export type FetchSize = "delta" | "meta" | "full";

export function formatFetchDurations(samples: number[]): string {
  if (samples.length === 0) return "ei onnistuneita hakuja";
  const sorted = [...samples].sort((a, b) => a - b);
  // Pariton pituus antaa keskimmäisen, parillinen alemman keskimmäisistä.
  // Tarkka interpolointi ei ole tässä minkään arvoista: luku luetaan lokista
  // silmällä, ei syötetä mihinkään.
  const median = sorted[Math.floor((sorted.length - 1) / 2)] as number;
  const max = sorted[sorted.length - 1] as number;
  return `mediaani ${median} ms, max ${max} ms (n=${sorted.length})`;
}
/** Delta polling: events carry no per-event
 *  wall-clock field (verified against real data 2026-07-17 — only the
 *  match-epoch-relative `timestamp`), so the `after=` value is derived from
 *  the last successful response's Date header minus this safety margin. The
 *  margin must exceed the API's publish delay (~68–123 s measured with
 *  skip-delay), or an event could become visible only after our `after` has
 *  already moved past its server-side wall-clock time and be missed.
 *
 *  Consequence, and the root cause behind issue #46: for the first
 *  AFTER_MARGIN_MS after the scorer opens a match, `after` necessarily points
 *  BEFORE the instant the server created that match's online data, which is
 *  precisely when the server answers with `reset` (see LiveEventsResponse.reset
 *  and handleResetResponse). That burst is expected, self-healing and cheap —
 *  as long as the reset answer is used as the full snapshot it already is. */
const AFTER_MARGIN_MS = 180 * 1000;
/** Periodic full refetch that replaces the local delta-merged history —
 *  cheap insurance against anything the merge can't see (server rewrites,
 *  period-3 re-keyed transients). */
const RESYNC_EVERY_MS = 60 * 1000;
/** Floor for the control file's pollIntervalMs — the server response cache is
 *  ~5 s, so polling much faster only burns requests. */
const MIN_POLL_INTERVAL_MS = 2000;
/** Consecutive UNEXPLAINED reset answers that trip the breaker and drop the
 *  run back to plain full fetches. "Unexplained" matters: a reset whose
 *  instant is newer than the `after` we sent explains itself (our baseline
 *  simply predates the match's online data) and is guaranteed to happen for
 *  AFTER_MARGIN_MS at the start of every match — counting those would trip the
 *  breaker in every single broadcast and leave delta off for the rest of it.
 *  A reset costs one request either way now (see handleResetResponse), so the
 *  breaker is only a backstop for a server that resets for reasons we cannot
 *  see. 5 in a row is well past noise and still trips within ~15 s at the
 *  default cadence. */
const DELTA_RESET_BREAKER_STREAK = 5;

/** How many consecutive failed poll cycles before the failure log line turns
 *  alarming. A lone timeout is routine — one live match saw 22 isolated 8 s
 *  client-timeout blips in 45 min with zero events lost (the next poll always
 *  caught up) — so only a streak deserves attention. */
const FETCH_FAILURE_ALARM_STREAK = 3;

/** Jakson nimi katvekuvan tilanneriville. Erillään core'n `periodName`ista,
 *  joka tuottaa puhuttavan muodon ("ensimmäinen jakso"); ruudulle mahtuu ja
 *  luetaan nopeammin lyhyt "1. jakso". Jaksonumerointi on sama kuin kaikkialla
 *  muualla: 0 = 1. jakso, 2 = supervuoro, 3 = kotiutuslyöntikilpailu. */
function slatePeriodName(period: number): string {
  switch (period) {
    case 0: return "1. jakso";
    case 1: return "2. jakso";
    case 2: return "supervuoro";
    case 3: return "kotiutuslyöntikilpailu";
    default: return `${period + 1}. jakso`;
  }
}

/** Jäsentää control-tiedoston `sourceIngest`-avaimen. Palauttaa null kaikesta
 *  mikä ei ole täydellinen havainto: puuttuva, rikkinäinen tai vieraan
 *  muotoinen arvo tarkoittaa "ei tietoa", ei "lähde poikki". */
function parseSourceIngest(raw: unknown): SourceIngestObservation | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.observedAt !== "string" || !Number.isFinite(Date.parse(rec.observedAt))) return null;
  if (typeof rec.videoId !== "string") return null;
  const optional = (key: string): string | null => (typeof rec[key] === "string" ? (rec[key] as string) : null);
  return {
    observedAt: rec.observedAt,
    videoId: rec.videoId,
    lifeCycleStatus: optional("lifeCycleStatus"),
    streamStatus: optional("streamStatus"),
    healthStatus: optional("healthStatus"),
    error: optional("error"),
  };
}

export type SpeechSink = (spokenText: string, readableText: string) => Promise<void>;

/** Lets the loop see the narration output stage so it can decide whether a
 *  pre-game filler is worth synthesizing right now. Kept as a
 *  narrow port rather than a direct FfmpegMixer reference so the loop stays
 *  testable and decoupled from ffmpeg. When absent (dry-run/tests) the loop
 *  treats narration as always ready, preserving the old behavior. */
export interface NarrationStatus {
  /** True while ffmpeg is attached and draining the FIFO in real time. */
  isReaderAttached(): boolean;
  /** Clips still queued for playback but not yet drained. */
  pendingClips(): number;
  /** Wall clock of the FIRST ffmpeg attach ever (never reset on respawns),
   *  or null before any attach. The first-speech grace period
   *  (RELAY_FIRST_SPEECH_DELAY_MS) is measured from this. */
  firstAttachedAt(): number | null;
}

/** Observes a narration clip through its stages, for telemetry. Optional and
 *  fire-and-forget: the loop never reads anything back and never awaits it, so
 *  an observer cannot change what gets said or when.
 *
 *  `muted` is the field that pays for this whole port. A clip decided before
 *  ffmpeg attached is fully accounted for — dedupe, scoring and turn state all
 *  ran — but nobody heard it, and the old log recorded that as an ordinary
 *  line. In match 145889 on 29.7.2026 that hid five minutes of lost narration
 *  including two runs. Counting muted separately makes it visible on the
 *  operator's phone while it is still happening. */
export interface NarrationObserver {
  detected(clip: { id: string; text: string }): void;
  spoken(clip: { id: string; text: string }, muted: boolean): void;
}

/** How often the roster is re-read while it can still change (issue #90).
 *  The lineup is published late — `away.players` can still be empty minutes
 *  before the first pitch — and it can change between the relay starting and
 *  the scorer opening the match. Once a minute is often enough to catch that
 *  without adding meaningful load to an API we don't own. */
const ROSTER_REFRESH_MS = 60_000;

/** Both teams have at least one player. Until then a name cannot be resolved
 *  at all, so there is no point settling on the lookup we have. */
function rostersPopulated(meta: MatchMetadata): boolean {
  return meta.home.players.length > 0 && meta.away.players.length > 0;
}

/** Jersey number -> surname, per team, as one comparable string. Compared
 *  rather than counted, because the failure this guards against is a number
 *  pointing at a DIFFERENT player, not a shorter list. */
function rosterSignature(meta: MatchMetadata): string {
  return [meta.home, meta.away]
    .map((team) => `${team.id}:${team.players.map((p) => `${p.number}=${p.last_name}`).sort().join(",")}`)
    .join("|");
}

/** The names the narration speaks, and the metadata they came from. */
interface RosterSnapshot {
  meta: MatchMetadata;
  lookup: PlayerLookup;
}

/** Standalone ~6s poll loop that reproduces WatcherController's announcement
 *  content/timing (src/watcher.ts) using the same pure speech/state helpers,
 *  but hands each announcement to a SpeechSink (narration synthesis) instead
 *  of Home Assistant/browser output. Deliberately a separate implementation,
 *  not a reuse of WatcherController, since that class is wired to HA/browser
 *  output — see apps/broadcast/DESIGN.md. */
export class CommentaryLoop {
  private state: WatcherState;
  private pronunciations: PronunciationRule[];
  private lastSpeech: string | null = null;
  private lastSpeechAt = 0;                // wall clock of the last spoken announcement
  private lastSummaryCount = 0;
  /** Jakso, jolle selostajan esittely on jo puhuttu (issue #247). */
  private lastIntroPeriod: number | null = null;
  /** Order-preserving queue for sink calls (TTS synthesis + mix), decoupled
   *  from the poll loop — see speak(). */
  private synthQueue: Promise<void> = Promise.resolve();
  private abort: AbortController | null = null;
  /** Current effective value of the batter-change setting. Seeded from config
   *  at startup, then overridable mid-match via the control file. */
  private announceBatterChanges: boolean;
  /** Current effective narration delay (ms). Seeded from config, overridable
   *  mid-match via the control file. See speak() for how it's applied without
   *  touching dedupe/state bookkeeping. */
  private narrationDelayMs: number;
  /** Latched permanently true the first time the ffmpeg reader is seen
   *  attached (or immediately when there is no status port — dry-run/tests).
   *  Before the latch, speak() runs its bookkeeping but skips the sink handoff
   *  entirely: clips synthesized before the FIRST attach would pile up in the
   *  FIFO and play out minutes stale in one burst on connect. AFTER the latch
   *  the behavior deliberately never reverts —
   *  mid-game ffmpeg drops (flapping source) keep queueing event narration
   *  exactly as before, since a short outage losing all narration is the
   *  worse failure mode there (observed live); revisiting that is a separate
   *  open question. */
  private narrationEverReady: boolean;
  /** True if any speech was suppressed pre-latch, so the latch moment knows
   *  to speak one fresh catch-up recap instead of the stale suppressed clips. */
  private suppressedBeforeAttach = false;
  /** Roster refresh bookkeeping (issue #90). See maybeRefreshRoster. */
  private rosterRefreshedAt = 0;
  private rosterRefreshedAfterStart = false;
  private rosterSettled = false;
  /** False until the match has produced any event — the endpoint always
   *  returns the full history, so an empty history means the game genuinely
   *  hasn't started and the loop speaks welcome fillers instead of recaps. */
  private matchStarted = false;
  /** Estimated wall-clock instant (ms) corresponding to event.timestamp=0,
   *  for the first-seen delay log. The API gives no epoch
   *  field, so this is inferred from observed events: since publish delay is
   *  always ≥0, (first-seen walltime − timestamp) is an upper bound on the
   *  true epoch, and the running minimum over all first-seen events
   *  converges toward it. Carries a constant bias equal to the lowest true
   *  delay seen so far — good enough to compare jitter/trends within a run,
   *  not an authoritative clock. */
  private matchEpochMs: number | null = null;
  /** Current effective poll interval. Seeded from config, overridable live
   *  via the control file's pollIntervalMs (min MIN_POLL_INTERVAL_MS). */
  private pollIntervalMs: number;
  /** Delta polling on/off. Seeded from config (RELAY_DELTA_FETCH), flippable
   *  live via the control file's deltaFetch — false reverts to plain full
   *  fetches on the next poll, no restart needed. */
  private deltaFetch: boolean;
  /** Local full-history mirror the delta responses merge into, so all event
   *  processing keeps seeing the complete history every poll (the existing
   *  logic assumes that — see EventHistory). */
  private history = new EventHistory();
  /** Date header (ms epoch) of the last successful 200 events response; the
   *  next `after=` value derives from this (see AFTER_MARGIN_MS). */
  private lastServerDateMs: number | null = null;
  /** When the local history was last replaced by a full fetch (RESYNC_EVERY_MS). */
  private lastFullFetchAt = 0;
  /** The exact `after` string currently in use plus the ETag its last 200
   *  carried. The ETag is only ever sent while the URL (the after value)
   *  stays the same — the base only advances when new events arrive, so quiet
   *  stretches poll a stable URL and get cheap 304s. */
  private deltaCursor: { after: string; afterMs: number; etag: string | null } | null = null;
  /** Cumulative per-run poll statistics, surfaced on the mixer's heartbeat
   *  line — 304 skips, full-fetch fallbacks and reset
   *  answers are otherwise invisible in the log (the 304 path is deliberately
   *  silent, and reset answers only log once per streak). */
  private pollStats = { polls: 0, deltaMerges: 0, fullFetches: 0, notModified: 0, deltaResets: 0, fetchFailures: 0 };
  /** Ikkunoitu pollikirjanpito (#120). Kumulatiiviset `pollStats` kertovat
   *  ajon kokonaisuudesta ja näkyvät sydänäänessä kahden minuutin välein — ne
   *  eivät kerro mitään siitä, mitä *juuri äsken* tapahtui. Ottelussa 145900
   *  (30.7.2026) kysymys oli tasan tämä: 08:39:22 ja 08:40:14 välissä ei ole
   *  yhtään onnistuneen haun riviä, eikä lokista voi päätellä ajettiinko
   *  pollit lainkaan vai palauttiko API vanhentunutta dataa. Tyhjä polli ei
   *  jättänyt jälkeä, koska `api.delta_fetch` lokitetaan vain kun uutta
   *  löytyy. */
  private pollWindow = {
    polls: 0,
    notModified: 0,
    delta: 0,
    full: 0,
    resets: 0,
    failures: 0,
    /** Tapahtumien määrä viimeisimmässä 200-vastauksessa. Erottaa "pollit
     *  eivät ajaneet" tilanteesta "pollit ajoivat ja API vastasi vanhaa". */
    lastEventCount: null as number | null,
    newEvents: 0,
    /** ONNISTUNEIDEN hakujen kestot ikkunan ajalta, millisekunteina, ERIKSEEN
     *  kummallekin aikakatkaisulle (#156).
     *
     *  Ennen tätä kesto kirjattiin vain epäonnistuneesta hausta
     *  (`api.fetch_failed`), eli pelkästä jakauman hännästä. Aikakatkaisuja on
     *  siksi viritetty kahdesti (#47, #81) ilman että keskiosaa on kertaakaan
     *  mitattu.
     *
     *  Kaksi syytä pitää ne erillään, ja molemmat opittiin kantapään kautta:
     *
     *  1. Niitä säätelee ERI raja (`FULL_FETCH_TIMEOUT_MS` 10 s,
     *     `META_FETCH_TIMEOUT_MS` 4 s, `DELTA_FETCH_TIMEOUT_MS` 1 s). Yhteen
     *     taulukkoon sekoitettuna raportoitu maksimi voi olla haku, jota
     *     arvioitava raja ei koske — ja koko #156 on olemassa siksi, ettei
     *     rajaa perusteltaisi väärällä joukolla. Sekoitus olisi ollut sama
     *     kehäpäätelmä uudessa muodossa.
     *  2. Ne ovat oikeasti eri kokoisia: täyshaku palauttaa koko historian
     *     (mitattu ~32 kt ottelun lopussa), meta molemmat kokoonpanot, delta
     *     vain uudet tapahtumat.
     *
     *  Delta ja meta erotettiin toisistaan vasta #156:n virityksessä. Ne
     *  jakoivat rajan ja siten myös otoksen, ja koska deltoja tulee 3 s välein
     *  ja metahakuja kourallinen koko otteluun, yhteinen mediaani oli
     *  käytännössä pelkkää deltaa — eli metahaun rajaa oltiin perustelemassa
     *  luvuilla, joissa metahakua ei näkynyt.
     *
     *  Epäonnistuneita EI lasketa: niiden kesto on määritelmällisesti
     *  aikakatkaisu, joten ne vetäisivät jakauman kohti sitä rajaa, jota tällä
     *  on tarkoitus arvioida. Ne näkyvät erikseen `virhe`-lukumääränä. */
    fetchMs: { delta: [] as number[], meta: [] as number[], full: [] as number[] },
  };
  private lastPollSummaryAtMs = Date.now();
  /** Consecutive failed poll cycles; reset by the first success. Drives the
   *  alarm threshold (FETCH_FAILURE_ALARM_STREAK) and the streak position on
   *  the failure log line. */
  private consecutiveFetchFailures = 0;
  /** Successful polls still owed to the loosened delta timeout (hysteresis, see
   *  DELTA_SLOW_DWELL_POLLS). Armed when a failure streak reaches the alarm
   *  threshold, decremented by each success — NOT cleared by the first one. */
  private slowDeltaDwellPolls = 0;
  /** Consecutive reset answers of any kind; cleared by any delta that actually
   *  merges or 304s. Only drives the log (one line per streak, not per poll —
   *  the match-start streak is ~60 polls long at the default cadence). */
  private consecutiveDeltaResets = 0;
  /** Consecutive reset answers our own `after` does NOT explain. Drives
   *  DELTA_RESET_BREAKER_STREAK; cleared alongside consecutiveDeltaResets. */
  private consecutiveUnexplainedResets = 0;
  /** Set when the breaker turned delta off by itself, so the reset log line
   *  stays silent afterwards and a manual re-enable can tell the two apart. */
  private deltaBreakerTripped = false;
  /** Monotonic per-run counter behind each clip's telemetry id. */
  private clipSeq = 0;
  /** Wall clock of the last time a NEW event appeared — our own observation
   *  instant, which is the useful one anyway: it answers "is the scorer still
   *  entering results", not "how far into the match are we". (Events also
   *  carry a wall-clock `created` field, see LiveEvent; not needed here.) */
  private lastEventSeenAt: string | null = null;
  /** Ottelutiedot, haettu kerran run():n alussa. Talletetaan, jotta katvekuvan
   *  pisterivi osaa joukkueiden nimet ilman toista hakua. */
  private meta: MatchMetadata | null = null;
  /** Viimeisin control-tiedostosta luettu `sourceIngest`-havainto (ohjaamo
   *  kirjoittaa sen, PR #112), tai null kun avainta ei ole tai se ei jäsenny.
   *  Loop ei tee sillä mitään itse — se vain välittää sen mikserille, joka
   *  päättää. Luetaan täällä, koska tämä on ainoa paikka joka lukee
   *  control-tiedostoa. */
  private sourceIngestValue: SourceIngestObservation | null = null;

  constructor(
    private config: RelayConfig,
    private sink: SpeechSink,
    private narrationStatus?: NarrationStatus,
    private observer?: NarrationObserver
  ) {
    this.state = loadState(config.stateFile);
    this.pronunciations = loadPronunciations(config.pronunciationsFile);
    this.announceBatterChanges = config.announceBatterChanges;
    this.narrationDelayMs = config.narrationDelayMs;
    this.pollIntervalMs = config.pollInterval;
    this.deltaFetch = config.deltaFetch;
    // No status port = nothing to wait for: latch immediately (old behavior).
    this.narrationEverReady = !narrationStatus;
  }

  /** Telemetry: how many events the local mirror holds, and when the newest
   *  one happened. A stalled lastEventAt with a healthy relay is the signature
   *  of a scorer who stopped entering results — invisible in the relay's own
   *  health, and the operator's problem to chase. */
  get eventCount(): number {
    return this.history.size;
  }

  get lastEventAt(): string | null {
    return this.lastEventSeenAt;
  }

  /** Whether the match has ended ("Ottelu päättyi" seen, not reopened) — read
   *  by the ffmpeg supervisor to pick the shorter give-up window
   *  (finishedFailureWindowMs) once retrying a dead source is pointless. */
  get matchFinished(): boolean {
    return this.state.finished;
  }

  /** Compact poll-statistics fragment for the mixer's heartbeat line, e.g.
   *  "pollit 118 (delta 102, täyshaku 9, 304 5, hakuvirheitä 2)". A tripped
   *  delta breaker is appended so every later heartbeat still says why the
   *  delta count stopped moving — the one-off trip line scrolls away. */
  /** Katvekuvan ("EI SIGNAALIA") kaksi tekstiriviä VALMIIKSI muotoiltuina.
   *  Mikseri vain näyttää nämä eikä laske pisteitä tai paloja itse — se ei saa
   *  joutua tuntemaan pesäpallon sääntöjä. Ennen ottelun ensimmäistä
   *  tapahtumaa molemmat ovat tyhjiä, jolloin kuvassa on pelkkä "EI
   *  SIGNAALIA" + alatunniste; se on kelvollinen lopputulos.
   *
   *  Näyttömuoto, ei puhemuoto: `periodName` tuottaa selostukseen sopivan
   *  "ensimmäinen jakso", kun kuvassa lukee lyhyempi "1. jakso".
   *
   *  Muoto on **nimi–pisteet-pareina** ("Kotipesä 12 – Lyöntilä 1"), ei
   *  issuen sommittelussa ehdotettu "koti 12 - 1 vieras". Syy on luettavuus:
   *  keskitetyllä tekstirivillä ilman värilaatikoita vierasjoukkueen luku
   *  tarttuu visuaalisesti sen nimeen, ja ensimmäinen ihminen joka näki
   *  esikatselukuvan luki "1 Lyöntilä" joukkueen nimenä. Pari kerrallaan
   *  lukutapa on yksikäsitteinen.
   *
   *  Pisteet ovat KULUVAN JAKSON pisteet, eivät ottelun yhteispisteitä — se on
   *  pesäpallon oikea lukema, ja tilannerivi kertoo minkä jakson (CLAUDE.md). */
  get slateSituation(): SlateSituation {
    if (!this.meta || !this.matchStarted) return { score: "", situation: "" };
    const cur = getPeriodScore(this.state, this.state.currentPeriod);
    const outs = this.state.currentOuts;
    return {
      score: `${this.meta.home.name} ${cur.home} – ${this.meta.away.name} ${cur.away}`,
      situation: `${slatePeriodName(this.state.currentPeriod)}, ${outs === 1 ? "1 palo" : `${outs} paloa`}`,
    };
  }

  /** Ohjaamon viimeisin havainto lähteen syötteestä, tai null kun tietoa ei
   *  ole. Välitetään sellaisenaan mikserille; tulkinta kuuluu sinne. */
  get sourceIngest(): SourceIngestObservation | null {
    return this.sourceIngestValue;
  }

  /** Ikkunoitu yhteenveto jokaisesta pollista (#120).
   *
   *  Miksi yhteenveto eikä rivi per polli, jota issue ehdotti: ohjaamo johtaa
   *  tilarivinsä **50 viimeisestä lokirivistä** (`live.ts`), ja osa niistä on
   *  debug-tasoisia (sydänääni). 3 s pollausvälillä rivi per polli täyttäisi
   *  ikkunan 2,5 minuutissa ja työntäisi ulos juuri ne todisteet joita ohjaamo
   *  lukee — sama vika jonka #102 aiheutti. 20 s välein sama tieto mahtuu
   *  ikkunaan tunneiksi.
   *
   *  Yhteenveto vastaa siihen kysymykseen, joka jäi 145900:ssa auki: ajettiinko
   *  pollit lainkaan (`polls`), mitä API vastasi (`lastEventCount`) ja millä
   *  kursorilla (`after`). Jos tarvitaan rivi per polli, `RELAY_POLL_TRACE=true`
   *  antaa sen — mutta se ei ole oletus, koska hinta maksetaan ohjaamon
   *  tilarivistä eikä lokitilasta.
   *
   *  Kutsutaan pollisilmukasta joka kierroksella; emittoi vain kun ikkuna on
   *  täynnä JA polleja on ollut. */
  /** Rivi per polli, vain kun RELAY_POLL_TRACE on päällä (#120). */
  private tracePoll(detail: string): void {
    if (!this.config.pollTrace) return;
    logDebug("api.poll_trace", `Polli: ${detail}, historiassa ${this.history.size}.`);
  }

  private maybeLogPollWindow(): void {
    const w = this.pollWindow;
    if (w.polls === 0) return;
    const elapsedMs = Date.now() - this.lastPollSummaryAtMs;
    if (elapsedMs < POLL_SUMMARY_MS) return;
    const cursor = this.deltaCursor?.after ?? "(ei kursoria — seuraava on täyshaku)";
    const answered = w.lastEventCount === null ? "ei yhtään 200-vastausta" : `viimeisin vastaus ${w.lastEventCount} tapahtumaa`;
    logDebug(
      "api.poll_window",
      `Pollit ${Math.round(elapsedMs / 1000)} s aikana: ${w.polls} kpl ` +
        `(304 ${w.notModified}, delta ${w.delta}, täyshaku ${w.full}, reset ${w.resets}, virhe ${w.failures}), ` +
        `${w.newEvents} uutta tapahtumaa, ${answered}, historiassa ${this.history.size}, ` +
        `kestot delta ${formatFetchDurations(w.fetchMs.delta)} / meta ${formatFetchDurations(w.fetchMs.meta)} / ` +
        `täys ${formatFetchDurations(w.fetchMs.full)}, ` +
        `kursori ${cursor}.`
    );
    this.lastPollSummaryAtMs = Date.now();
    this.pollWindow = {
      polls: 0,
      notModified: 0,
      delta: 0,
      full: 0,
      resets: 0,
      failures: 0,
      lastEventCount: null,
      newEvents: 0,
      fetchMs: { delta: [], meta: [], full: [] },
    };
  }

  /** Kirjaa yhden ONNISTUNEEN haun keston ikkunan otokseen (#156).
   *
   *  Kutsutaan haun ympäriltä eikä `fetchEventsForPoll`in ympäriltä, jotta luku
   *  on API:n vasteaika eikä sisällä paikallista yhdistelyä — juuri sitä lukua
   *  vasten aikakatkaisu asetetaan. */
  private async timedFetch<T>(size: FetchSize, fetch: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    const result = await fetch();
    // Vasta onnistumisen jälkeen: heitto ohittaa tämän rivin, eikä
    // aikakatkaistu haku päädy otokseen. Tarkoituksella EI `finally`.
    this.pollWindow.fetchMs[size].push(Date.now() - startedAt);
    return result;
  }

  get pollStatsSummary(): string {
    const s = this.pollStats;
    const breaker = this.deltaBreakerTripped ? ", delta POIS (katkaisija)" : "";
    return `pollit ${s.polls} (delta ${s.deltaMerges}, täyshaku ${s.fullFetches}, 304 ${s.notModified}, reset ${s.deltaResets}, hakuvirheitä ${s.fetchFailures}${breaker})`;
  }

  /** Käynnistyksessä: OTTAA käyttöön control-tiedostossa jo olevat arvot ja
   *  kirjoittaa tiedoston takaisin niiden kanssa.
   *
   *  Ennen tämä kirjoitti tiedoston kokonaan yli omasta configistaan, ja
   *  sääntö oli *"the config value (env/CLI/default) is authoritative on
   *  start"*. Se oli järkevä silloin kun tiedosto oli varapolku. Nyt se on
   *  ohjaamon ainoa ottelunaikainen ohjauskanava, ja relayn uudelleen-
   *  käynnistys on odotettu tapahtuma: operaattori kalibroi selostusviiveen
   *  korvakuulolta (4000 → 6000 ms), relay käynnistyy uudelleen, ja arvo palasi
   *  oletukseen ilman että mikään sanoi mitään (#206). Ajonaikainen kalibrointi
   *  on operaattorin tuoreinta tietoa, ei jäänne.
   *
   *  Tuntemattomat avaimet säilyvät: ohjaamo kirjoittaa samaan tiedostoon
   *  `sourceIngest`in (#104), ja ylikirjoitus pyyhki senkin.
   *
   *  Kirjoitus on atominen (temp + rename), kuten ohjaamon puolella
   *  (`relay.ts:writeRelayEnv`). Ei-atominen kirjoitus jätti ikkunan, jossa
   *  ohjaamon yhtaikainen säätö luki puolikkaan tiedoston. */
  private writeControlFile(): void {
    let existing: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.config.controlFile, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
        this.applyControlValues(existing, "käynnistyksessä");
      }
    } catch {
      // Ei tiedostoa tai puolikas JSON: configin arvot kelpaavat sellaisenaan,
      // ja tiedosto kirjoitetaan alta pois. Sama sietokyky kuin
      // refreshRuntimeControlsilla.
    }
    try {
      const temp = `${this.config.controlFile}.tmp`;
      writeFileSync(
        temp,
        JSON.stringify(
          {
            ...existing,
            announceBatterChanges: this.announceBatterChanges,
            narrationDelayMs: this.narrationDelayMs,
            deltaFetch: this.deltaFetch,
            pollIntervalMs: this.pollIntervalMs,
          },
          null,
          2
        ) + "\n"
      );
      renameSync(temp, this.config.controlFile);
    } catch (err) {
      logWarn("control.write_failed", `Control-tiedoston kirjoitus epäonnistui: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Re-reads the roster while it can still change, and hands back the names
   *  the narration should use from now on (issue #90).
   *
   *  The lineup is fetched once at startup, and `online/{id}/events` carries no
   *  names at all — only a jersey number and a team id. So if the lineup is
   *  edited between the relay starting and the scorer opening the match, every
   *  name is wrong for the whole broadcast, while the scores, palot and turns
   *  stay perfectly right. That is what happened live on 28.7.2026: the only
   *  reason it was caught is that a viewer knew the players by sight.
   *
   *  Refreshed until it cannot change any more: the match has started AND both
   *  rosters carry players. After that the numbers stop moving (substitutions
   *  arrive as events, from a lineup that is already published), so the polling
   *  stops rather than running all game against someone else's API. */
  private async maybeRefreshRoster(current: RosterSnapshot, now = Date.now()): Promise<RosterSnapshot> {
    if (this.rosterSettled) return current;
    const dueByTime = now - this.rosterRefreshedAt >= ROSTER_REFRESH_MS;
    // The moment the match opens is the one worth an immediate re-read: that
    // is when the final lineup appears.
    const dueByStart = this.matchStarted && !this.rosterRefreshedAfterStart;
    if (!dueByTime && !dueByStart) return current;
    this.rosterRefreshedAt = now;

    let meta: MatchMetadata;
    try {
      meta = await this.timedFetch("meta", () =>
        fetchMatchMetadata(this.config.matchId, {
          apiBase: this.config.apiBase,
          apiKey: this.config.apiKey,
          timeoutMs: this.apiTimeoutMs("meta"),
        })
      );
    } catch (err) {
      // Keep the names we have and try again next interval: a failed refresh
      // must never be worse than not refreshing at all.
      logWarn("api.roster_refresh_failed", `Kokoonpanon päivitys epäonnistui: ${err instanceof Error ? err.message : err}`);
      return current;
    }
    if (this.matchStarted) this.rosterRefreshedAfterStart = true;

    if (rosterSignature(meta) !== rosterSignature(current.meta)) {
      // warn, not info: every name spoken before this instant may have been
      // wrong, and that is exactly what an operator needs to see in the log.
      logWarn(
        "api.roster_changed",
        `Kokoonpano muuttui haun jälkeen — nimet päivitetty (${current.meta.home.players.length}+${current.meta.away.players.length} → ${meta.home.players.length}+${meta.away.players.length} pelaajaa).`
      );
    }

    if (this.rosterRefreshedAfterStart && rostersPopulated(meta)) {
      this.rosterSettled = true;
      logInfo("api.roster_settled", "Kokoonpano on julkaistu ja ottelu alkanut — nimet eivät enää muutu, päivitys lopetetaan.");
    }
    // Myös this.meta päivitetään: katvekuvan pisterivi lukee joukkuenimet
    // sieltä (#104), ja kaksi eri metaa samassa luokassa on juuri se
    // kahden totuuden tilanne jota vältetään.
    this.meta = meta;
    return { meta, lookup: buildPlayerLookup(meta) };
  }

  /** Re-reads the control file each poll and applies a changed setting live.
   *  A missing/invalid file is ignored (keep the current value) rather than
   *  treated as an error, so a half-written edit can't crash the loop.
   *  Async read: a sync one would block NarrationFifo's 20ms tick every
   *  poll. */
  private async refreshRuntimeControls(): Promise<void> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await readFile(this.config.controlFile, "utf8"));
    } catch {
      return;
    }
    this.applyControlValues(parsed, "ajon aikana");
  }

  /** Ottaa käyttöön control-tiedoston arvot. Sama koodi molemmilla poluilla —
   *  käynnistyksessä (#206) ja joka pollilla — koska kelpuutussäännöt ovat
   *  samat: virheellinen arvo jätetään huomiotta eikä koskaan kaadeta silmukkaa
   *  puolikkaan editin takia. `when` on vain lokirivin sana; se erottaa
   *  operaattorille säilytetyn asetuksen kesken ajon tehdystä muutoksesta. */
  private applyControlValues(parsed: Record<string, unknown>, when: "käynnistyksessä" | "ajon aikana"): void {
    if (typeof parsed.announceBatterChanges === "boolean" && parsed.announceBatterChanges !== this.announceBatterChanges) {
      this.announceBatterChanges = parsed.announceBatterChanges;
      logInfo("control.batter_changes", `Pelaajanvaihtojen selostus ${when === "käynnistyksessä" ? "säilytetty" : "vaihdettu"} ${when}: ${this.announceBatterChanges ? "PÄÄLLÄ" : "POIS"} (control-tiedostosta).`);
    }
    // Runtime narration-delay override: the control-file value wins over the
    // env/CLI seed once set. Ignore invalid/negative values so a half-written
    // edit can't turn every wait computation into NaN (see speak()).
    if (typeof parsed.narrationDelayMs === "number" && Number.isFinite(parsed.narrationDelayMs)) {
      const next = Math.max(0, Math.round(parsed.narrationDelayMs));
      if (next !== this.narrationDelayMs) {
        this.narrationDelayMs = next;
        logInfo("control.narration_delay", `Selostusviive ${when === "käynnistyksessä" ? "säilytetty" : "vaihdettu"} ${when}: ${next} ms (control-tiedostosta).`);
      }
    }
    // Delta polling on/off live — false reverts to plain full fetches on the
    // very next poll (the local history is simply rebuilt from each response).
    if (typeof parsed.deltaFetch === "boolean" && parsed.deltaFetch !== this.deltaFetch) {
      this.deltaFetch = parsed.deltaFetch;
      // A manual re-enable overrules the breaker and gives delta a fresh
      // streak — otherwise one earlier bad patch would keep it off for good.
      if (this.deltaFetch) {
        this.consecutiveDeltaResets = 0;
        this.consecutiveUnexplainedResets = 0;
        this.deltaBreakerTripped = false;
      }
      logInfo("control.delta_fetch", `Delta-haku ${when === "käynnistyksessä" ? "säilytetty" : "vaihdettu"} ${when}: ${this.deltaFetch ? "PÄÄLLÄ" : "POIS (täyshaut)"} (control-tiedostosta).`);
    }
    // Ohjaamon julkaisema havainto lähteen syötteestä (#104 vaihe 1). Luetaan
    // täällä, koska tämä on ainoa control-tiedoston lukija; loop ei tee sillä
    // itse mitään, mikseri päättää. Puuttuva avain jättää edellisen havainnon
    // paikoilleen — mikseri hylkää vanhentuneen joka tapauksessa.
    if (parsed.sourceIngest !== undefined) {
      this.sourceIngestValue = parseSourceIngest(parsed.sourceIngest);
    }
    // Poll cadence live; clamped to the floor so a typo can't hammer the API.
    if (typeof parsed.pollIntervalMs === "number" && Number.isFinite(parsed.pollIntervalMs)) {
      const next = Math.max(MIN_POLL_INTERVAL_MS, Math.round(parsed.pollIntervalMs));
      if (next !== this.pollIntervalMs) {
        this.pollIntervalMs = next;
        logInfo("control.poll_interval", `Pollausväli ${when === "käynnistyksessä" ? "säilytetty" : "vaihdettu"} ${when}: ${next} ms (control-tiedostosta).`);
      }
    }
  }

  async run(): Promise<void> {
    this.abort = new AbortController();
    const signal = this.abort.signal;

    this.writeControlFile();
    logInfo(
      "control.batter_changes",
      `Pelaajanvaihtojen selostus: ${this.announceBatterChanges ? "PÄÄLLÄ" : "POIS"} ` +
        `(vaihda ajon aikana: ${this.config.controlFile})`
    );

    // Ennen hakuja, ei niiden jälkeen: `matchFinished` lukee tätä ja mikseri
    // lukee sitä (`isMatchFinished`). Tilatiedostosta palautunut `finished:
    // true` lyhentäisi mikserin luovutusikkunan 12 minuutista 2:een juuri sinä
    // aikana kun käynnistyshaku yrittää uudelleen (#158) — eli uudelleenyritys
    // voisi itse tappaa relayn, jonka suojelemiseksi se lisättiin. Rivi
    // toistuu alempana muun tilan nollauksen kanssa; molemmat ovat halpoja.
    this.state.finished = false;

    logInfo("api.fetching_meta", `Haetaan ottelutietoja (ID: ${this.config.matchId})…`);
    const startupMeta = await this.startupFetch(
      "Ottelutietojen haku",
      () =>
        this.timedFetch("meta", () =>
          fetchMatchMetadata(this.config.matchId, {
            apiBase: this.config.apiBase,
            apiKey: this.config.apiKey,
            timeoutMs: this.apiTimeoutMs("meta"),
          })
        ),
      signal
    );
    if (startupMeta == null) return; // aborted while retrying
    let meta = startupMeta;
    this.meta = meta;
    let lookup = buildPlayerLookup(meta);
    this.rosterRefreshedAt = Date.now();
    logInfo("api.match", `${meta.home.name} vs ${meta.away.name}`);
    if (!rostersPopulated(meta)) {
      // Normal when the relay is started early: the lineup is published late,
      // sometimes minutes before the first pitch (issue #90). Said out loud
      // because the alternative — silently speaking wrong names for a whole
      // match — is the failure this refresh exists to prevent.
      logWarn(
        "api.roster_missing",
        `Kokoonpanoa ei ole vielä julkaistu (${meta.home.players.length}+${meta.away.players.length} pelaajaa) — nimet päivitetään kun se ilmestyy.`
      );
    }

    logInfo("api.skip_history", "Ohitetaan historialliset tapahtumat…");
    // Full fetch — also seeds the local history + delta cursor (see
    // fetchEventsForPoll).
    // Same protection as the metadata fetch above, and for the same reason:
    // this call, too, happens with ffmpeg already live (#158).
    const initial = await this.startupFetch("Tapahtumahistorian haku", () => this.fetchFullEvents(), signal);
    if (initial == null) return; // aborted while retrying
    this.state.periodRuns = {};
    this.state.currentOuts = 0;
    this.state.paloTurnKey = null;
    this.state.paloTurnMax = 0;
    this.state.currentPeriod = 0;
    this.state.currentBatTeamId = null;
    this.state.finished = false;
    this.processEventsSilent(initial.events, meta);
    this.matchStarted = initial.events.length > 0;

    if (initial.team != null) this.state.currentBatTeamId = initial.team;
    if ((initial.period ?? 0) > this.state.currentPeriod) this.state.currentPeriod = initial.period!;
    {
      const { outs, turnKey } = recomputeCurrentOutsKeyed(initial.events);
      this.state.paloTurnKey = turnKey;
      this.state.paloTurnMax = outs;
      this.state.currentOuts = outs;
    }
    // The turn we're already in at start is covered by the startup speech —
    // mark it announced so the live turn-change detector doesn't repeat it.
    this.state.announcedTurnKey =
      `${this.state.currentPeriod}:${this.state.currentInning}:${this.state.currentBatTurn}:${this.state.currentBatTeamId}`;
    await saveState(this.config.stateFile, this.state);
    logInfo("api.skipped", `Ohitettu ${initial.events.length} tapahtumaa`);

    if (!meta.live && meta.started) {
      logInfo("api.match_finished", "Ottelu on jo päättynyt.");
      return;
    }

    // If ffmpeg is already attached by the time we get here, latch now so the
    // startup speech below goes straight through instead of being suppressed
    // and replaced by a catch-up recap one poll later.
    this.maybeLatchNarrationReady(meta);

    // The startup recap goes through speak(), which suppresses it pre-latch
    // (it would only pile up stale in the FIFO); the latch moment then speaks
    // a fresh recap instead. The pre-game welcome filler is additionally only
    // worth queuing once ffmpeg is attached and the queue empty, or it bursts
    // on connect — skipping it here just defers it to
    // maybeAnnounceSummary, which re-checks readiness each poll.
    if (this.matchStarted) {
      this.speak(formatStartupSpeech(meta, this.buildContext()));
    } else if (this.narrationReadyForFiller()) {
      this.speak(formatWelcomeFiller(meta));
    }
    // Startup already gives the full situation — don't fire the periodic
    // summary immediately on top of it.
    this.state.lastSummaryTime = Date.now();
    this.lastSummaryCount = this.state.announcementCount;

    logInfo("api.loop_start", `Selostussilmukka käynnissä… (polli ${this.pollIntervalMs} ms, delta-haku ${this.deltaFetch ? "PÄÄLLÄ" : "POIS"})`);
    // Fixed poll cadence, independent of how long a cycle's fetch/processing
    // takes — synthesis no longer blocks this loop (see speak()/synthQueue),
    // so cycles should normally be fast, but a slow fetch must not add to the
    // next wait on top of its own delay. If a cycle overruns the interval,
    // resume the cadence from now instead of firing a burst of catch-up ticks
    // (no-overlap guard).
    let nextPollAt = Date.now() + this.pollIntervalMs;
    while (!signal.aborted) {
      const waitMs = nextPollAt - Date.now();
      if (waitMs > 0) await this.sleepAbortable(waitMs, signal);
      if (signal.aborted) break;
      nextPollAt = Math.max(nextPollAt + this.pollIntervalMs, Date.now());
      await this.refreshRuntimeControls();
      // Names before speech: a roster published since the last poll must be in
      // use for THIS poll's events, not the next one's.
      ({ meta, lookup } = await this.maybeRefreshRoster({ meta, lookup }));
      // Checked before processing so a latch-moment catch-up recap enters the
      // synth queue ahead of any events found in this same poll — the recap
      // covers the suppressed past, the events then narrate the present.
      this.maybeLatchNarrationReady(meta);
      const cycleStartedAt = Date.now();
      try {
        // Full fetch or delta merge; either way `history` holds the complete
        // event list afterwards, which is what ALL processing below runs on —
        // the existing logic (fingerprints, outs recompute, palo ordinals)
        // assumes the full history every poll and stays unchanged. Null =
        // 304, nothing new: skip event processing, keep fillers/state alive.
        const data = await this.fetchEventsForPoll();
        this.maybeLogPollWindow();
        if (data !== null) {
          const events = this.history.events;

          // Ordinary bat-turn changes have no dedicated API text marker; they are
          // detected and announced inside processEventsLive, keyed off
          // seenFingerprints/announcedTurnKey (see the comment there).
          await this.processEventsLive(events, meta, lookup);

          // Outs for the current turn, kept monotonic per turn key. The API briefly
          // re-keys a turn-ending palo into the next sub-inning, which would make a
          // raw recompute rewind mid-turn (e.g. 3 → 2) after the 3rd palo was
          // already announced; keying the running max to the counted turn resets
          // cleanly on a real turn change but never drops mid-turn.
          if (events.length > 0) {
            const { outs, turnKey } = recomputeCurrentOutsKeyed(events);
            if (turnKey !== this.state.paloTurnKey) {
              this.state.paloTurnKey = turnKey;
              this.state.paloTurnMax = 0;
            }
            this.state.paloTurnMax = Math.max(this.state.paloTurnMax, outs);
            this.state.currentOuts = this.state.paloTurnMax;
          }

          // Reconcile with the API's authoritative fields. After a turn-ending out
          // the API reports the new batting team / period before any explicit
          // bat-change event arrives; period only ever advances.
          if ((data.period ?? 0) > this.state.currentPeriod) this.state.currentPeriod = data.period!;
          if (data.team != null && data.team !== this.state.currentBatTeamId) {
            this.state.currentBatTeamId = data.team;
            this.state.currentOuts = 0;
            this.state.paloTurnKey = null;
            this.state.paloTurnMax = 0;
          }
        }

        await this.maybeAnnounceSummary(meta);

        await saveState(this.config.stateFile, this.state);
        this.recordPollSuccess();
      } catch (err) {
        this.recordPollFailure(err, cycleStartedAt);
      }
    }
  }

  /** A lone poll failure is routine noise (8 s client-timeout blips — one
   *  live match had 22 in 45 min with zero events lost); the log line carries the
   *  cycle duration and the streak position, and only a streak of
   *  FETCH_FAILURE_ALARM_STREAK+ turns the line alarming. */
  private recordPollFailure(err: unknown, cycleStartedAt: number): void {
    this.pollStats.fetchFailures++;
    this.pollWindow.failures++;
    const streak = ++this.consecutiveFetchFailures;
    // Arm (and re-arm, for as long as the streak lasts) the loosened delta
    // timeout. Arming here rather than reading the streak in apiTimeoutMs() is
    // what makes the valve outlive the streak: recordPollSuccess() clears the
    // streak, but the dwell counter it decrements takes DELTA_SLOW_DWELL_POLLS
    // successes to run out.
    if (streak >= FETCH_FAILURE_ALARM_STREAK) this.slowDeltaDwellPolls = DELTA_SLOW_DWELL_POLLS;
    const seconds = ((Date.now() - cycleStartedAt) / 1000).toFixed(1);
    const label = streak >= FETCH_FAILURE_ALARM_STREAK ? "HUOM, hakuvirhesarja" : "Hakuvirhe";
    logWarn("api.fetch_failed", `${label} (kesto ${seconds} s, ${streak}. peräkkäinen): ${err instanceof Error ? err.message : err}`);
  }

  /** Closes an alarming failure streak with an explicit all-clear line, so a
   *  log reader (or the watchdog agent) doesn't have to infer recovery from
   *  the absence of errors. */
  private recordPollSuccess(): void {
    if (this.consecutiveFetchFailures >= FETCH_FAILURE_ALARM_STREAK) {
      logInfo("api.fetch_recovered", `Haku onnistui jälleen — ${this.consecutiveFetchFailures} peräkkäistä hakuvirhettä takana.`);
    }
    this.consecutiveFetchFailures = 0;
    // One success is not evidence that the tight limit fits again — it may be
    // the loose limit that let this very poll through. Hence a countdown, not
    // a clear.
    if (this.slowDeltaDwellPolls > 0) this.slowDeltaDwellPolls--;
  }

  /** Runs a startup fetch that must not be allowed to kill the process (#158).
   *
   *  By the time `run()` starts, ffmpeg is already pushing picture to the
   *  commentated broadcast. An unhandled rejection here would propagate to
   *  `main().catch()` → `process.exit(1)`, and `Restart=on-failure` +
   *  `RestartSec=10` + `KillMode=control-group` would take ffmpeg down with it:
   *  a ≥10 s hole in a live broadcast, repeating for as long as the API is
   *  slow. Retrying costs a few seconds of late narration instead.
   *
   *  Retries until it succeeds or the loop is aborted; on abort it resolves to
   *  `null` and the caller returns without narrating. Same reasoning as
   *  `maybeRefreshRoster`'s catch, applied where the price is a black screen
   *  rather than a stale name.
   *
   *  Deliberately unbounded: giving up would mean either crashing (the thing
   *  being fixed) or running a broadcast that can never narrate. A genuinely
   *  wrong match id is preflight's job, and it is loud in the log here. */
  private async startupFetch<T>(what: string, fn: () => Promise<T>, signal: AbortSignal): Promise<T | null> {
    for (let attempt = 1; ; attempt++) {
      if (signal.aborted) return null;
      try {
        const value = await fn();
        if (attempt > 1) {
          logInfo("api.startup_fetch_recovered", `${what} onnistui ${attempt}. yrityksellä.`);
        }
        return value;
      } catch (err) {
        if (signal.aborted) return null;
        const waitMs = STARTUP_RETRY_DELAYS_MS[Math.min(attempt - 1, STARTUP_RETRY_DELAYS_MS.length - 1)];
        const message =
          `${what} epäonnistui (${attempt}. yritys): ${err instanceof Error ? err.message : err} — ` +
          `yritetään uudelleen ${waitMs} ms:n kuluttua. Lähetys jatkuu, selostus alkaa myöhässä.`;
        if (attempt >= STARTUP_RETRY_ERROR_AFTER) logError("api.startup_fetch_failed", message);
        else logWarn("api.startup_fetch_failed", message);
        await this.sleepAbortable(waitMs, signal);
      }
    }
  }

  /** Effective timeout per fetch shape (#156).
   *
   *  Only the full fetch is floored at `pollIntervalMs`. That floor used to
   *  apply to every size, and it silently made the constants something other
   *  than the effective timeouts: `max(1000, 3000)` would have shipped 3 s. Its
   *  rationale (#89) conflated cadence with latency — how often we ask says
   *  nothing about how long an answer may take. It stays for the full fetch,
   *  where #47's acceptance criterion is real: the control file can raise the
   *  poll interval past 10 s live, and a timeout under the cadence would abort
   *  fetches the cadence itself expects to be slow. */
  private apiTimeoutMs(size: FetchSize): number {
    if (size === "delta") {
      // Open on the streak, held open by the dwell counter (see
      // DELTA_SLOW_DWELL_POLLS): the streak itself is gone the moment a poll
      // succeeds, so keying only on it would give the loose limit to one poll
      // in four instead of to the state that needs it.
      const loosened =
        this.consecutiveFetchFailures >= FETCH_FAILURE_ALARM_STREAK || this.slowDeltaDwellPolls > 0;
      return loosened ? DELTA_FETCH_TIMEOUT_SLOW_MS : DELTA_FETCH_TIMEOUT_MS;
    }
    if (size === "meta") return META_FETCH_TIMEOUT_MS;
    return Math.max(FULL_FETCH_TIMEOUT_MS, this.pollIntervalMs);
  }

  /** Full events fetch: replaces the local history and re-bases the delta
   *  cursor. Used at startup, when delta polling is off, for the periodic
   *  resync, and as the fallback whenever a delta looks untrustworthy. */
  private async fetchFullEvents(): Promise<LiveEventsResult> {
    const res = await this.timedFetch("full", () =>
      fetchLiveEvents(this.config.matchId, {
        apiBase: this.config.apiBase,
        timeoutMs: this.apiTimeoutMs("full"),
        skipDelay: true,
      })
    );
    return this.adoptFullSnapshot(res);
  }

  /** A delta that merged or 304'd proves the cursor is healthy again. */
  private clearResetStreak(): void {
    this.consecutiveDeltaResets = 0;
    this.consecutiveUnexplainedResets = 0;
  }

  /** Makes a response that carries the complete history the new local history
   *  and re-bases the delta cursor on it. Used for genuine full fetches and
   *  for reset answers, which are full snapshots too (handleResetResponse). */
  private adoptFullSnapshot(res: LiveEventsResult): LiveEventsResult {
    this.history.replace(res.events);
    if (res.serverDateMs) this.lastServerDateMs = res.serverDateMs;
    this.lastFullFetchAt = Date.now();
    this.deltaCursor = null; // next delta re-bases on the fresh server date
    this.pollStats.fullFetches++;
    this.pollWindow.full++;
    this.pollWindow.lastEventCount = res.events.length;
    return res;
  }

  /** The server answered our delta with a reset instant (issue #46).
   *
   *  That answer is NOT "your delta failed, go fetch everything": it already
   *  IS everything — the server ignores `after` and returns the complete
   *  history plus the authoritative period/team fields (see
   *  LiveEventsResponse.reset). The old code threw it away and immediately ran
   *  a second full fetch, which is what made every poll cost two API requests
   *  for the whole reset streak. Adopting the response we already hold costs
   *  exactly one request per poll — no worse than delta-off mode.
   *
   *  Breaker accounting: a reset instant NEWER than the `after` we sent is
   *  self-explanatory (our baseline predates the match's online data, which is
   *  unavoidable for AFTER_MARGIN_MS after the scorer opens the match), so it
   *  must not consume the breaker's budget. Anything else does. */
  private async handleResetResponse(
    res: LiveEventsResult,
    after: string,
    afterMs: number
  ): Promise<LiveEventsResult> {
    this.pollStats.deltaResets++;
    this.pollWindow.resets++;
    const resetAtMs = typeof res.reset === "string" ? Date.parse(res.reset) : NaN;
    const explained = Number.isFinite(resetAtMs) && resetAtMs >= afterMs;
    const firstOfStreak = this.consecutiveDeltaResets === 0;
    this.consecutiveDeltaResets++;
    if (!explained) this.consecutiveUnexplainedResets++;

    if (this.consecutiveUnexplainedResets >= DELTA_RESET_BREAKER_STREAK && this.deltaFetch) {
      this.deltaFetch = false;
      this.deltaBreakerTripped = true;
      logWarn(
        "api.delta_inconsistent",
        `HUOM: delta-haku vastasi selittämättömällä reset-leimalla ${this.consecutiveUnexplainedResets} kertaa peräkkäin ` +
          "— kytketään delta pois tältä ajolta ja jatketaan täyshauilla. " +
          "Takaisin päälle control-tiedostosta: {\"deltaFetch\": true}."
      );
    } else if (firstOfStreak) {
      // One line per streak, not per poll: the match-start streak runs for
      // AFTER_MARGIN_MS (~60 polls at the default cadence).
      const why = explained
        ? `haettu after ${after} on vanhempi kuin ottelun datan reset-hetki`
        : "syy tuntematon";
      logDebug("api.delta_reset", `Delta-vastaus sisälsi reset-leiman ${String(res.reset)} (${why}) → vastaus on koko historia, käytetään sellaisenaan.`);
    }

    // Trust, but verify: an authoritative snapshot can only be shorter than
    // what we hold if the scorer deleted events — rare enough that paying for
    // one real full fetch there is the safe call.
    if (res.events.length < this.history.size) return this.fetchFullEvents();
    return this.adoptFullSnapshot(res);
  }

  /** One poll's events fetch. Delta mode asks only
   *  for recent events (`after=` + If-None-Match) and merges them into the
   *  local full history; returns null on 304 (nothing changed). A reset answer
   *  replaces the history in place (handleResetResponse), an inconsistent
   *  merge falls back to an immediate full fetch, and a periodic full resync
   *  runs regardless as cheap insurance.
   *
   *  The `after` value: events carry no wall-clock field, so it derives from
   *  the last 200's Date header minus AFTER_MARGIN_MS. The base only advances
   *  when a delta actually delivers changes, keeping the URL stable through
   *  quiet stretches so the ETag can 304. */
  private async fetchEventsForPoll(): Promise<LiveEventsResult | null> {
    this.pollStats.polls++;
    this.pollWindow.polls++;
    if (!this.deltaFetch) return this.fetchFullEvents();
    // While the local history is empty (match not started / being initialized)
    // the server answers every delta with the reset flag, which made each poll
    // log + full-fetch in a loop (observed live 17.7.). Full fetches are cheap
    // there (empty body) — delta engages once the first events exist.
    if (
      this.lastServerDateMs === null ||
      this.history.size === 0 ||
      Date.now() - this.lastFullFetchAt >= RESYNC_EVERY_MS
    ) {
      return this.fetchFullEvents();
    }
    const afterMs = this.deltaCursor?.afterMs ?? this.lastServerDateMs - AFTER_MARGIN_MS;
    const after = this.deltaCursor?.after ?? formatHelsinkiTimestamp(new Date(afterMs));
    const res = await this.timedFetch("delta", () =>
      fetchLiveEvents(this.config.matchId, {
        apiBase: this.config.apiBase,
        timeoutMs: this.apiTimeoutMs("delta"),
        skipDelay: true,
        after,
        etag: this.deltaCursor?.after === after ? (this.deltaCursor.etag ?? undefined) : undefined,
      })
    );
    if (res.notModified) {
      this.clearResetStreak();
      this.pollStats.notModified++;
      this.pollWindow.notModified++;
      this.tracePoll(`304 (ei muutosta), kursori ${after}`);
      return null;
    }
    if (res.reset) return this.handleResetResponse(res, after, afterMs);
    const merge = this.history.merge(res.events);
    if (merge.inconsistent) {
      logWarn("api.delta_inconsistent", "Delta-epäkonsistenssi (tapahtuman alitapahtumalista kutistui) → täyshaku.");
      return this.fetchFullEvents();
    }
    this.clearResetStreak();
    this.pollStats.deltaMerges++;
    this.pollWindow.delta++;
    this.pollWindow.lastEventCount = res.events.length;
    this.pollWindow.newEvents += merge.added;
    this.tracePoll(
      `200: ${res.events.length} tapahtumaa, ${merge.added} uutta, ${merge.updated} päivittynyttä, kursori ${after}`
    );
    if (merge.added > 0 || merge.updated > 0) {
      logDebug("api.delta_fetch", `Delta-haku: ${merge.added} uutta, ${merge.updated} päivittynyttä tapahtumaa (historiassa ${this.history.size}).`);
      // Advance the cursor only now: the new base's URL changes, so its ETag
      // starts fresh on the next poll's 200.
      if (res.serverDateMs) {
        this.lastServerDateMs = res.serverDateMs;
        this.deltaCursor = null;
      }
    } else {
      // Nothing new — keep the URL stable and remember its ETag for a 304.
      this.deltaCursor = { after, afterMs, etag: res.etag ?? null };
    }
    return res;
  }

  stop(): void {
    this.abort?.abort();
  }

  /** Mirrors v2 watcher's processEventsLive: replays the full history each poll
   *  (the endpoint is never windowed), announces genuinely new sub-events, and
   *  infers mid-period bat-turn changes from the API's turn coordinates. */
  private async processEventsLive(
    events: LiveEvent[],
    meta: MatchMetadata,
    lookup: PlayerLookup
  ): Promise<void> {
    const state = this.state;
    if (events.length > 0) this.matchStarted = true;
    for (let ei = 0; ei < events.length; ei++) {
      const event = events[ei];
      const prevBatTeamId = state.currentBatTeamId;
      const turnChanged =
        event.team != null &&
        (event.team !== state.currentBatTeamId ||
          event.inning !== state.currentInning ||
          event.batTurn !== state.currentBatTurn);
      // The very first turn of a period is announced by the "X jakso alkoi" /
      // "Ottelu alkoi" text in subEventToSpeech instead — skip it here.
      const isFirstTurnOfPeriod = event.inning === 0 && event.batTurn === 0;

      if (turnChanged) {
        state.currentBatTeamId = event.team;
        state.currentInning = event.inning;
        state.currentBatTurn = event.batTurn;
        state.currentOuts = 0;
      }
      if (event.period > 0) {
        if (event.period !== state.currentPeriod) {
          state.currentInning = event.inning;
          state.currentBatTurn = event.batTurn;
          state.currentOuts = 0;
        }
        state.currentPeriod = event.period;
      }

      // Mid-period bat-turn changes have no API text marker, so infer them —
      // but only announce a genuinely new, not-yet-announced turn, or this
      // would fire once per poll for every historical turn change.
      const turnKey = `${event.period}:${event.inning}:${event.batTurn}:${event.team}`;
      const hasNewSubEvent = event.events.some((_, i) => !state.seenFingerprints.has(eventFingerprint(event, i)));
      if (
        turnChanged &&
        !isFirstTurnOfPeriod &&
        !state.finished &&
        event.team != null &&
        turnKey !== state.announcedTurnKey &&
        hasNewSubEvent
      ) {
        const cur = getPeriodScore(state, state.currentPeriod);
        const msg = formatBatTurnChangeSpeech(
          meta, prevBatTeamId, event.team, cur.home, cur.away, state.currentInning, state.currentBatTurn
        );
        this.speak(msg);
        state.announcedTurnKey = turnKey;
      }

      // First-seen delay log: one line per event with at
      // least one genuinely new sub-event (not per sub-event), so a later
      // pass can split total delay into API-side publish delay (this delta)
      // vs. our own portion (speak-time minus this log's timestamp).
      // lastEventSeenAt on terveyssignaali ("kirjaako toimitsija yhä tuloksia")
      // eikä saa riippua timestampista: tällä syötteellä event.timestamp on
      // käytännössä aina null, ja vartijan sisällä kenttä jäi ikuisesti
      // nulliksi (#119).
      if (hasNewSubEvent) {
        this.lastEventSeenAt = new Date().toISOString();
      }
      if (hasNewSubEvent && event.timestamp !== null) {
        const candidateEpochMs = Date.now() - event.timestamp * 1000;
        this.matchEpochMs =
          this.matchEpochMs === null ? candidateEpochMs : Math.min(this.matchEpochMs, candidateEpochMs);
        const deltaS = Math.round((Date.now() - (this.matchEpochMs + event.timestamp * 1000)) / 1000);
        logDebug("api.first_seen", `first-seen: id=${event.id} ts=${event.timestamp} delta=${deltaS}s`);
      }

      // One swing can be several markings (#154). Bookkeeping stays per
      // marking — the score counts one run each, and every index has to be
      // fingerprinted or the tail of a group is re-announced next poll — but
      // the SPEECH is one sentence per group.
      for (const group of groupSubEventsForSpeech(event.events)) {
        const fresh = group.filter((i) => !state.seenFingerprints.has(eventFingerprint(event, i)));
        if (fresh.length === 0) continue;
        for (const i of fresh) state.seenFingerprints.add(eventFingerprint(event, i));

        let ctx = this.buildContext();
        for (const i of fresh) {
          const sub = event.events[i];
          // A score change after "Ottelu päättyi" means the scorer ended the
          // game too early and reopened it — the finished gate is not one-way,
          // narration wakes back up here.
          if (state.finished && isRunScoringSubEvent(sub)) {
            state.finished = false;
            logWarn("match.score_after_finish", "Pistetilanne muuttui ottelun päättymisen jälkeen — selostus jatkuu.");
          }

          if (isMatchEndSubEvent(sub)) state.finished = true;

          if (isRunScoringSubEvent(sub) && event.team !== null) {
            addRun(state, event.period, event.team === meta.home.id, runValueOfSubEvent(sub));
            const s = getPeriodScore(state, event.period);
            logInfo("match.score", `Pisteet (${periodName(event.period)}): ${meta.home.shorthand} ${s.home}-${s.away} ${meta.away.shorthand}`);
          }

          // For an out, the spoken ordinal must come from the turn-key recompute
          // (same source as the scoreboard), not the running currentOuts which
          // can drift across polls.
          ctx = this.buildContext();
          if (isOutSubEvent(sub) && event.team !== null) {
            ctx.currentOuts = outsThroughSubEvent(events, ei, i);
            const team = event.team === meta.home.id ? meta.home.shorthand : meta.away.shorthand;
            logInfo("match.palo", `Palo: ${team} ${ctx.currentOuts}`);
          }

          // The relay has no feed; its log is the written mirror of the source, so
          // the lineup list the narration leaves out (issue #48) is logged here
          // instead of vanishing (issue #74). Logged even when nothing is spoken.
          // Per marking on purpose: the log mirrors the source even where the
          // speech merges (feedback-feed-mirrors-source-speech-dedupes).
          const feedDetail = subEventFeedDetail(sub, lookup);
          if (feedDetail) logDebug("match.event", `Tapahtuma: ${feedDetail}`);
        }

        const lastSub = event.events[fresh[fresh.length - 1]];
        const speech = groupToSpeech(event, event.events, fresh, meta, lookup, this.announceBatterChanges, ctx);
        if (!speech) continue;
        // After the closing announcement everything else stays silent (the
        // match-end sub-event itself is what speaks that closing line).
        if (state.finished && !isMatchEndSubEvent(lastSub)) continue;
        // Same texts in the same turn and situation = a scorer double-marking.
        const dedupeKey = `${event.period}:${event.inning}:${event.batTurn}:${event.team}:` +
          `${JSON.stringify(fresh.map((i) => event.events[i].texts))}:${ctx.periodHomeRuns}:${ctx.periodAwayRuns}:${ctx.currentOuts}`;
        this.speak(speech, true, dedupeKey);
      }

      if (event.timestamp !== null && event.timestamp > state.lastTimestamp) {
        state.lastTimestamp = event.timestamp;
      }
    }
  }

  /** Mirrors v2 watcher's processEventsSilent: fast-forwards state through the
   *  historical backlog at startup without emitting any speech. */
  private processEventsSilent(events: LiveEvent[], meta: MatchMetadata): void {
    const state = this.state;
    for (const event of events) {
      if (
        event.team != null &&
        (event.team !== state.currentBatTeamId ||
          event.inning !== state.currentInning ||
          event.batTurn !== state.currentBatTurn)
      ) {
        state.currentBatTeamId = event.team;
        state.currentInning = event.inning;
        state.currentBatTurn = event.batTurn;
        state.currentOuts = 0;
      }
      if (event.period > 0) {
        if (event.period !== state.currentPeriod) {
          state.currentInning = event.inning;
          state.currentBatTurn = event.batTurn;
          state.currentOuts = 0;
        }
        state.currentPeriod = event.period;
      }

      for (let i = 0; i < event.events.length; i++) {
        const sub = event.events[i];
        state.seenFingerprints.add(eventFingerprint(event, i));
        if (isMatchEndSubEvent(sub)) state.finished = true;
        if (isRunScoringSubEvent(sub) && event.team !== null) {
          addRun(state, event.period, event.team === meta.home.id, runValueOfSubEvent(sub));
        }
        if (isOutSubEvent(sub) && event.team !== null) state.currentOuts++;
      }

      if (event.timestamp !== null && event.timestamp > state.lastTimestamp) {
        state.lastTimestamp = event.timestamp;
      }
    }
  }

  /** Periodic situation recap or idle filler, spoken (not counted as an
   *  announcement). Busy game: full recap every SUMMARY_EVERY_N announcements.
   *  Quiet game: a "tilanne on edelleen…" filler once nothing has been said
   *  for IDLE_FILLER_MS. */
  private async maybeAnnounceSummary(meta: MatchMetadata): Promise<void> {
    const now = Date.now();
    // The timing decision itself lives in core (decideFiller, issue #62) —
    // it used to be duplicated here and in apps/web. Thresholds are passed in
    // because they differ on purpose between the two apps; the side effects
    // below (readiness gate, bookkeeping) stay here because they don't.
    const decision = decideFiller(
      {
        // After the closing announcement the narration goes fully silent — no
        // recaps, fillers, or batter calls — until a post-end score change
        // wakes it (see processEventsLive). The relay/ffmpeg keep running.
        finished: this.state.finished,
        matchStarted: this.matchStarted,
        now,
        lastSpeechAt: this.lastSpeechAt,
        announcementCount: this.state.announcementCount,
        lastSummaryCount: this.lastSummaryCount,
        currentPeriod: this.state.currentPeriod,
        lastIntroPeriod: this.lastIntroPeriod,
        // Sama tyhjä-jono-ehto kuin narrationReadyForFiller()-portissa alla;
        // core lukee sen erikseen, koska webissä vastaavaa porttia ei ole.
        speechQueueEmpty: this.narrationStatus
          ? this.narrationStatus.pendingClips() === 0
          : true,
      },
      {
        welcomeFillerMs: WELCOME_FILLER_MS,
        idleFillerMs: IDLE_FILLER_MS,
        summaryEveryN: SUMMARY_EVERY_N,
      },
    );
    if (decision === null) return;
    // Only synthesize a filler when it will actually be heard in real time
    // (ffmpeg attached, queue empty). Otherwise skip this round — the ~90s
    // cadence assumes real-time playback, and queuing fillers before ffmpeg
    // attaches makes them all burst on connect. In-game the skip happens
    // WITHOUT advancing the bookkeeping below, so the first ready poll speaks
    // a fresh recap instead of queueing stale "tilanne on edelleen…" clips
    // through a long ffmpeg outage. Event narration is unaffected.
    if (!this.narrationReadyForFiller()) return;
    if (decision === "welcome") {
      this.speak(formatWelcomeFiller(meta), false);
      return;
    }
    // Merkintä vasta tässä, puhumisen yhteydessä: jos gate yllä ohitti
    // kierroksen, esittely on yhä velkaa eikä sitä saa kuitata annetuksi.
    if (decision === "intro") {
      this.lastIntroPeriod = this.state.currentPeriod;
      this.speak(formatIntroFiller(), false);
      return;
    }
    this.lastSummaryCount = this.state.announcementCount;
    this.state.lastSummaryTime = now;
    this.lastSpeechAt = now;
    const ctx = this.buildContext();
    const summary =
      decision === "recap" ? formatSituationSummary(meta, ctx) : formatIdleSummary(meta, ctx);
    this.speak(summary, false);
  }

  private buildContext(): SpeechContext {
    const cur = getPeriodScore(this.state, this.state.currentPeriod);
    const won = periodsWon(this.state);
    return {
      periodHomeRuns: cur.home,
      periodAwayRuns: cur.away,
      homePeriodsWon: won.home,
      awayPeriodsWon: won.away,
      periodsPlayed: periodsPlayed(this.state),
      currentOuts: this.state.currentOuts,
      currentPeriod: this.state.currentPeriod,
      currentBatTeamId: this.state.currentBatTeamId,
      currentInning: this.state.currentInning,
      currentBatTurn: this.state.currentBatTurn,
    };
  }

  /** dedupeKey identifies the announcement's content before variant
   *  randomization. Consecutive scorer double-markings used to be dropped by
   *  comparing the final strings, but pickVariant can now phrase the same
   *  duplicate two different ways — so duplicates must be detected on the
   *  pre-variant key, never on the rendered speech. */
  /** Decision-time bookkeeping (dedupe, lastSpeechAt, announcementCount)
   *  happens synchronously; the actual sink call (TTS synthesis + mix) is
   *  handed to synthQueue instead of awaited inline. Previously the poll loop
   *  awaited each clip's synthesis (~1s/clip) before moving on, so a cluster
   *  of several announcements in one poll delayed the next poll by several
   *  seconds. synthQueue keeps clips in order while
   *  letting the poll loop run on its own fixed cadence. */
  private speak(text: string, countAnnouncement = true, dedupeKey: string = text): void {
    if (dedupeKey === this.lastSpeech) return;
    this.lastSpeech = dedupeKey;
    this.lastSpeechAt = Date.now();
    if (countAnnouncement) this.state.announcementCount++;
    const spoken = preventOrdinalReading(applyPronunciations(text, this.pronunciations));
    // Pre-first-attach suppression: all decision-time
    // bookkeeping above ran normally — so dedupe/scoring/turn state stay
    // exactly as if the clip had played — but the sink handoff is skipped:
    // synthesizing now would only stack stale clips in the FIFO to burst out
    // on connect. The latch moment speaks one fresh recap instead (see
    // maybeLatchNarrationReady). Never reverts after the first attach.
    // One id follows this clip through detected -> synthesized -> spoken, so a
    // reader of the timeline can pair the three records rather than matching on
    // text (which repeats: "Toinen palo" happens many times a match).
    const clip = { id: `c${++this.clipSeq}`, text };
    this.observer?.detected(clip);
    if (!this.narrationEverReady) {
      this.suppressedBeforeAttach = true;
      logWarn("speech.muted", `Selostus (vaimennettu — ffmpeg ei vielä kytkeytynyt): ${text}`);
      this.observer?.spoken(clip, true);
      return;
    }
    logInfo("speech.spoken", `Selostus: ${text}`);
    // Artificial playback delay (RELAY_NARRATION_DELAY_MS / control file):
    // captured at decision time and applied ONLY to the sink
    // handoff below — all dedupe/state bookkeeping above already ran
    // synchronously, so the delay never affects what gets announced, only
    // when it plays. The wait is measured from the decision instant, not
    // added per clip: chained onto the single ordered synthQueue, so by the
    // time an earlier clip's synthesis finishes this floor is usually already
    // elapsed (no cumulative drift), and clips still drain in decision order.
    // The poll loop never awaits synthQueue, so the delay can't stall polling.
    const decidedAt = Date.now();
    const delayMs = this.narrationDelayMs;
    this.synthQueue = this.synthQueue
      .then(async () => {
        const wait = decidedAt + delayMs - Date.now();
        if (wait > 0) await this.sleep(wait);
        await this.sink(spoken, text);
        this.observer?.spoken(clip, false);
      })
      .catch((err) => {
        logError("speech.failed", `Selostusvirhe: ${err instanceof Error ? err.message : err}`);
      });
  }

  /** One-way latch: flips narrationEverReady true the first time the ffmpeg
   *  reader is seen attached. If speech was suppressed while waiting (case B:
   *  scorer already logging events but the source video not yet live), speaks
   *  ONE fresh catch-up recap built from the CURRENT state — a situation
   *  summary mid-game, or the closing line (formatMatchEnd) if the match
   *  already ended during suppression. Nothing suppressed → no extra recap;
   *  match not started → the welcome-filler logic covers it. The recap goes
   *  through the normal speak() path (narration delay + synthQueue) with a
   *  dedicated dedupe key, since its rendered text can legitimately equal the
   *  just-suppressed closing line. Deliberately NOT re-armed on later ffmpeg
   *  drops — see narrationEverReady. */
  private maybeLatchNarrationReady(meta: MatchMetadata): void {
    if (this.narrationEverReady) return;
    if (!this.narrationStatus?.isReaderAttached()) return;
    // First-speech grace: hold the latch until
    // ffmpeg has been attached for firstSpeechDelayMs, measured from the
    // FIRST attach ever (not relay start — the source can go live minutes
    // later), so early viewers have time to join before the first line.
    // Only delays the start of the run: once latched, respawns/flaps add no
    // new wait. Kept separate from narrationDelayMs, which shifts each
    // clip's playback, not the readiness itself.
    if (this.config.firstSpeechDelayMs > 0) {
      const firstAt = this.narrationStatus.firstAttachedAt();
      if (firstAt === null || Date.now() - firstAt < this.config.firstSpeechDelayMs) return;
    }
    this.narrationEverReady = true;
    if (!this.suppressedBeforeAttach || !this.matchStarted) return;
    this.suppressedBeforeAttach = false;
    const ctx = this.buildContext();
    const recap = this.state.finished ? formatMatchEnd(meta, ctx) : formatSituationSummary(meta, ctx);
    logInfo("speech.resumed", "ffmpeg kytkeytyi — puhutaan tuore tilannekooste vaimennettujen selostusten sijaan.");
    this.speak(recap, false, `latch-recap:${recap}`);
  }

  /** True when a pre-game/idle filler is worth synthesizing right now: ffmpeg
   *  attached AND the narration queue empty, so the clip is heard in real time
   *  instead of piling up. With no status port (dry-run/tests)
   *  narration is treated as always ready, preserving prior behavior. Event
   *  narration never goes through this gate — only fillers. */
  private narrationReadyForFiller(): boolean {
    if (!this.narrationStatus) return true;
    // Requires the latch too: during the pre-latch window (first attach not
    // yet made / first-speech grace still running) a filler would only be
    // suppressed by speak() while still burning its dedupe/lastSpeechAt
    // bookkeeping — skip the round entirely instead.
    return (
      this.narrationEverReady &&
      this.narrationStatus.isReaderAttached() &&
      this.narrationStatus.pendingClips() === 0
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}
