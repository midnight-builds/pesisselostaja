import { fetchMatchMetadata, fetchLiveEvents } from "./api.js";
import {
  buildPlayerLookup,
  subEventToSpeech,
  isRunScoringSubEvent,
  isOutSubEvent,
  isMatchEndSubEvent,
  runValueOfSubEvent,
  eventFingerprint,
  isEventFullyProcessed,
  formatStartupSpeech,
  formatBatTurnChangeSpeech,
  formatSituationSummary,
  periodName,
  type SpeechContext,
} from "./speech.js";
import { speak, waitForIdle, type HaConfig } from "./ha.js";
import {
  loadPronunciations,
  savePronunciations,
  applyPronunciations,
  preventOrdinalReading,
  type PronunciationRule,
} from "./pronunciation.js";
import {
  loadState,
  saveState,
  getPeriodScore,
  addRun,
  periodsWon,
  periodsPlayed,
  type WatcherState,
} from "./state.js";
import type { LiveEvent, MatchMetadata } from "./types.js";

const SUMMARY_INTERVAL_MS = 5 * 60 * 1000;
const SUMMARY_EVERY_N = 10;

export interface WatcherStatus {
  running: boolean;
  matchId: number | null;
  matchInfo: string | null;
  seriesName: string | null;
  stadiumName: string | null;
  log: string[];
  error: string | null;
  dryRun: boolean;
  speechMode: 'ha' | 'browser';
}

export interface StartOptions {
  speechMode?: 'ha' | 'browser';
  onSpeech?: (text: string) => void;
}

export interface WatcherConfig {
  pollInterval: number;
  dryRun: boolean;
  announceBatterChanges: boolean;
  apiKey: string;
  apiBase: string;
  haUrl: string;
  haToken: string;
  haTtsEntity: string;
  haMediaPlayerEntity: string;
  pronunciationsFile: string;
}

export class WatcherController {
  private _running = false;
  private _matchId: number | null = null;
  private _matchInfo: string | null = null;
  private _seriesName: string | null = null;
  private _stadiumName: string | null = null;
  private _log: string[] = [];
  private _error: string | null = null;
  private _abort: AbortController | null = null;
  private _speechMode: 'ha' | 'browser' = 'ha';
  private _onSpeech: ((text: string) => void) | null = null;
  private _browserReady: Promise<void> | null = null;
  private _browserReadyResolve: (() => void) | null = null;
  private _lastSpeech: string | null = null;
  private _pronunciations: PronunciationRule[];
  readonly config: WatcherConfig;

  constructor(config: WatcherConfig) {
    this.config = config;
    this._pronunciations = loadPronunciations(config.pronunciationsFile);
  }

  getPronunciations(): PronunciationRule[] {
    return this._pronunciations;
  }

  setPronunciations(rules: PronunciationRule[]): void {
    this._pronunciations = rules;
    savePronunciations(this.config.pronunciationsFile, rules);
  }

  getStatus(): WatcherStatus {
    return {
      running: this._running,
      matchId: this._matchId,
      matchInfo: this._matchInfo,
      seriesName: this._seriesName,
      stadiumName: this._stadiumName,
      log: this._log.slice(-150),
      error: this._error,
      dryRun: this.config.dryRun,
      speechMode: this._speechMode,
    };
  }

  start(matchInput: string, opts?: StartOptions): void {
    if (this._running) throw new Error("Seuranta on jo käynnissä");
    const matchId = this.parseMatchInput(matchInput);
    this._matchId = matchId;
    this._matchInfo = null;
    this._seriesName = null;
    this._stadiumName = null;
    this._error = null;
    this._speechMode = opts?.speechMode ?? 'ha';
    this._onSpeech = opts?.onSpeech ?? null;
    this._lastSpeech = null;
    if (this._speechMode === 'browser') {
      this._browserReady = new Promise((resolve) => { this._browserReadyResolve = resolve; });
    } else {
      this._browserReady = null;
      this._browserReadyResolve = null;
    }
    this._abort = new AbortController();
    this._running = true;
    this.runWatcher(matchId, this._abort.signal).catch((err) => {
      this._error = err instanceof Error ? err.message : String(err);
      this.addLog(`Virhe: ${this._error}`);
      this._running = false;
    });
  }

  stop(): void {
    this._abort?.abort();
    this._running = false;
    this.addLog("Seuranta pysäytetty.");
  }

  clearLog(): void {
    this._log = [];
  }

  /** Browser signals that on-device audio playback has been unlocked/started. */
  markBrowserReady(): void {
    this._browserReadyResolve?.();
    this._browserReadyResolve = null;
  }

  private parseMatchInput(input: string): number {
    const trimmed = input.trim();
    const urlMatch = trimmed.match(/ottelut\/(\d+)/);
    if (urlMatch) return parseInt(urlMatch[1], 10);
    const id = parseInt(trimmed, 10);
    if (!isNaN(id) && id > 0) return id;
    throw new Error(`Ei voida tunnistaa ottelun ID:tä: "${input}"`);
  }

  private addLog(msg: string): void {
    const ts = new Date().toLocaleTimeString("fi-FI");
    const line = `[${ts}] ${msg}`;
    this._log.push(line);
    if (this._log.length > 500) this._log.shift();
    console.log(line);
  }

  private async runWatcher(matchId: number, signal: AbortSignal): Promise<void> {
    const stateFile = `.state-${matchId}.json`;

    this.addLog(`Haetaan ottelutietoja (ID: ${matchId})…`);
    const meta = await fetchMatchMetadata(matchId, {
      apiBase: this.config.apiBase,
      apiKey: this.config.apiKey,
    });
    const lookup = buildPlayerLookup(meta);

    this._matchInfo = `${meta.home.name} vs ${meta.away.name}`;
    this._seriesName = meta.series.custom_name ?? meta.series.name ?? null;
    this._stadiumName = meta.stadium.name;
    this.addLog(`${this._matchInfo}`);
    this.addLog(`Sarja: ${this._seriesName ?? "–"} | Kenttä: ${this._stadiumName}`);
    this.addLog(`Pelaajia: ${lookup.byId.size}`);

    const haConfig: HaConfig = {
      url: this.config.haUrl,
      token: this.config.haToken,
      ttsEntity: this.config.haTtsEntity,
      mediaPlayerEntity: this.config.haMediaPlayerEntity,
    };

    const state = loadState(stateFile);

    this.addLog("Ohitetaan historialliset tapahtumat…");
    const initial = await fetchLiveEvents(matchId, { apiBase: this.config.apiBase });
    // Recompute score and outs authoritatively from the full history so that
    // joining mid-turn yields correct counts on every restart.
    state.periodRuns = {};
    state.currentOuts = 0;
    state.currentPeriod = 0;
    state.currentBatTeamId = null;
    state.finished = false;
    await this.processEvents(initial.events, state, meta, lookup, haConfig, true);

    // Sync batting team from API context
    if (initial.team != null) state.currentBatTeamId = initial.team;
    if ((initial.period ?? 0) > 0) state.currentPeriod = initial.period!;

    saveState(stateFile, state);
    this.addLog(`Ohitettu ${initial.events.length} tapahtumaa`);

    if (!meta.live && meta.started) {
      this.addLog("Ottelu on jo päättynyt.");
      this._running = false;
      return;
    }

    // In browser mode, don't attempt the startup speech before the device has
    // started its audio (browsers block playback until a user gesture unlocks it).
    if (this._speechMode === 'browser' && this._browserReady) {
      this.addLog("Odotetaan laitteen äänen käynnistystä…");
      await Promise.race([this._browserReady, this.sleepAbortable(30000, signal)]);
      if (signal.aborted) { this._running = false; return; }
    }

    // Startup announcement
    const startupMsg = formatStartupSpeech(meta, this.buildContext(state));
    await this.say(haConfig, startupMsg, state);

    this.addLog("Seuranta käynnissä…");

    while (!signal.aborted) {
      await this.sleepAbortable(this.config.pollInterval, signal);
      if (signal.aborted) break;
      try {
        const data = await fetchLiveEvents(matchId, { apiBase: this.config.apiBase });

        // Detect batting team change between polls (when no explicit event covers it)
        const newBatTeam = data.team ?? null;
        if (
          newBatTeam != null &&
          state.currentBatTeamId != null &&
          newBatTeam !== state.currentBatTeamId &&
          data.events.length === 0
        ) {
          const cur = getPeriodScore(state, state.currentPeriod);
          const msg = formatBatTurnChangeSpeech(
            meta,
            state.currentBatTeamId,
            newBatTeam,
            cur.home,
            cur.away,
            state.variantHistory
          );
          await this.say(haConfig, msg, state);
          state.currentBatTeamId = newBatTeam;
          state.currentOuts = 0;
        }

        await this.processEvents(data.events, state, meta, lookup, haConfig);

        // Sync context from response. Palot kuuluvat vain sisävuorossa olevalle
        // joukkueelle ja nollautuvat aina kun vuoro vaihtuu.
        if (data.team != null && data.team !== state.currentBatTeamId) {
          state.currentBatTeamId = data.team;
          state.currentOuts = 0;
        }
        if ((data.period ?? 0) > state.currentPeriod) state.currentPeriod = data.period!;

        saveState(stateFile, state);
      } catch (err) {
        this.addLog(`Hakuvirhe: ${err instanceof Error ? err.message : err}`);
      }
    }

    this._running = false;
  }

  private async processEvents(
    events: LiveEvent[],
    state: WatcherState,
    meta: MatchMetadata,
    lookup: ReturnType<typeof buildPlayerLookup>,
    haConfig: HaConfig,
    silent = false
  ): Promise<void> {
    for (const event of events) {
      // Palot kuuluvat vain sisävuorossa olevalle joukkueelle ja nollautuvat aina
      // kun vuoro vaihtuu (uusi sisävuoro aloittaa nollasta). Only act on this
      // for events that are new this poll — the endpoint always returns full
      // history, so re-applying it to already-processed events on every poll
      // lets a single reordered/corrected historical entry falsely reset
      // currentOuts mid-turn (see relay/HANDOFF.md).
      if (!isEventFullyProcessed(state.seenFingerprints, event)) {
        if (event.team != null && event.team !== state.currentBatTeamId) {
          state.currentBatTeamId = event.team;
          state.currentOuts = 0;
        }
        if (event.period > 0) state.currentPeriod = event.period;
      }

      for (let i = 0; i < event.events.length; i++) {
        const sub = event.events[i];
        const fp = eventFingerprint(event, i);
        const alreadySeen = state.seenFingerprints.has(fp);
        state.seenFingerprints.add(fp);

        // Mark the match as finished so period wins count the decider.
        if (isMatchEndSubEvent(sub)) state.finished = true;

        if (silent) {
          // Authoritative recount from the full history — count every event
          // (even previously seen ones) but stay quiet: no speech, no log.
          if (isRunScoringSubEvent(sub)) {
            this.updateScore(state, event, meta, runValueOfSubEvent(sub), true);
          }
          if (isOutSubEvent(sub)) {
            this.updateOuts(state, event, meta, true);
          }
          continue;
        }

        if (alreadySeen) continue;

        // Update score and outs BEFORE generating speech so the text is current
        if (isRunScoringSubEvent(sub)) {
          this.updateScore(state, event, meta, runValueOfSubEvent(sub));
        }
        if (isOutSubEvent(sub)) {
          this.updateOuts(state, event, meta);
        }

        const ctx = this.buildContext(state);

        const speech = subEventToSpeech(
          event,
          sub,
          meta,
          lookup,
          this.config.announceBatterChanges,
          ctx
        );
        if (!speech) continue;

        await this.say(haConfig, speech, state);

        // Periodic situation summary: every N announcements or every 5 min
        const now = Date.now();
        const needsSummary =
          state.announcementCount % SUMMARY_EVERY_N === 0 ||
          now - state.lastSummaryTime > SUMMARY_INTERVAL_MS;
        if (needsSummary && state.announcementCount > 0) {
          state.lastSummaryTime = now;
          const summary = formatSituationSummary(meta, this.buildContext(state));
          await this.delay(800);
          await this.say(haConfig, summary, state, false);
        }
      }

      if (event.timestamp !== null && event.timestamp > state.lastTimestamp) {
        state.lastTimestamp = event.timestamp;
      }
    }
  }

  private buildContext(state: WatcherState): SpeechContext {
    const cur = getPeriodScore(state, state.currentPeriod);
    const won = periodsWon(state);
    return {
      periodHomeRuns: cur.home,
      periodAwayRuns: cur.away,
      homePeriodsWon: won.home,
      awayPeriodsWon: won.away,
      periodsPlayed: periodsPlayed(state),
      currentOuts: state.currentOuts,
      currentPeriod: state.currentPeriod,
      currentBatTeamId: state.currentBatTeamId,
      variantHistory: state.variantHistory,
    };
  }

  private updateScore(state: WatcherState, event: LiveEvent, meta: MatchMetadata, value: number, silent = false): void {
    if (event.team === null || value <= 0) return;
    addRun(state, event.period, event.team === meta.home.id, value);
    if (!silent) {
      const s = getPeriodScore(state, event.period);
      this.addLog(`Pisteet (${periodName(event.period)}): ${meta.home.shorthand} ${s.home}–${s.away} ${meta.away.shorthand}`);
    }
  }

  private updateOuts(state: WatcherState, event: LiveEvent, meta: MatchMetadata, silent = false): void {
    if (event.team === null) return;
    state.currentOuts++;
    if (!silent) {
      const team = event.team === meta.home.id ? meta.home.shorthand : meta.away.shorthand;
      this.addLog(`Palo: ${team} ${state.currentOuts}`);
    }
  }

  private async say(haConfig: HaConfig, speech: string, state: WatcherState, countAnnouncement = true): Promise<void> {
    if (speech === this._lastSpeech) return;
    this._lastSpeech = speech;
    // Apply pronunciation overrides to the spoken text only; the log keeps the
    // readable original.
    const spoken = preventOrdinalReading(applyPronunciations(speech, this._pronunciations));
    if (this._speechMode === 'browser') {
      this.addLog(`Puhe: ${speech}`);
      this._onSpeech?.(spoken);
    } else if (this.config.dryRun) {
      this.addLog(`[TESTI] ${speech}`);
    } else {
      this.addLog(`Puhe: ${speech}`);
      try {
        await speak(haConfig, spoken);
        await waitForIdle(haConfig);
      } catch (err) {
        this.addLog(`TTS-virhe: ${err instanceof Error ? err.message : err}`);
        await this.delay(2000);
      }
    }
    if (countAnnouncement) state.announcementCount++;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}
