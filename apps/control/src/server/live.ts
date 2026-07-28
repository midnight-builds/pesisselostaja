/** The live aggregator: one background poller that assembles the single
 *  LiveState the phone renders, so N connected clients cost one set of polls
 *  instead of N.
 *
 *  Phase A constraint: the relay publishes no telemetry yet (that is phase B —
 *  `status-<ID>.json` + `timeline-<ID>.ndjson`). Everything here is therefore
 *  derived from OUTSIDE evidence: systemd's unit state, journald prose, the
 *  pesistulokset feed and the machine's own vitals. Where that makes a value a
 *  guess, it is marked as one rather than dressed up. */

import {
  buildPlayerLookup,
  eventFingerprint,
  fetchLiveEvents,
  fetchMatchMetadata,
  outsThroughSubEvent,
  subEventToFeedText,
  subEventToSpeech,
  type LiveEvent,
  type MatchMetadata,
  type PlayerLookup,
  type SpeechContext,
} from "@pesisselostaja/core";
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
  SystemState,
} from "../shared/types.js";
import { getActiveJob } from "./jobs.js";
import { readLog } from "./journal.js";
import { getMatchState } from "./matches.js";
import { getRelayProcess, readKnobs } from "./relay.js";
import { getSystemState } from "./system.js";

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
/** Narration lines kept in memory / pushed to the client. */
const NARRATION_KEEP = 40;
/** When we attach to a match already in progress we have no idea when its past
 *  events happened, so we show only the tail of them. */
const NARRATION_BACKFILL = 10;

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
type SourceKey = ChainKey | "job" | "knobs" | "log";

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

interface Snapshot {
  now: number;
  job: Job | null;
  relay: RelayProcess;
  match: MatchState;
  system: SystemState;
  log: LogLine[];
  /** Per-source failures from this cycle; a failed source can't be judged
   *  healthy just because its last known value looked fine. */
  errors: Map<SourceKey, string>;
}

function minutes(sec: number | null): string {
  if (sec === null) return "kesto tuntematon";
  return sec < 60 ? `${sec} s` : `${Math.round(sec / 60)} min`;
}

/** The one sentence the operator reads standing in a field, in priority order.
 *  Every rule is a decision, not a formula — hence the comments. First match
 *  wins, so the order below IS the policy. */
function deriveHealth(snap: Snapshot): { health: Health; headline: string } {
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

  // 2. A job that believes it is live while the unit is down is the worst
  //    silent failure we have: nothing is being broadcast and nothing says so.
  if (job?.status === "live" && !relay.active) {
    return {
      health: "fail",
      headline: `Relay ei ole käynnissä (${relay.activeState}) vaikka lähetyksen pitäisi olla ajossa`,
    };
  }

  // 3. No work at all. Checked before the "all good" rules so an idle box reads
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

  // 4. Flapping. The stream technically exists but viewers hear gaps, so this
  //    is a warning the operator can act on (check the phone's uplink) rather
  //    than a failure we should escalate.
  if (respawns >= RESPAWN_WARN_COUNT) {
    return {
      health: "warn",
      headline: `ffmpeg respawnasi ${respawns}× viime minuutteina — kuva pätkii`,
    };
  }

  // 5. Relay up, match still going: the normal, boring, good case. The duration
  //    is the detail the operator actually wants ("42 min").
  if (relay.active && !match.finished) {
    return { health: "ok", headline: `Lähetys kunnossa, ${minutes(relay.uptimeSec)}` };
  }

  // 6. Match over but the unit still up — expected: the relay shuts itself down
  //    once the source ends, and we never cut it short (uptime first).
  if (relay.active && match.finished) {
    return { health: "ok", headline: "Ottelu päättyi — relay sammuu itse kun lähde loppuu" };
  }

  // 7. Job exists, relay down, but the job isn't claiming to be live: waiting
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

/** Six dots, each one sentence. Any source that threw this cycle is red with
 *  its own error text — a stale green here would be a lie. */
function buildChain(snap: Snapshot, knobs: ControlKnobs | null): ChainStatus[] {
  const { job, relay, match, system, errors, now } = snap;
  const rows: ChainStatus[] = [];

  // --- Lähde: the phone's own YouTube live, which we only ever read. We have
  // no direct view of it in phase A, so the evidence is the relay's own log.
  const notLive = lastMatching(snap.log, PHRASE.sourceNotLive);
  const ffmpegStart = lastMatching(snap.log, PHRASE.ffmpegStart);
  if (!job) {
    rows.push(chainRow("source", "Lähde", "idle", "ei aktiivista työtä"));
  } else if (!job.sourceUrl) {
    rows.push(chainRow("source", "Lähde", "warn", "lähde-URL puuttuu työstä"));
  } else if (!relay.active) {
    rows.push(chainRow("source", "Lähde", "idle", "relay ei lue lähdettä"));
  } else if (notLive && (!ffmpegStart || Date.parse(notLive.ts) > Date.parse(ffmpegStart.ts))) {
    // Waiting for a scheduled start is a normal, healthy state — the relay
    // sleeps and rechecks without burning its give-up window.
    rows.push(chainRow("source", "Lähde", "ok", "ei vielä livenä — relay odottaa"));
  } else if (ffmpegStart) {
    rows.push(chainRow("source", "Lähde", "ok", "ffmpeg kiinni lähteessä"));
  } else {
    rows.push(chainRow("source", "Lähde", "warn", "ei havaintoa lähteestä lokissa"));
  }

  // --- Relay: the one row we can state as fact. All four reads that describe
  // the relay (unit state, journal, job store, control file) surface here,
  // because a failure in any of them means this row's green is unverified.
  const respawns = countRecentRespawns(snap.log, now);
  const relayError =
    errors.get("relay") ?? errors.get("log") ?? errors.get("job") ?? errors.get("knobs");
  if (relayError) {
    rows.push(chainRow("relay", "Relay", "fail", relayError));
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

  // --- Jono: narration waiting for synthesis + mixing, from the heartbeat line.
  const queue = parseQueueDepth(snap.log);
  const delay = knobs ? `, viive ${knobs.narrationDelayMs} ms` : "";
  if (!relay.active) {
    rows.push(chainRow("queue", "Jono", "idle", "ei ajossa"));
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
  if (!job) {
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

  // --- API: pesistulokset, the source of everything we narrate.
  if (errors.has("api")) {
    rows.push(chainRow("api", "Tulospalvelu", "fail", errors.get("api") ?? "haku epäonnistui"));
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

// ------------------------------------------------------------ narration list

/** Phase A narration: derived from the pesistulokset feed, not from the relay.
 *
 *  That means these lines are what the relay SHOULD say, not proof that it did:
 *  `spokenAt` is always null and every line renders as queued. Two known
 *  inaccuracies, both accepted on purpose until phase B's timeline-<ID>.ndjson
 *  gives us the real two-phase state:
 *   - the wording can differ from what was spoken, because speech variants are
 *     picked at random per call (pickVariant);
 *   - `detectedAt` is when WE saw the event, which trails the relay's own
 *     detection by up to one poll interval. */
interface NarrationCache {
  matchId: number;
  meta: MatchMetadata | null;
  lookup: PlayerLookup | null;
  /** Fingerprints already turned into lines. eventFingerprint includes the turn
   *  coordinates, because event.id restarts at 0 every turn — without them the
   *  second turn's first palo collides with the first turn's and disappears. */
  seen: Set<string>;
  seeded: boolean;
  lines: NarrationLine[];
}

function newNarrationCache(matchId: number): NarrationCache {
  return { matchId, meta: null, lookup: null, seen: new Set(), seeded: false, lines: [] };
}

/** The scoreboard context the speech functions need. Rebuilt from the MatchState
 *  we just fetched instead of kept as our own running tally — the derived
 *  scoreboard already lives in matches.ts, and two counters counting the same
 *  markings would eventually disagree. Without a context the closing line reads
 *  "Ottelu päättyi! X null, Y null" and every palo loses its ordinal. */
function speechContextFrom(match: MatchState, events: LiveEvent[]): SpeechContext {
  // Turn coordinates come from the last event that has a batting team, exactly
  // the way core derives them — never guessed from counters.
  let last: LiveEvent | null = null;
  for (const event of events) if (event.team != null) last = event;
  const currentPeriod = match.currentPeriod ?? last?.period ?? 0;
  const score = match.periodScores[currentPeriod] ?? { home: 0, away: 0 };
  return {
    periodHomeRuns: score.home,
    periodAwayRuns: score.away,
    homePeriodsWon: match.periodsWonHome,
    awayPeriodsWon: match.periodsWonAway,
    // "Periods with any recorded runs" — camp matches are often a single jakso,
    // where periodsWon can't decide anything (reference: match formats vary).
    periodsPlayed: match.periodScores.filter((p) => p.home > 0 || p.away > 0).length,
    currentOuts: match.palot ?? 0,
    currentPeriod,
    currentBatTeamId: last?.team ?? null,
    currentInning: last?.inning ?? 0,
    currentBatTurn: last?.batTurn ?? 0,
  };
}

function buildNarrationLines(
  cache: NarrationCache,
  events: LiveEvent[],
  match: MatchState,
  announceBatterChanges: boolean
): void {
  const meta = cache.meta;
  const lookup = cache.lookup;
  if (!meta || !lookup) return;

  const ctx = speechContextFrom(match, events);
  const fresh: NarrationLine[] = [];
  const detectedAt = new Date().toISOString();
  for (let e = 0; e < events.length; e++) {
    const event = events[e];
    for (let i = 0; i < event.events.length; i++) {
      const fingerprint = eventFingerprint(event, i);
      if (cache.seen.has(fingerprint)) continue;
      cache.seen.add(fingerprint);
      const sub = event.events[i];
      // Palot are announced with an ordinal ("kolmas palo"), and the ordinal is
      // the count AT THAT MOMENT, not the current one — same call the relay's
      // commentary loop makes per sub-event.
      ctx.currentOuts = outsThroughSubEvent(events, e, i);
      const speech = subEventToSpeech(event, sub, meta, lookup, announceBatterChanges, ctx);
      const text = subEventToFeedText(speech, sub, lookup);
      if (!text) continue;
      fresh.push({ id: fingerprint, detectedAt, spokenAt: null, text });
    }
  }

  if (!cache.seeded) {
    // First poll for this match: the whole history arrives at once (the events
    // endpoint is never windowed). Timestamping all of it "now" would fake a
    // burst of narration, so only the tail is shown — and even that carries an
    // approximate detectedAt, since the feed gives no per-event wall clock.
    cache.seeded = true;
    cache.lines = fresh.slice(-NARRATION_BACKFILL);
    return;
  }
  cache.lines = [...cache.lines, ...fresh].slice(-NARRATION_KEEP);
}

// ------------------------------------------------------------------ the loop

export function startLiveAggregator(opts: LiveAggregatorOptions = {}): LiveAggregator {
  const readActiveJob = opts.getActiveJob ?? getActiveJob;
  const subscribers = new Set<(state: LiveState) => void>();
  const errors = new Map<SourceKey, string>();
  let narration = newNarrationCache(-1);
  let stopped = false;

  let job: Job | null = null;
  let relay = emptyRelay();
  let system = emptySystem();
  let match = emptyMatch();
  let knobs: ControlKnobs | null = null;
  let log: LogLine[] = [];

  let state: LiveState = assemble();

  function assemble(): LiveState {
    const snap: Snapshot = { now: Date.now(), job, relay, match, system, log, errors };
    const { health, headline } = deriveHealth(snap);
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
      job,
      narration: narration.lines,
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
      await track("relay", () => readLog({ limit: LOG_LINES }), (value) => {
        log = value;
      });
      // The job file is a local read; it drives which match we poll, so it has
      // to refresh at the fast cadence rather than the match one.
      await track("relay", readActiveJob, (value) => {
        job = value;
      });
      if (job) {
        const matchId = job.matchId;
        await track("relay", () => readKnobs(matchId), (value) => {
          knobs = value;
        });
      } else {
        knobs = null;
      }
      publish();
    } finally {
      fastBusy = false;
    }
  }

  let matchBusy = false;
  async function tickMatch(): Promise<void> {
    if (stopped || matchBusy) return;
    // Never poll pesistulokset without a job: it is someone else's public API
    // and an idle control app has no business hitting it at all.
    if (!job) {
      match = emptyMatch();
      narration = newNarrationCache(-1);
      return;
    }
    matchBusy = true;
    const matchId = job.matchId;
    try {
      await track("api", () => getMatchState(matchId), (value) => {
        match = value;
      });
      await track("api", () => pollNarration(matchId), () => undefined);
      publish();
    } finally {
      matchBusy = false;
    }
  }

  async function pollNarration(matchId: number): Promise<void> {
    if (narration.matchId !== matchId) narration = newNarrationCache(matchId);
    if (!narration.meta) {
      // Rosters are fetched once per match: names come from here, and a relay
      // that started before the match was opened is exactly how player numbers
      // end up wrong for a whole game.
      narration.meta = await fetchMatchMetadata(matchId, { timeoutMs: 8000 });
      narration.lookup = buildPlayerLookup(narration.meta);
    }
    // skip-delay mirrors what the relay asks for, so our list isn't a couple of
    // minutes behind the narration it is supposed to describe.
    const result = await fetchLiveEvents(matchId, { skipDelay: true, timeoutMs: 8000 });
    // `match` was refreshed by getMatchState earlier in this same tick, so the
    // scoreboard the speech quotes is the one the UI is showing.
    buildNarrationLines(narration, result.events, match, knobs?.announceBatterChanges ?? true);
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
