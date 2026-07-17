import { fetchMatchMetadata, fetchLiveEvents, formatHelsinkiTimestamp, type LiveEventsResult } from "@pesisselostaja/core";
import { EventHistory } from "./eventHistory.js";
import {
  buildPlayerLookup,
  subEventToSpeech,
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
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { log } from "./log.js";
import type { RelayConfig } from "./config.js";

const SUMMARY_EVERY_N = 10;
/** No speech for this long → break the silence with an idle filler. 90 s
 *  (was 2 min): with the pipeline's own latency on top, a 2 min gap already
 *  felt like the narration had died (HANDOFF.md 16.7. kohta 4). */
const IDLE_FILLER_MS = 90 * 1000;
/** Pre-game: welcome-filler cadence while waiting for the match to start. */
const WELCOME_FILLER_MS = 90 * 1000;
/** API fetch timeout. The server response cache is ~5s (see HANDOFF.md 6b),
 *  so waiting longer than the poll interval for a hung request buys nothing —
 *  keep it short so a stuck fetch doesn't stall the fixed poll cadence. */
const API_TIMEOUT_MS = 4000;
/** Delta polling (HANDOFF.md 15.7. kohta 6): events carry no per-event
 *  wall-clock field (verified against real data 2026-07-17 — only the
 *  match-epoch-relative `timestamp`), so the `after=` value is derived from
 *  the last successful response's Date header minus this safety margin. The
 *  margin must exceed the API's publish delay (~68–123 s measured with
 *  skip-delay), or an event could become visible only after our `after` has
 *  already moved past its server-side wall-clock time and be missed. */
const AFTER_MARGIN_MS = 180 * 1000;
/** Periodic full refetch that replaces the local delta-merged history —
 *  cheap insurance against anything the merge can't see (server rewrites,
 *  period-3 re-keyed transients). */
const RESYNC_EVERY_MS = 60 * 1000;
/** Floor for the control file's pollIntervalMs — the server response cache is
 *  ~5 s, so polling much faster only burns requests. */
const MIN_POLL_INTERVAL_MS = 2000;

export type SpeechSink = (spokenText: string, readableText: string) => Promise<void>;

/** Lets the loop see the narration output stage so it can decide whether a
 *  pre-game filler is worth synthesizing right now (HANDOFF.md 7). Kept as a
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
   *  FIFO and play out minutes stale in one burst on connect (HANDOFF.md 7,
   *  case B). AFTER the latch the behavior deliberately never reverts —
   *  mid-game ffmpeg drops (flapping source) keep queueing event narration
   *  exactly as before, since a short outage losing all narration is the
   *  worse failure mode there (144203); revisiting that is a separate open
   *  HANDOFF question. */
  private narrationEverReady: boolean;
  /** True if any speech was suppressed pre-latch, so the latch moment knows
   *  to speak one fresh catch-up recap instead of the stale suppressed clips. */
  private suppressedBeforeAttach = false;
  /** False until the match has produced any event — the endpoint always
   *  returns the full history, so an empty history means the game genuinely
   *  hasn't started and the loop speaks welcome fillers instead of recaps. */
  private matchStarted = false;
  /** Estimated wall-clock instant (ms) corresponding to event.timestamp=0,
   *  for the first-seen delay log (HANDOFF.md 6c). The API gives no epoch
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
  private deltaCursor: { after: string; etag: string | null } | null = null;

  constructor(
    private config: RelayConfig,
    private sink: SpeechSink,
    private narrationStatus?: NarrationStatus
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

  /** Whether the match has ended ("Ottelu päättyi" seen, not reopened) — read
   *  by the ffmpeg supervisor to pick the shorter give-up window
   *  (finishedFailureWindowMs) once retrying a dead source is pointless. */
  get matchFinished(): boolean {
    return this.state.finished;
  }

  /** Writes the current setting to the control file so there is always a
   *  discoverable, editable file. Called once at startup, so the config value
   *  (env/CLI/default) is authoritative on start; runtime edits take over
   *  after. */
  private writeControlFile(): void {
    try {
      writeFileSync(
        this.config.controlFile,
        JSON.stringify(
          {
            announceBatterChanges: this.announceBatterChanges,
            narrationDelayMs: this.narrationDelayMs,
            deltaFetch: this.deltaFetch,
            pollIntervalMs: this.pollIntervalMs,
          },
          null,
          2
        ) + "\n"
      );
    } catch (err) {
      log(`Control-tiedoston kirjoitus epäonnistui: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Re-reads the control file each poll and applies a changed setting live.
   *  A missing/invalid file is ignored (keep the current value) rather than
   *  treated as an error, so a half-written edit can't crash the loop.
   *  Async read: a sync one would block NarrationFifo's 20ms tick every
   *  poll (HANDOFF.md 8). */
  private async refreshRuntimeControls(): Promise<void> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await readFile(this.config.controlFile, "utf8"));
    } catch {
      return;
    }
    if (typeof parsed.announceBatterChanges === "boolean" && parsed.announceBatterChanges !== this.announceBatterChanges) {
      this.announceBatterChanges = parsed.announceBatterChanges;
      log(`Pelaajanvaihtojen selostus vaihdettu ajon aikana: ${this.announceBatterChanges ? "PÄÄLLÄ" : "POIS"} (control-tiedostosta).`);
    }
    // Runtime narration-delay override: the control-file value wins over the
    // env/CLI seed once set. Ignore invalid/negative values so a half-written
    // edit can't turn every wait computation into NaN (see speak()).
    if (typeof parsed.narrationDelayMs === "number" && Number.isFinite(parsed.narrationDelayMs)) {
      const next = Math.max(0, Math.round(parsed.narrationDelayMs));
      if (next !== this.narrationDelayMs) {
        this.narrationDelayMs = next;
        log(`Selostusviive vaihdettu ajon aikana: ${next} ms (control-tiedostosta).`);
      }
    }
    // Delta polling on/off live — false reverts to plain full fetches on the
    // very next poll (the local history is simply rebuilt from each response).
    if (typeof parsed.deltaFetch === "boolean" && parsed.deltaFetch !== this.deltaFetch) {
      this.deltaFetch = parsed.deltaFetch;
      log(`Delta-haku vaihdettu ajon aikana: ${this.deltaFetch ? "PÄÄLLÄ" : "POIS (täyshaut)"} (control-tiedostosta).`);
    }
    // Poll cadence live; clamped to the floor so a typo can't hammer the API.
    if (typeof parsed.pollIntervalMs === "number" && Number.isFinite(parsed.pollIntervalMs)) {
      const next = Math.max(MIN_POLL_INTERVAL_MS, Math.round(parsed.pollIntervalMs));
      if (next !== this.pollIntervalMs) {
        this.pollIntervalMs = next;
        log(`Pollausväli vaihdettu ajon aikana: ${next} ms (control-tiedostosta).`);
      }
    }
  }

  async run(): Promise<void> {
    this.abort = new AbortController();
    const signal = this.abort.signal;

    this.writeControlFile();
    log(
      `Pelaajanvaihtojen selostus: ${this.announceBatterChanges ? "PÄÄLLÄ" : "POIS"} ` +
        `(vaihda ajon aikana: ${this.config.controlFile})`
    );

    log(`Haetaan ottelutietoja (ID: ${this.config.matchId})…`);
    const meta = await fetchMatchMetadata(this.config.matchId, {
      apiBase: this.config.apiBase,
      apiKey: this.config.apiKey,
      timeoutMs: API_TIMEOUT_MS,
    });
    const lookup = buildPlayerLookup(meta);
    log(`${meta.home.name} vs ${meta.away.name}`);

    log("Ohitetaan historialliset tapahtumat…");
    // Full fetch — also seeds the local history + delta cursor (see
    // fetchEventsForPoll).
    const initial = await this.fetchFullEvents();
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
    log(`Ohitettu ${initial.events.length} tapahtumaa`);

    if (!meta.live && meta.started) {
      log("Ottelu on jo päättynyt.");
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
    // on connect (HANDOFF.md 7) — skipping it here just defers it to
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

    log(`Selostussilmukka käynnissä… (polli ${this.pollIntervalMs} ms, delta-haku ${this.deltaFetch ? "PÄÄLLÄ" : "POIS"})`);
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
      // Checked before processing so a latch-moment catch-up recap enters the
      // synth queue ahead of any events found in this same poll — the recap
      // covers the suppressed past, the events then narrate the present.
      this.maybeLatchNarrationReady(meta);
      try {
        // Full fetch or delta merge; either way `history` holds the complete
        // event list afterwards, which is what ALL processing below runs on —
        // the existing logic (fingerprints, outs recompute, palo ordinals)
        // assumes the full history every poll and stays unchanged. Null =
        // 304, nothing new: skip event processing, keep fillers/state alive.
        const data = await this.fetchEventsForPoll();
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
      } catch (err) {
        log(`Hakuvirhe: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /** Full events fetch: replaces the local history and re-bases the delta
   *  cursor. Used at startup, when delta polling is off, for the periodic
   *  resync, and as the fallback whenever a delta looks untrustworthy. */
  private async fetchFullEvents(): Promise<LiveEventsResult> {
    const res = await fetchLiveEvents(this.config.matchId, {
      apiBase: this.config.apiBase,
      timeoutMs: API_TIMEOUT_MS,
      skipDelay: true,
    });
    this.history.replace(res.events);
    if (res.serverDateMs) this.lastServerDateMs = res.serverDateMs;
    this.lastFullFetchAt = Date.now();
    this.deltaCursor = null; // next delta re-bases on the fresh server date
    return res;
  }

  /** One poll's events fetch (HANDOFF.md 15.7. kohta 6). Delta mode asks only
   *  for recent events (`after=` + If-None-Match) and merges them into the
   *  local full history; returns null on 304 (nothing changed). Falls back to
   *  an immediate full fetch on the server's reset flag or an inconsistent
   *  merge, and does a periodic full resync regardless as cheap insurance.
   *
   *  The `after` value: events carry no wall-clock field, so it derives from
   *  the last 200's Date header minus AFTER_MARGIN_MS. The base only advances
   *  when a delta actually delivers changes, keeping the URL stable through
   *  quiet stretches so the ETag can 304. */
  private async fetchEventsForPoll(): Promise<LiveEventsResult | null> {
    if (!this.deltaFetch) return this.fetchFullEvents();
    if (this.lastServerDateMs === null || Date.now() - this.lastFullFetchAt >= RESYNC_EVERY_MS) {
      return this.fetchFullEvents();
    }
    const after =
      this.deltaCursor?.after ?? formatHelsinkiTimestamp(new Date(this.lastServerDateMs - AFTER_MARGIN_MS));
    const res = await fetchLiveEvents(this.config.matchId, {
      apiBase: this.config.apiBase,
      timeoutMs: API_TIMEOUT_MS,
      skipDelay: true,
      after,
      etag: this.deltaCursor?.after === after ? (this.deltaCursor.etag ?? undefined) : undefined,
    });
    if (res.notModified) return null;
    if (res.reset) {
      log("Delta-vastauksessa reset-lippu → täyshaku ja paikallisen historian uudelleenrakennus.");
      return this.fetchFullEvents();
    }
    const merge = this.history.merge(res.events);
    if (merge.inconsistent) {
      log("Delta-epäkonsistenssi (tapahtuman alitapahtumalista kutistui) → täyshaku.");
      return this.fetchFullEvents();
    }
    if (merge.added > 0 || merge.updated > 0) {
      log(`Delta-haku: ${merge.added} uutta, ${merge.updated} päivittynyttä tapahtumaa (historiassa ${this.history.size}).`);
      // Advance the cursor only now: the new base's URL changes, so its ETag
      // starts fresh on the next poll's 200.
      if (res.serverDateMs) {
        this.lastServerDateMs = res.serverDateMs;
        this.deltaCursor = null;
      }
    } else {
      // Nothing new — keep the URL stable and remember its ETag for a 304.
      this.deltaCursor = { after, etag: res.etag ?? null };
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

      // First-seen delay log (HANDOFF.md 6c): one line per event with at
      // least one genuinely new sub-event (not per sub-event), so a later
      // pass can split total delay into API-side publish delay (this delta)
      // vs. our own portion (speak-time minus this log's timestamp).
      if (hasNewSubEvent && event.timestamp !== null) {
        const candidateEpochMs = Date.now() - event.timestamp * 1000;
        this.matchEpochMs =
          this.matchEpochMs === null ? candidateEpochMs : Math.min(this.matchEpochMs, candidateEpochMs);
        const deltaS = Math.round((Date.now() - (this.matchEpochMs + event.timestamp * 1000)) / 1000);
        log(`first-seen: id=${event.id} ts=${event.timestamp} delta=${deltaS}s`);
      }

      for (let i = 0; i < event.events.length; i++) {
        const sub = event.events[i];
        const fp = eventFingerprint(event, i);
        if (state.seenFingerprints.has(fp)) continue;
        state.seenFingerprints.add(fp);

        // A score change after "Ottelu päättyi" means the scorer ended the
        // game too early and reopened it — the finished gate is not one-way,
        // narration wakes back up here.
        if (state.finished && isRunScoringSubEvent(sub)) {
          state.finished = false;
          log("Pistetilanne muuttui ottelun päättymisen jälkeen — selostus jatkuu.");
        }

        if (isMatchEndSubEvent(sub)) state.finished = true;

        if (isRunScoringSubEvent(sub) && event.team !== null) {
          addRun(state, event.period, event.team === meta.home.id, runValueOfSubEvent(sub));
          const s = getPeriodScore(state, event.period);
          log(`Pisteet (${periodName(event.period)}): ${meta.home.shorthand} ${s.home}-${s.away} ${meta.away.shorthand}`);
        }

        // For an out, the spoken ordinal must come from the turn-key recompute
        // (same source as the scoreboard), not the running currentOuts which
        // can drift across polls.
        const ctx = this.buildContext();
        if (isOutSubEvent(sub) && event.team !== null) {
          ctx.currentOuts = outsThroughSubEvent(events, ei, i);
          const team = event.team === meta.home.id ? meta.home.shorthand : meta.away.shorthand;
          log(`Palo: ${team} ${ctx.currentOuts}`);
        }

        const speech = subEventToSpeech(event, sub, meta, lookup, this.announceBatterChanges, ctx);
        if (!speech) continue;
        // After the closing announcement everything else stays silent (the
        // match-end sub-event itself is what speaks that closing line).
        if (state.finished && !isMatchEndSubEvent(sub)) continue;
        // Same texts in the same turn and situation = a scorer double-marking.
        const dedupeKey = `${event.period}:${event.inning}:${event.batTurn}:${event.team}:` +
          `${JSON.stringify(sub.texts)}:${ctx.periodHomeRuns}:${ctx.periodAwayRuns}:${ctx.currentOuts}`;
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
    // After the closing announcement the narration goes fully silent — no
    // recaps, fillers, or batter calls — until a post-end score change wakes
    // it (see processEventsLive). The relay/ffmpeg keep running regardless.
    if (this.state.finished) return;
    const now = Date.now();
    // Pre-game there is no situation to recap; keep the wait warm instead.
    if (!this.matchStarted) {
      if (now - this.lastSpeechAt < WELCOME_FILLER_MS) return;
      // Only synthesize the welcome filler when it will actually be heard in
      // real time (ffmpeg attached, queue empty). Otherwise skip this round —
      // the ~90s cadence assumes real-time playback, and queuing fillers
      // before ffmpeg attaches makes them all burst on connect (HANDOFF.md 7).
      if (!this.narrationReadyForFiller()) return;
      this.speak(formatWelcomeFiller(meta), false);
      return;
    }
    if (this.state.announcementCount === 0) return;
    const countDue = this.state.announcementCount - this.lastSummaryCount >= SUMMARY_EVERY_N;
    const idleDue = now - this.lastSpeechAt > IDLE_FILLER_MS;
    if (!countDue && !idleDue) return;
    // Same readiness gate as the pre-game branch: an in-game recap/idle filler
    // is worthless unless it is heard in real time. Skip WITHOUT advancing the
    // bookkeeping below, so the first ready poll speaks a fresh one instead of
    // queueing stale "tilanne on edelleen…" clips every ~2 min through a long
    // ffmpeg outage (HANDOFF.md 7, extension). Event narration is unaffected.
    if (!this.narrationReadyForFiller()) return;
    this.lastSummaryCount = this.state.announcementCount;
    this.state.lastSummaryTime = now;
    this.lastSpeechAt = now;
    const ctx = this.buildContext();
    const summary = countDue ? formatSituationSummary(meta, ctx) : formatIdleSummary(meta, ctx);
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
   *  seconds (see HANDOFF.md 6b). synthQueue keeps clips in order while
   *  letting the poll loop run on its own fixed cadence. */
  private speak(text: string, countAnnouncement = true, dedupeKey: string = text): void {
    if (dedupeKey === this.lastSpeech) return;
    this.lastSpeech = dedupeKey;
    this.lastSpeechAt = Date.now();
    if (countAnnouncement) this.state.announcementCount++;
    const spoken = preventOrdinalReading(applyPronunciations(text, this.pronunciations));
    // Pre-first-attach suppression (HANDOFF.md 7, case B): all decision-time
    // bookkeeping above ran normally — so dedupe/scoring/turn state stay
    // exactly as if the clip had played — but the sink handoff is skipped:
    // synthesizing now would only stack stale clips in the FIFO to burst out
    // on connect. The latch moment speaks one fresh recap instead (see
    // maybeLatchNarrationReady). Never reverts after the first attach.
    if (!this.narrationEverReady) {
      this.suppressedBeforeAttach = true;
      log(`Selostus (vaimennettu — ffmpeg ei vielä kytkeytynyt): ${text}`);
      return;
    }
    log(`Selostus: ${text}`);
    // Artificial playback delay (RELAY_NARRATION_DELAY_MS / control file,
    // HANDOFF.md 8): captured at decision time and applied ONLY to the sink
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
      })
      .catch((err) => {
        log(`Selostusvirhe: ${err instanceof Error ? err.message : err}`);
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
    // First-speech grace (HANDOFF.md 16.7. kohta 1): hold the latch until
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
    log("ffmpeg kytkeytyi — puhutaan tuore tilannekooste vaimennettujen selostusten sijaan.");
    this.speak(recap, false, `latch-recap:${recap}`);
  }

  /** True when a pre-game/idle filler is worth synthesizing right now: ffmpeg
   *  attached AND the narration queue empty, so the clip is heard in real time
   *  instead of piling up (HANDOFF.md 7). With no status port (dry-run/tests)
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
