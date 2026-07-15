import { fetchMatchMetadata, fetchLiveEvents } from "@pesisselostaja/core";
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
/** No speech for this long → break the silence with an idle filler. */
const IDLE_FILLER_MS = 2 * 60 * 1000;
/** Pre-game: welcome-filler cadence while waiting for the match to start. */
const WELCOME_FILLER_MS = 90 * 1000;
/** API fetch timeout. The server response cache is ~5s (see HANDOFF.md 6b),
 *  so waiting longer than the poll interval for a hung request buys nothing —
 *  keep it short so a stuck fetch doesn't stall the fixed poll cadence. */
const API_TIMEOUT_MS = 4000;

export type SpeechSink = (spokenText: string, readableText: string) => Promise<void>;

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

  constructor(private config: RelayConfig, private sink: SpeechSink) {
    this.state = loadState(config.stateFile);
    this.pronunciations = loadPronunciations(config.pronunciationsFile);
    this.announceBatterChanges = config.announceBatterChanges;
  }

  /** Writes the current setting to the control file so there is always a
   *  discoverable, editable file. Called once at startup, so the config value
   *  (env/CLI/default) is authoritative on start; runtime edits take over
   *  after. */
  private writeControlFile(): void {
    try {
      writeFileSync(
        this.config.controlFile,
        JSON.stringify({ announceBatterChanges: this.announceBatterChanges }, null, 2) + "\n"
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
    let next: boolean | null = null;
    try {
      const parsed = JSON.parse(await readFile(this.config.controlFile, "utf8"));
      if (typeof parsed.announceBatterChanges === "boolean") next = parsed.announceBatterChanges;
    } catch {
      return;
    }
    if (next !== null && next !== this.announceBatterChanges) {
      this.announceBatterChanges = next;
      log(`Pelaajanvaihtojen selostus vaihdettu ajon aikana: ${next ? "PÄÄLLÄ" : "POIS"} (control-tiedostosta).`);
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
    const initial = await fetchLiveEvents(this.config.matchId, {
      apiBase: this.config.apiBase,
      timeoutMs: API_TIMEOUT_MS,
    });
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
    saveState(this.config.stateFile, this.state);
    log(`Ohitettu ${initial.events.length} tapahtumaa`);

    if (!meta.live && meta.started) {
      log("Ottelu on jo päättynyt.");
      return;
    }

    const startupMsg = this.matchStarted
      ? formatStartupSpeech(meta, this.buildContext())
      : formatWelcomeFiller(meta);
    this.speak(startupMsg);
    // Startup already gives the full situation — don't fire the periodic
    // summary immediately on top of it.
    this.state.lastSummaryTime = Date.now();
    this.lastSummaryCount = this.state.announcementCount;

    log("Selostussilmukka käynnissä…");
    // Fixed poll cadence, independent of how long a cycle's fetch/processing
    // takes — synthesis no longer blocks this loop (see speak()/synthQueue),
    // so cycles should normally be fast, but a slow fetch must not add to the
    // next wait on top of its own delay. If a cycle overruns the interval,
    // resume the cadence from now instead of firing a burst of catch-up ticks
    // (no-overlap guard).
    let nextPollAt = Date.now() + this.config.pollInterval;
    while (!signal.aborted) {
      const waitMs = nextPollAt - Date.now();
      if (waitMs > 0) await this.sleepAbortable(waitMs, signal);
      if (signal.aborted) break;
      nextPollAt = Math.max(nextPollAt + this.config.pollInterval, Date.now());
      this.refreshRuntimeControls();
      try {
        const data = await fetchLiveEvents(this.config.matchId, {
          apiBase: this.config.apiBase,
          timeoutMs: API_TIMEOUT_MS,
        });

        // Ordinary bat-turn changes have no dedicated API text marker; they are
        // detected and announced inside processEventsLive, keyed off
        // seenFingerprints/announcedTurnKey (see the comment there).
        await this.processEventsLive(data.events, meta, lookup);

        // Outs for the current turn, kept monotonic per turn key. The API briefly
        // re-keys a turn-ending palo into the next sub-inning, which would make a
        // raw recompute rewind mid-turn (e.g. 3 → 2) after the 3rd palo was
        // already announced; keying the running max to the counted turn resets
        // cleanly on a real turn change but never drops mid-turn.
        if (data.events.length > 0) {
          const { outs, turnKey } = recomputeCurrentOutsKeyed(data.events);
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

        await this.maybeAnnounceSummary(meta);

        saveState(this.config.stateFile, this.state);
      } catch (err) {
        log(`Hakuvirhe: ${err instanceof Error ? err.message : err}`);
      }
    }
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
      this.speak(formatWelcomeFiller(meta), false);
      return;
    }
    if (this.state.announcementCount === 0) return;
    const countDue = this.state.announcementCount - this.lastSummaryCount >= SUMMARY_EVERY_N;
    const idleDue = now - this.lastSpeechAt > IDLE_FILLER_MS;
    if (!countDue && !idleDue) return;
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
    log(`Selostus: ${text}`);
    this.synthQueue = this.synthQueue.then(() => this.sink(spoken, text)).catch((err) => {
      log(`Selostusvirhe: ${err instanceof Error ? err.message : err}`);
    });
  }

  private sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}
