import { fetchMatchMetadata, fetchLiveEvents } from "../../src/api.js";
import {
  buildPlayerLookup,
  subEventToSpeech,
  isRunScoringSubEvent,
  isOutSubEvent,
  isMatchEndSubEvent,
  runValueOfSubEvent,
  eventFingerprint,
  formatStartupSpeech,
  formatBatTurnChangeSpeech,
  formatSituationSummary,
  periodName,
  type PlayerLookup,
  type SpeechContext,
} from "../../src/speech.js";
import {
  loadState,
  saveState,
  getPeriodScore,
  addRun,
  periodsWon,
  periodsPlayed,
  type WatcherState,
} from "../../src/state.js";
import {
  loadPronunciations,
  applyPronunciations,
  preventOrdinalReading,
  type PronunciationRule,
} from "../../src/pronunciation.js";
import type { LiveEvent, MatchMetadata } from "../../src/types.js";
import { log } from "./log.js";
import type { RelayConfig } from "./config.js";

const SUMMARY_INTERVAL_MS = 5 * 60 * 1000;
const SUMMARY_EVERY_N = 10;

export type SpeechSink = (spokenText: string, readableText: string) => Promise<void>;

/** Standalone ~6s poll loop that reproduces WatcherController's announcement
 *  content/timing (src/watcher.ts) using the same pure speech/state helpers,
 *  but hands each announcement to a SpeechSink (narration synthesis) instead
 *  of Home Assistant/browser output. Deliberately a separate implementation,
 *  not a reuse of WatcherController, since that class is wired to HA/browser
 *  output — see relay/DESIGN.md. */
export class CommentaryLoop {
  private state: WatcherState;
  private pronunciations: PronunciationRule[];
  private lastSpeech: string | null = null;
  private abort: AbortController | null = null;

  constructor(private config: RelayConfig, private sink: SpeechSink) {
    this.state = loadState(config.stateFile);
    this.pronunciations = loadPronunciations(config.pronunciationsFile);
  }

  async run(): Promise<void> {
    this.abort = new AbortController();
    const signal = this.abort.signal;

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
    this.state.currentPeriod = 0;
    this.state.currentBatTeamId = null;
    this.state.finished = false;
    await this.processEvents(initial.events, meta, lookup, true);

    if (initial.team != null) this.state.currentBatTeamId = initial.team;
    if ((initial.period ?? 0) > 0) this.state.currentPeriod = initial.period!;
    saveState(this.config.stateFile, this.state);
    log(`Ohitettu ${initial.events.length} tapahtumaa`);

    if (!meta.live && meta.started) {
      log("Ottelu on jo päättynyt.");
      return;
    }

    const startupMsg = formatStartupSpeech(meta, this.buildContext());
    await this.speak(startupMsg);

    log("Selostussilmukka käynnissä…");
    while (!signal.aborted) {
      await this.sleepAbortable(this.config.pollInterval, signal);
      if (signal.aborted) break;
      try {
        const data = await fetchLiveEvents(this.config.matchId, { apiBase: this.config.apiBase });

        const newBatTeam = data.team ?? null;
        if (
          newBatTeam != null &&
          this.state.currentBatTeamId != null &&
          newBatTeam !== this.state.currentBatTeamId &&
          data.events.length === 0
        ) {
          const cur = getPeriodScore(this.state, this.state.currentPeriod);
          const msg = formatBatTurnChangeSpeech(meta, this.state.currentBatTeamId, newBatTeam, cur.home, cur.away);
          await this.speak(msg);
          this.state.currentBatTeamId = newBatTeam;
          this.state.currentOuts = 0;
        }

        await this.processEvents(data.events, meta, lookup, false);

        if (data.team != null && data.team !== this.state.currentBatTeamId) {
          this.state.currentBatTeamId = data.team;
          this.state.currentOuts = 0;
        }
        if ((data.period ?? 0) > this.state.currentPeriod) this.state.currentPeriod = data.period!;

        saveState(this.config.stateFile, this.state);
      } catch (err) {
        log(`Hakuvirhe: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  stop(): void {
    this.abort?.abort();
  }

  private async processEvents(
    events: LiveEvent[],
    meta: MatchMetadata,
    lookup: PlayerLookup,
    silent: boolean
  ): Promise<void> {
    for (const event of events) {
      if (event.team != null && event.team !== this.state.currentBatTeamId) {
        this.state.currentBatTeamId = event.team;
        this.state.currentOuts = 0;
      }
      if (event.period > 0) this.state.currentPeriod = event.period;

      for (let i = 0; i < event.events.length; i++) {
        const sub = event.events[i];
        const fp = eventFingerprint(event, i);
        const alreadySeen = this.state.seenFingerprints.has(fp);
        this.state.seenFingerprints.add(fp);

        if (isMatchEndSubEvent(sub)) this.state.finished = true;

        if (silent) {
          if (isRunScoringSubEvent(sub)) this.updateScore(event, meta, runValueOfSubEvent(sub));
          if (isOutSubEvent(sub)) this.state.currentOuts++;
          continue;
        }

        if (alreadySeen) continue;

        if (isRunScoringSubEvent(sub)) this.updateScore(event, meta, runValueOfSubEvent(sub));
        if (isOutSubEvent(sub)) {
          this.state.currentOuts++;
          const team = event.team === meta.home.id ? meta.home.shorthand : meta.away.shorthand;
          log(`Palo: ${team} ${this.state.currentOuts}`);
        }

        const ctx = this.buildContext();
        const speech = subEventToSpeech(event, sub, meta, lookup, true, ctx);
        if (!speech) continue;

        await this.speak(speech);

        const now = Date.now();
        const needsSummary =
          this.state.announcementCount % SUMMARY_EVERY_N === 0 ||
          now - this.state.lastSummaryTime > SUMMARY_INTERVAL_MS;
        if (needsSummary && this.state.announcementCount > 0) {
          this.state.lastSummaryTime = now;
          const summary = formatSituationSummary(meta, this.buildContext());
          await this.speak(summary, false);
        }
      }

      if (event.timestamp !== null && event.timestamp > this.state.lastTimestamp) {
        this.state.lastTimestamp = event.timestamp;
      }
    }
  }

  private updateScore(event: LiveEvent, meta: MatchMetadata, value: number): void {
    if (event.team === null || value <= 0) return;
    addRun(this.state, event.period, event.team === meta.home.id, value);
    const s = getPeriodScore(this.state, event.period);
    log(`Pisteet (${periodName(event.period)}): ${meta.home.shorthand} ${s.home}-${s.away} ${meta.away.shorthand}`);
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
    };
  }

  private async speak(text: string, countAnnouncement = true): Promise<void> {
    if (text === this.lastSpeech) return;
    this.lastSpeech = text;
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
