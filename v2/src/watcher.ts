import { fetchMatchMetadata, fetchLiveEvents, type ApiOptions } from "@pesisselostaja/core";
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
  periodName,
  type SpeechContext,
} from "./speech.js";
import { applyPronunciations, preventOrdinalReading, type PronunciationRule } from "./pronunciation.js";
import { piperSynthesize } from "./piper.js";
import { debugLog } from "./debuglog.js";
import {
  loadState,
  saveState,
  getPeriodScore,
  addRun,
  periodsWon,
  periodsPlayed,
  type WatcherState,
} from "./state.js";
import type { LiveEvent, MatchMetadata, SubEvent } from "@pesisselostaja/core";

const SUMMARY_INTERVAL_MS = 5 * 60 * 1000;
const SUMMARY_EVERY_N = 10;

// Speaker mode: loudness-maximize a decoded buffer in place with a tanh soft
// clip. A plain GainNode+DynamicsCompressor chain barely changes perceived
// loudness (TTS output already peaks near full scale, and the compressor's
// auto makeup gain cancels most of the boost); shaping the samples directly
// gives a verified ~+7 dB RMS with peaks held at full scale.
const BOOST_DRIVE = 4;
function boostBuffer(buf: AudioBuffer): void {
  const norm = Math.tanh(BOOST_DRIVE);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) d[i] = Math.tanh(d[i] * BOOST_DRIVE) / norm;
  }
}

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
  private _selectedVoice: SpeechSynthesisVoice | null = null;
  private _voiceEngine: "browser" | "piper" = "browser";
  private _piperVoiceId = "fi_FI-harri-medium";
  private _volumeBoost = false;
  private _piperFailed = false;            // sticky fallback to browser this session
  private _currentAudio: HTMLAudioElement | null = null;
  private _currentSource: AudioBufferSourceNode | null = null;
  private _audioCtx: AudioContext | null = null;
  private _drainToken = 0;                 // generation counter; bump to abort in-flight work
  private _lastSummaryCount = 0;           // announcementCount at the last periodic summary
  private _matchEndSeen = false;           // true after first poll that contains "Ottelu päättyi"

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

  setVoice(voice: SpeechSynthesisVoice | null): void {
    this._selectedVoice = voice;
  }

  setVoiceEngine(engine: "browser" | "piper"): void {
    this._voiceEngine = engine;
  }

  setPiperVoice(voiceId: string): void {
    if (voiceId !== this._piperVoiceId) this._piperFailed = false;
    this._piperVoiceId = voiceId;
  }

  /** Speaker mode: boost Piper playback above unity gain (with a limiter). */
  setVolumeBoost(on: boolean): void {
    this._volumeBoost = on;
  }

  /** Share the AudioContext unlocked on the user gesture, for Piper playback. */
  setAudioContext(ctx: AudioContext | null): void {
    this._audioCtx = ctx;
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

  /**
   * Recover audio after the page returns to the foreground. iOS Safari pauses
   * speechSynthesis and suspends the AudioContext while the tab is hidden; when
   * we come back, both new and already-queued utterances stay silent until we
   * explicitly resume them. Called from the visibilitychange handler.
   */
  resumeAudio(): void {
    if (this._muted) return;
    const speechPaused = "speechSynthesis" in window ? window.speechSynthesis.paused : undefined;
    debugLog("resume-audio", {
      speechPaused,
      audioCtxState: this._audioCtx?.state ?? null,
      queueLen: this._speechQueue.length,
      speechBusy: this._speechBusy,
    });
    // resume() is a no-op when not paused, so call it unconditionally.
    if ("speechSynthesis" in window) window.speechSynthesis.resume();
    if (this._audioCtx && this._audioCtx.state === "suspended") void this._audioCtx.resume();
    // If the queue wedged while hidden (items waiting but the drain loop is not
    // running), re-kick it so pending speech plays.
    if (!this._speechBusy && this._speechQueue.length > 0) void this._drainQueue();
  }

  start(matchInput: string): void {
    if (this._running) return;
    const matchId = this.parseMatchInput(matchInput);
    this._abort = new AbortController();
    this._running = true;
    this._lastSpeech = null;
    this._matchEndSeen = false;
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
    state.paloTurnKey = null;
    state.paloTurnMax = 0;
    state.currentPeriod = 0;
    state.currentBatTeamId = null;
    state.finished = false;
    this.processEventsSilent(initial.events, state, meta);

    if (initial.team != null) state.currentBatTeamId = initial.team;
    if ((initial.period ?? 0) > state.currentPeriod) state.currentPeriod = initial.period!;
    {
      const { outs, turnKey } = recomputeCurrentOutsKeyed(initial.events);
      state.paloTurnKey = turnKey;
      state.paloTurnMax = outs;
      state.currentOuts = outs;
    }
    // The turn we're already in at watch-start is covered by the startup
    // speech itself — mark it announced so processEventsLive's turn-change
    // detector doesn't repeat it on the first live poll.
    state.announcedTurnKey = `${state.currentPeriod}:${state.currentInning}:${state.currentBatTurn}:${state.currentBatTeamId}`;

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
    // The startup message already gives the full situation — don't let the
    // periodic summary fire immediately on top of it.
    state.lastSummaryTime = Date.now();
    this._lastSummaryCount = state.announcementCount;

    this.log("Seuranta käynnissä…");

    while (!signal.aborted) {
      const pollStartedAt = Date.now();
      await this.sleepAbortable(this.config.pollInterval * 1000, signal);
      if (signal.aborted) break;
      try {
        const fetchStartedAt = Date.now();
        const data = await fetchLiveEvents(matchId, apiOpts);
        debugLog("poll", {
          matchId,
          events: data.events.length,
          period: data.period,
          team: data.team,
          sinceLastPollMs: fetchStartedAt - pollStartedAt,
          fetchMs: Date.now() - fetchStartedAt,
          visibility: typeof document !== "undefined" ? document.visibilityState : undefined,
        });

        // Ordinary bat-turn changes (no dedicated API text marker) are
        // detected and announced inside processEventsLive, keyed off
        // seenFingerprints — see the comment there for why this can't be
        // done from the raw poll response.
        this.processEventsLive(data.events, state, meta, lookup);

        // Outs for the current turn, kept monotonic per turn. Outs never decrease
        // while the same team bats, but the API briefly re-keys a turn-ending palo
        // into the next sub-inning for a few polls; the raw recompute then under-counts
        // the current turn and visibly rewinds the scoreboard (e.g. 3 → 2) after the
        // 3rd palo was already announced. Keying the running max to the counted turn
        // resets cleanly on a real turn change (new key) but never drops mid-turn.
        // (A plain Math.max on currentOuts is not enough: processEventsLive zeroes
        // currentOuts whenever it iterates past a re-keyed event, losing the memory.)
        if (data.events.length > 0) {
          const { outs, turnKey } = recomputeCurrentOutsKeyed(data.events);
          if (turnKey !== state.paloTurnKey) {
            state.paloTurnKey = turnKey;
            state.paloTurnMax = 0;
          }
          state.paloTurnMax = Math.max(state.paloTurnMax, outs);
          state.currentOuts = state.paloTurnMax;
        }

        // Reconcile with the API's authoritative fields BEFORE emitting state.
        // After a turn-ending out (e.g. the 3rd palo in a 3-out turn) the API
        // reports the new batting team / period before any explicit bat-change
        // event arrives. Doing this here means the scoreboard shows the team now
        // batting, and the periodic summary below never names the team whose turn
        // just ended. Period only advances — the response-level period can lag
        // behind individual event periods, so never let it go backward.
        if ((data.period ?? 0) > state.currentPeriod) state.currentPeriod = data.period!;
        if (data.team != null && data.team !== state.currentBatTeamId) {
          state.currentBatTeamId = data.team;
          state.currentOuts = 0;
          state.paloTurnKey = null;
          state.paloTurnMax = 0;
        }

        this.emitState(state, meta);
        saveState(matchId, state);

        // Summary is generated here, after reconciliation, so its "Sisävuorossa"
        // always reflects the team actually batting now.
        this.maybeAnnounceSummary(state, meta);

        if (state.finished) {
          if (this._matchEndSeen) {
            // Second poll since "Ottelu päättyi" — all trailing events should now
            // be in the API (the first extra poll gave them time to appear).
            this._running = false;
            this.callbacks.onFinished();
            return;
          }
          // First poll containing "Ottelu päättyi": do one more poll to catch
          // events the API retrospectively inserts after the match-end marker.
          this._matchEndSeen = true;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`Hakuvirhe: ${msg}`);
        debugLog("poll-error", { matchId, error: msg });
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
    for (let ei = 0; ei < events.length; ei++) {
      const event = events[ei];
      const prevBatTeamId = state.currentBatTeamId;
      const turnChanged = event.team != null && (event.team !== state.currentBatTeamId || event.inning !== state.currentInning || event.batTurn !== state.currentBatTurn);
      // The very first turn of a period (inning 0, aloittava) is announced by
      // the "X jakso alkoi" / "Ottelu alkoi" text handling in subEventToSpeech
      // instead — skip it here to avoid saying it twice.
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

      // Ordinary mid-period bat-turn changes have no dedicated API text
      // marker (unlike period boundaries), so they have to be inferred from
      // the team/inning/batTurn fields. Those fields flip on *every* event
      // belonging to the new turn, and processEventsLive replays the full
      // match history on every poll — so gate the announcement on this being
      // a genuinely new event (not yet in seenFingerprints) and on the turn
      // not having been announced yet (announcedTurnKey), or this would fire
      // once per poll for every historical turn change.
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
        this.say(msg, state);
        this.emitFeed("period", msg);
        state.announcedTurnKey = turnKey;
      }

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

        // Build context per sub-event. For an out, the spoken ordinal must come
        // from the turn-key recompute (same source as the scoreboard), not the
        // running state.currentOuts which can drift across polls.
        const ctx = this.buildContext(state);
        if (isOutSubEvent(sub) && event.team !== null) {
          ctx.currentOuts = outsThroughSubEvent(events, ei, i);
          const team = event.team === meta.home.id ? meta.home.shorthand : meta.away.shorthand;
          this.log(`Palo: ${team} ${ctx.currentOuts}`);
        }

        const speech = subEventToSpeech(
          event, sub, meta, lookup, this.config.announceBatterChanges, ctx
        );
        if (!speech) continue;

        this.say(speech, state);
        this.emitFeed(this.classifyFeed(sub, speech), speech);
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
      periodsPlayed: periodsPlayed(state),
      currentOuts: state.currentOuts,
      currentPeriod: state.currentPeriod,
      currentBatTeamId: state.currentBatTeamId,
      currentInning: state.currentInning,
      currentBatTurn: state.currentBatTurn,
    };
  }

  /** Speak/feed the periodic situation summary when one is due. */
  private maybeAnnounceSummary(state: WatcherState, meta: MatchMetadata): void {
    if (state.announcementCount === 0) return;
    const now = Date.now();
    const due =
      state.announcementCount - this._lastSummaryCount >= SUMMARY_EVERY_N ||
      now - state.lastSummaryTime > SUMMARY_INTERVAL_MS;
    if (!due) return;
    this._lastSummaryCount = state.announcementCount;
    state.lastSummaryTime = now;
    const summary = formatSituationSummary(meta, this.buildContext(state));
    this.emitFeed("summary", summary);
    if (!this._muted) this.speakRaw(applyPronunciations(summary, this._pronunciations));
  }

  private say(speech: string, state: WatcherState): void {
    if (speech === this._lastSpeech) return;
    this._lastSpeech = speech;
    this.log(`Puhe: ${speech}`);
    debugLog("say", { text: speech, muted: this._muted, queueLen: this._speechQueue.length });
    this.speakRaw(applyPronunciations(speech, this._pronunciations));
    state.announcementCount++;
  }

  private speakRaw(text: string): void {
    if (this._muted) return;
    this._speechQueue.push(preventOrdinalReading(text));
    if (!this._speechBusy) void this._drainQueue();
  }

  /** Serial async loop: synthesize + play each item to completion before the next. */
  private async _drainQueue(): Promise<void> {
    this._speechBusy = true;
    const token = ++this._drainToken;
    while (this._speechQueue.length > 0) {
      if (this._muted || token !== this._drainToken) break;   // cancelled
      const text = this._speechQueue.shift()!;
      try {
        if (this._voiceEngine === "piper" && !this._piperFailed) {
          await this._withWatchdog(text, () => this._speakPiper(text, token));
        } else {
          await this._withWatchdog(text, () => this._speakBrowser(text));
        }
      } catch {
        // Piper threw: switch to the browser voice for the rest of the session
        // and re-speak this item so nothing is lost.
        if (this._voiceEngine === "piper" && !this._piperFailed) {
          this._piperFailed = true;
          this.log("Edistynyt ääni epäonnistui, vaihdetaan selaimen ääneen.");
          if (token === this._drainToken && !this._muted) {
            try { await this._withWatchdog(text, () => this._speakBrowser(text)); } catch { /* give up on this item */ }
          }
        }
      }
    }
    if (token === this._drainToken) this._speechBusy = false;
  }

  // Mobile browsers sometimes silently drop the onend/onerror callback (or an
  // AudioContext/HTMLAudioElement completion event) when the tab is backgrounded
  // mid-utterance — that permanently wedges the queue with _speechBusy stuck
  // true, even after the page returns to the foreground. Race every speak
  // attempt against a generous, length-based timeout so the queue can always
  // recover instead of going silent forever.
  private _withWatchdog(text: string, fn: () => Promise<void>): Promise<void> {
    const timeoutMs = Math.max(8000, text.length * 150);
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        this.log("Puhe jumissa — pakotetaan jono jatkumaan.");
        debugLog("speech-watchdog-timeout", { text, timeoutMs });
        this._forceStopStuckPlayback();
        resolve();
      }, timeoutMs);
      fn().then(
        () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); },
        (err: unknown) => { if (settled) return; settled = true; clearTimeout(timer); reject(err); }
      );
    });
  }

  private _speakBrowser(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!("speechSynthesis" in window)) { reject(new Error("no speechSynthesis")); return; }
      const startedAt = Date.now();
      debugLog("speak-browser-start", { text });
      const utt = new SpeechSynthesisUtterance(text);
      utt.lang = "fi-FI";
      if (this._selectedVoice) utt.voice = this._selectedVoice;
      utt.onend = () => { debugLog("speak-browser-end", { text, ms: Date.now() - startedAt }); resolve(); };
      utt.onerror = (e) => { debugLog("speak-browser-error", { text, error: e.error }); resolve(); };   // resolve (don't trip the piper fallback)
      window.speechSynthesis.speak(utt);
    });
  }

  private async _speakPiper(text: string, token: number): Promise<void> {
    const startedAt = Date.now();
    debugLog("speak-piper-start", { text });
    const blob = await piperSynthesize(text, this._piperVoiceId);
    if (this._muted || token !== this._drainToken) return;   // cancelled during synth
    await this._playBlob(blob);
    debugLog("speak-piper-end", { text, ms: Date.now() - startedAt });
  }

  private async _playBlob(blob: Blob): Promise<void> {
    // Prefer the AudioContext unlocked on the user gesture — more reliable than a
    // detached <audio> element under autoplay policies (esp. iOS Safari).
    const ctx = this._audioCtx;
    if (ctx) {
      try {
        if (ctx.state === "suspended") {
          debugLog("audiocontext-resume", { stateBefore: ctx.state });
          await ctx.resume();
          debugLog("audiocontext-resume-done", { stateAfter: ctx.state });
        }
        const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
        if (this._volumeBoost) boostBuffer(buf);
        await new Promise<void>((resolve) => {
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(ctx.destination);
          this._currentSource = src;
          src.onended = () => { if (this._currentSource === src) this._currentSource = null; resolve(); };
          src.start(0);
        });
        return;
      } catch (err) {
        debugLog("playblob-audiocontext-error", { error: err instanceof Error ? err.message : String(err) });
        // fall through to the <audio> path below
      }
    }
    await new Promise<void>((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this._currentAudio = audio;
      const done = () => {
        URL.revokeObjectURL(url);
        if (this._currentAudio === audio) this._currentAudio = null;
        resolve();
      };
      audio.onended = done;
      audio.onerror = done;
      void audio.play().catch(done);   // autoplay block → continue the queue
    });
  }

  private _forceStopStuckPlayback(): void {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    if (this._currentAudio) {
      this._currentAudio.pause();
      this._currentAudio.src = "";
      this._currentAudio = null;
    }
    if (this._currentSource) {
      try { this._currentSource.stop(); } catch { /* already stopped */ }
      this._currentSource = null;
    }
  }

  private _cancelSpeech(): void {
    this._speechQueue = [];
    this._speechBusy = false;
    this._drainToken++;   // invalidate any in-flight drain/synth so late audio is dropped
    this._forceStopStuckPlayback();
  }

  private sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}
