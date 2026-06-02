import { fetchMatchMetadata, fetchLiveEvents, type ApiOptions } from "./api.js";
import {
  buildPlayerLookup,
  subEventToSpeech,
  isRunScoringSubEvent,
  isOutSubEvent,
  isMatchEndSubEvent,
  runValueOfSubEvent,
  eventFingerprint,
  recomputeCurrentOuts,
  formatStartupSpeech,
  formatBatTurnChangeSpeech,
  formatSituationSummary,
  periodName,
  type SpeechContext,
} from "./speech.js";
import { applyPronunciations, preventOrdinalReading, type PronunciationRule } from "./pronunciation.js";
import {
  loadState,
  saveState,
  getPeriodScore,
  addRun,
  periodsWon,
  type WatcherState,
} from "./state.js";
import type { LiveEvent, MatchMetadata, SubEvent } from "./types.js";

const SUMMARY_INTERVAL_MS = 5 * 60 * 1000;
const SUMMARY_EVERY_N = 10;

export interface WatcherConfig {
  pollInterval: number;
  announceBatterChanges: boolean;
  apiKey: string;
  apiBase: string;
}

export type FeedType = "run" | "out" | "period" | "bat" | "summary" | "info" | "end";

export interface FeedItem {
  type: FeedType;
  text: string;
}

export interface MatchSnapshot {
  homeName: string;
  awayName: string;
  homeShort: string;
  awayShort: string;
  seriesName: string | null;
  period: number;
  inning: number;
  batTurn: number;
  homeRuns: number;
  awayRuns: number;
  homePeriodsWon: number;
  awayPeriodsWon: number;
  palot: number;
  battingSide: "home" | "away" | null;
  finished: boolean;
}

export interface WatcherCallbacks {
  onLog: (msg: string) => void;
  onMatchInfo: (info: { matchInfo: string; seriesName: string | null; stadiumName: string }) => void;
  onFinished: () => void;
  onError: (err: string) => void;
  onState?: (snapshot: MatchSnapshot) => void;
  onFeed?: (item: FeedItem) => void;
}

export class BrowserWatcher {
  private _abort: AbortController | null = null;
  private _running = false;
  private _lastSpeech: string | null = null;
  private _pronunciations: PronunciationRule[] = [];
  private _audioUnlocked = false;
  private _audioUnlockResolve: (() => void) | null = null;
  private _muted = false;
  private _meta: MatchMetadata | null = null;
  private _state: WatcherState | null = null;
  private _speechQueue: string[] = [];
  private _speechBusy = false;

  constructor(
    private config: WatcherConfig,
    private callbacks: WatcherCallbacks
  ) {}

  get running(): boolean { return this._running; }
  get muted(): boolean { return this._muted; }

  setPronunciations(rules: PronunciationRule[]): void {
    this._pronunciations = rules;
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
    if (muted) this._cancelSpeech();
  }

  /** Speak the current situation summary now (used when the listener un-mutes). */
  announceSituation(): void {
    if (this._muted || !this._meta || !this._state) return;
    const summary = formatSituationSummary(this._meta, this.buildContext(this._state));
    this.speakRaw(applyPronunciations(summary, this._pronunciations));
  }

  markAudioUnlocked(): void {
    this._audioUnlockResolve?.();
    this._audioUnlockResolve = null;
    this._audioUnlocked = true;
  }

  start(matchInput: string): void {
    if (this._running) return;
    const matchId = this.parseMatchInput(matchInput);
    this._abort = new AbortController();
    this._running = true;
    this._lastSpeech = null;
    this.runWatcher(matchId, this._abort.signal).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.callbacks.onError(msg);
      this.log(`Virhe: ${msg}`);
      this._running = false;
    });
  }

  stop(): void {
    this._abort?.abort();
    this._running = false;
    this._cancelSpeech();
    this.log("Seuranta pysäytetty.");
    this.callbacks.onFinished();
  }

  private parseMatchInput(input: string): number {
    const trimmed = input.trim();
    const urlMatch = trimmed.match(/ottelut\/(\d+)/);
    if (urlMatch) return parseInt(urlMatch[1], 10);
    const id = parseInt(trimmed, 10);
    if (!isNaN(id) && id > 0) return id;
    throw new Error(`Ei voida tunnistaa ottelun ID:tä: "${input}"`);
  }

  private log(msg: string): void {
    const ts = new Date().toLocaleTimeString("fi-FI");
    this.callbacks.onLog(`[${ts}] ${msg}`);
  }

  private async runWatcher(matchId: number, signal: AbortSignal): Promise<void> {
    const apiOpts: ApiOptions = { apiBase: this.config.apiBase, apiKey: this.config.apiKey };

    this.log(`Haetaan ottelutietoja (ID: ${matchId})…`);
    const meta = await fetchMatchMetadata(matchId, apiOpts);
    this._meta = meta;
    const lookup = buildPlayerLookup(meta);

    const matchInfo = `${meta.home.name} vs ${meta.away.name}`;
    const seriesName = meta.series.custom_name ?? meta.series.name ?? null;
    const stadiumName = meta.stadium.name;
    this.callbacks.onMatchInfo({ matchInfo, seriesName, stadiumName });

    this.log(matchInfo);
    this.log(`Sarja: ${seriesName ?? "–"} | Kenttä: ${stadiumName}`);
    this.log(`Pelaajia: ${lookup.byId.size}`);

    const state = loadState(matchId);
    this._state = state;

    this.log("Ohitetaan historialliset tapahtumat…");
    const initial = await fetchLiveEvents(matchId, apiOpts);
    state.periodRuns = {};
    state.currentOuts = 0;
    state.currentPeriod = 0;
    state.currentBatTeamId = null;
    state.finished = false;
    this.processEventsSilent(initial.events, state, meta);

    if (initial.team != null) state.currentBatTeamId = initial.team;
    if ((initial.period ?? 0) > 0) state.currentPeriod = initial.period!;

    saveState(matchId, state);
    this.log(`Ohitettu ${initial.events.length} tapahtumaa`);
    this.emitState(state, meta);

    if (!meta.live && meta.started) {
      this.log("Ottelu on jo päättynyt.");
      this._running = false;
      this.callbacks.onFinished();
      return;
    }

    // Wait for audio unlock (browser requires user gesture before speech)
    if (!this._audioUnlocked && !this._muted) {
      this.log("Odotetaan laitteen äänen käynnistystä…");
      await Promise.race([
        new Promise<void>((resolve) => { this._audioUnlockResolve = resolve; }),
        this.sleepAbortable(60000, signal),
      ]);
      if (signal.aborted) { this._running = false; return; }
    }

    const startupMsg = formatStartupSpeech(meta, this.buildContext(state));
    this.say(startupMsg, state);
    this.emitFeed("info", startupMsg);

    this.log("Seuranta käynnissä…");

    while (!signal.aborted) {
      await this.sleepAbortable(this.config.pollInterval * 1000, signal);
      if (signal.aborted) break;
      try {
        const data = await fetchLiveEvents(matchId, apiOpts);

        const newBatTeam = data.team ?? null;
        if (
          newBatTeam != null &&
          state.currentBatTeamId != null &&
          newBatTeam !== state.currentBatTeamId &&
          data.events.length === 0
        ) {
          const newBatTurn = (state.currentBatTurn + 1) % 2;
          const newInning = state.currentBatTurn === 1 ? state.currentInning + 1 : state.currentInning;
          const cur = getPeriodScore(state, state.currentPeriod);
          const msg = formatBatTurnChangeSpeech(
            meta, state.currentBatTeamId, newBatTeam, cur.home, cur.away, newInning, newBatTurn
          );
          this.say(msg, state);
          this.emitFeed("period", msg);
          state.currentBatTeamId = newBatTeam;
          state.currentInning = newInning;
          state.currentBatTurn = newBatTurn;
          state.currentOuts = 0;
        }

        this.processEventsLive(data.events, state, meta, lookup);

        // Recompute outs from all events — processEventsLive only counts NEW sub-events
        // but the team-change reset runs for every event, leaving currentOuts at 0.
        if (data.events.length > 0) {
          state.currentOuts = recomputeCurrentOuts(data.events);
        }

        // Apply period from API before emitting (period is never reset, only advances)
        if ((data.period ?? 0) > 0) state.currentPeriod = data.period!;

        // Emit NOW so the UI snapshot shows the outs count that TTS is announcing.
        // The batting-team correction below may reset currentOuts to 0, but the
        // snapshot is already captured here and stays until the next emitState.
        this.emitState(state, meta);

        // If the API's current batting team differs from what events set, sync it.
        // This happens when the 3rd out ends a turn without an explicit bat-change
        // event arriving yet — the API field is already ahead.
        if (data.team != null && data.team !== state.currentBatTeamId) {
          state.currentBatTeamId = data.team;
          state.currentOuts = 0;
        }

        saveState(matchId, state);
      } catch (err) {
        this.log(`Hakuvirhe: ${err instanceof Error ? err.message : err}`);
      }
    }

    this._running = false;
  }

  private processEventsSilent(events: LiveEvent[], state: WatcherState, meta: MatchMetadata): void {
    for (const event of events) {
      if (event.team != null && (event.team !== state.currentBatTeamId || event.inning !== state.currentInning || event.batTurn !== state.currentBatTurn)) {
        state.currentBatTeamId = event.team;
        state.currentInning = event.inning;
        state.currentBatTurn = event.batTurn;
        state.currentOuts = 0;
      }
      if (event.period > 0) state.currentPeriod = event.period;

      for (let i = 0; i < event.events.length; i++) {
        const sub = event.events[i];
        const fp = eventFingerprint(event, i);
        state.seenFingerprints.add(fp);
        if (isMatchEndSubEvent(sub)) state.finished = true;
        if (isRunScoringSubEvent(sub)) {
          if (event.team !== null) addRun(state, event.period, event.team === meta.home.id, runValueOfSubEvent(sub));
        }
        if (isOutSubEvent(sub)) {
          if (event.team !== null) state.currentOuts++;
        }
      }

      if (event.timestamp !== null && event.timestamp > state.lastTimestamp) {
        state.lastTimestamp = event.timestamp;
      }
    }
  }

  private processEventsLive(
    events: LiveEvent[],
    state: WatcherState,
    meta: MatchMetadata,
    lookup: ReturnType<typeof buildPlayerLookup>
  ): void {
    for (const event of events) {
      if (event.team != null && (event.team !== state.currentBatTeamId || event.inning !== state.currentInning || event.batTurn !== state.currentBatTurn)) {
        state.currentBatTeamId = event.team;
        state.currentInning = event.inning;
        state.currentBatTurn = event.batTurn;
        state.currentOuts = 0;
      }
      if (event.period > 0) state.currentPeriod = event.period;

      for (let i = 0; i < event.events.length; i++) {
        const sub = event.events[i];
        const fp = eventFingerprint(event, i);
        if (state.seenFingerprints.has(fp)) continue;
        state.seenFingerprints.add(fp);

        if (isMatchEndSubEvent(sub)) state.finished = true;

        if (isRunScoringSubEvent(sub)) {
          if (event.team !== null) {
            addRun(state, event.period, event.team === meta.home.id, runValueOfSubEvent(sub));
            const s = getPeriodScore(state, event.period);
            this.log(`Pisteet (${periodName(event.period)}): ${meta.home.shorthand} ${s.home}–${s.away} ${meta.away.shorthand}`);
          }
        }
        if (isOutSubEvent(sub)) {
          if (event.team !== null) {
            state.currentOuts++;
            const team = event.team === meta.home.id ? meta.home.shorthand : meta.away.shorthand;
            this.log(`Palo: ${team} ${state.currentOuts}`);
          }
        }

        const ctx = this.buildContext(state);
        const speech = subEventToSpeech(
          event, sub, meta, lookup, this.config.announceBatterChanges, ctx
        );
        if (!speech) continue;

        this.say(speech, state);
        this.emitFeed(this.classifyFeed(sub, speech), speech);

        const now = Date.now();
        const needsSummary =
          state.announcementCount % SUMMARY_EVERY_N === 0 ||
          now - state.lastSummaryTime > SUMMARY_INTERVAL_MS;
        if (needsSummary && state.announcementCount > 0) {
          state.lastSummaryTime = now;
          const summary = formatSituationSummary(meta, this.buildContext(state));
          this.emitFeed("summary", summary);
          if (!this._muted) setTimeout(() => this.speakRaw(applyPronunciations(summary, this._pronunciations)), 800);
        }
      }

      if (event.timestamp !== null && event.timestamp > state.lastTimestamp) {
        state.lastTimestamp = event.timestamp;
      }
    }
  }

  private classifyFeed(sub: SubEvent, speech: string): FeedType {
    if (isMatchEndSubEvent(sub)) return "end";
    if (isRunScoringSubEvent(sub)) return "run";
    if (isOutSubEvent(sub)) return "out";
    if (/^Vuorossa /.test(speech)) return "bat";
    if (/(jakso|supervuoro|vuoro)/i.test(speech)) return "period";
    return "info";
  }

  private emitFeed(type: FeedType, text: string): void {
    this.callbacks.onFeed?.({ type, text });
  }

  private emitState(state: WatcherState, meta: MatchMetadata): void {
    if (!this.callbacks.onState) return;
    const cur = getPeriodScore(state, state.currentPeriod);
    const won = periodsWon(state);
    const battingSide =
      state.currentBatTeamId === meta.home.id ? "home"
      : state.currentBatTeamId === meta.away.id ? "away"
      : null;
    this.callbacks.onState({
      homeName: meta.home.name,
      awayName: meta.away.name,
      homeShort: meta.home.shorthand,
      awayShort: meta.away.shorthand,
      seriesName: meta.series.custom_name ?? meta.series.name ?? null,
      period: state.currentPeriod,
      inning: state.currentInning,
      batTurn: state.currentBatTurn,
      homeRuns: cur.home,
      awayRuns: cur.away,
      homePeriodsWon: won.home,
      awayPeriodsWon: won.away,
      palot: state.currentOuts,
      battingSide,
      finished: state.finished,
    });
  }

  private buildContext(state: WatcherState): SpeechContext {
    const cur = getPeriodScore(state, state.currentPeriod);
    const won = periodsWon(state);
    return {
      periodHomeRuns: cur.home,
      periodAwayRuns: cur.away,
      homePeriodsWon: won.home,
      awayPeriodsWon: won.away,
      currentOuts: state.currentOuts,
      currentPeriod: state.currentPeriod,
      currentBatTeamId: state.currentBatTeamId,
      currentInning: state.currentInning,
      currentBatTurn: state.currentBatTurn,
    };
  }

  private say(speech: string, state: WatcherState): void {
    if (speech === this._lastSpeech) return;
    this._lastSpeech = speech;
    this.log(`Puhe: ${speech}`);
    this.speakRaw(applyPronunciations(speech, this._pronunciations));
    state.announcementCount++;
  }

  private speakRaw(text: string): void {
    if (this._muted) return;
    if (!("speechSynthesis" in window)) return;
    this._speechQueue.push(preventOrdinalReading(text));
    if (!this._speechBusy) this._drainQueue();
  }

  private _drainQueue(): void {
    if (this._speechQueue.length === 0) { this._speechBusy = false; return; }
    this._speechBusy = true;
    const text = this._speechQueue.shift()!;
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = "fi-FI";
    utt.onend = () => this._drainQueue();
    utt.onerror = () => this._drainQueue();
    window.speechSynthesis.speak(utt);
  }

  private _cancelSpeech(): void {
    this._speechQueue = [];
    this._speechBusy = false;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }

  private sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}
