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
import { readFileSync, writeFileSync } from "node:fs";
import { log } from "./log.js";
import type { RelayConfig } from "./config.js";

const SUMMARY_EVERY_N = 10;
/** No speech for this long → break the silence with an idle filler. */
const IDLE_FILLER_MS = 2 * 60 * 1000;

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
  private abort: AbortController | null = null;
  /** Current effective value of the batter-change setting. Seeded from config
   *  at startup, then overridable mid-match via the control file. */
  private announceBatterChanges: boolean;

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
   *  treated as an error, so a half-written edit can't crash the loop. */
  private refreshRuntimeControls(): void {
    let next: boolean | null = null;
    try {
      const parsed = JSON.parse(readFileSync(this.config.controlFile, "utf8"));
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
    });
    const lookup = buildPlayerLookup(meta);
    log(`${meta.home.name} vs ${meta.away.name}`);

    log("Ohitetaan historialliset tapahtumat…");
    const initial = await fetchLiveEvents(this.config.matchId, { apiBase: this.config.apiBase });
    this.state.periodRuns = {};
    this.state.currentOuts = 0;
    this.state.paloTurnKey = null;
    this.state.paloTurnMax = 0;
    this.state.currentPeriod = 0;
    this.state.currentBatTeamId = null;
    this.state.finished = false;
    this.processEventsSilent(initial.events, meta);

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

    const startupMsg = formatStartupSpeech(meta, this.buildContext());
    await this.speak(startupMsg);
    // Startup already gives the full situation — don't fire the periodic
    // summary immediately on top of it.
    this.state.lastSummaryTime = Date.now();
    this.lastSummaryCount = this.state.announcementCount;

    log("Selostussilmukka käynnissä…");
    while (!signal.aborted) {
      await this.sleepAbortable(this.config.pollInterval, signal);
      if (signal.aborted) break;
      this.refreshRuntimeControls();
      try {
        const data = await fetchLiveEvents(this.config.matchId, { apiBase: this.config.apiBase });

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
      if (
        turnChanged &&
        !isFirstTurnOfPeriod &&
        event.team != null &&
        turnKey !== state.announcedTurnKey &&
        event.events.some((_, i) => !state.seenFingerprints.has(eventFingerprint(event, i)))
      ) {
        const cur = getPeriodScore(state, state.currentPeriod);
        const msg = formatBatTurnChangeSpeech(
          meta, prevBatTeamId, event.team, cur.home, cur.away, state.currentInning, state.currentBatTurn
        );
        await this.speak(msg);
        state.announcedTurnKey = turnKey;
      }

      for (let i = 0; i < event.events.length; i++) {
        const sub = event.events[i];
        const fp = eventFingerprint(event, i);
        if (state.seenFingerprints.has(fp)) continue;
        state.seenFingerprints.add(fp);

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
        await this.speak(speech);
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
    if (this.state.announcementCount === 0) return;
    const now = Date.now();
    const countDue = this.state.announcementCount - this.lastSummaryCount >= SUMMARY_EVERY_N;
    const idleDue = now - this.lastSpeechAt > IDLE_FILLER_MS;
    if (!countDue && !idleDue) return;
    this.lastSummaryCount = this.state.announcementCount;
    this.state.lastSummaryTime = now;
    this.lastSpeechAt = now;
    const ctx = this.buildContext();
    const summary = countDue ? formatSituationSummary(meta, ctx) : formatIdleSummary(meta, ctx);
    await this.speak(summary, false);
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

  private async speak(text: string, countAnnouncement = true): Promise<void> {
    if (text === this.lastSpeech) return;
    this.lastSpeech = text;
    this.lastSpeechAt = Date.now();
    const spoken = preventOrdinalReading(applyPronunciations(text, this.pronunciations));
    log(`Selostus: ${text}`);
    try {
      await this.sink(spoken, text);
    } catch (err) {
      log(`Selostusvirhe: ${err instanceof Error ? err.message : err}`);
    }
    if (countAnnouncement) this.state.announcementCount++;
  }

  private sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}
