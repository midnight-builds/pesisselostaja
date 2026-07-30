import { mkdirSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { setLogSink, type EventCode, type LogLevel } from "./log.js";
import type { SourceEndReason } from "./ffmpegMixer.js";

/** Machine-readable relay telemetry, written into run/ beside the state and
 *  control files the relay already keeps there.
 *
 *  The control app previously had to reconstruct what the relay was doing from
 *  journald prose plus `systemctl show` — which is why its narration list is
 *  built from the pesistulokset feed rather than from the relay, and cannot say
 *  whether a line was ever actually SPOKEN. Two files close that gap:
 *
 *  - **`status-<ID>.json`** — the current snapshot, rewritten on every poll.
 *    Whole-file and atomic (write to `.tmp`, then rename), so a reader always
 *    sees one complete snapshot: rename(2) within a directory is atomic, while
 *    a plain overwrite would let the control app read a half-written file every
 *    few seconds.
 *  - **`timeline-<ID>.ndjson`** — the append-only history: every log line with
 *    its level and code, and every narration clip through its three stages
 *    (detected → synthesized → spoken). One JSON object per line, so a reader
 *    can tail it and a truncated final line costs one record rather than the
 *    file.
 *
 *  Both are best-effort observers of a live broadcast. Every write is wrapped:
 *  a full disk or a bad path must never be able to stop narration, which is
 *  also why nothing here is awaited on the hot path. */

export interface NarrationStage {
  /** Stable id shared by all three stages of one clip. */
  id: string;
  /** The readable text, before pronunciation substitution. */
  text: string;
}

export type TimelineRecord =
  | { at: string; kind: "log"; level: LogLevel; code: EventCode | null; msg: string }
  | { at: string; kind: "detected"; id: string; text: string }
  | { at: string; kind: "synthesized"; id: string; text: string; engine: string; ms: number }
  | { at: string; kind: "spoken"; id: string; text: string; muted: boolean };

export interface RelayStatus {
  /** ISO instant this snapshot was written. */
  at: string;
  matchId: number;
  /** Commit the running deploy was built from, when known. */
  startedAt: string;
  uptimeSec: number;
  /** True while ffmpeg is attached and draining the FIFO — i.e. narration is
   *  actually reaching viewers. This is the single most useful bit here: the
   *  relay can be "running" for five minutes while nothing is being heard. */
  readerAttached: boolean;
  pendingClips: number;
  /** ffmpeg restarts so far this run. */
  respawns: number;
  source: {
    /** `no_signal` = katvekuvaa ("EI SIGNAALIA") työnnetään juuri nyt, koska
     *  lähdettä ei ole saatu kiinni kynnysaikaan mennessä (issue #104).
     *  Oma arvonsa eikä `failed`in variantti, jotta ohjaamo voi näyttää
     *  operaattorille sujuvalta näyttävän lähetyksen TAKANA olevan ongelman —
     *  `detail` kertoo yhä miksi lähde puuttuu. */
    state: "live" | "scheduled" | "resolving" | "failed" | "ended" | "unknown" | "no_signal";
    detail: string | null;
  };
  match: {
    finished: boolean;
    eventCount: number;
    lastEventAt: string | null;
  };
  narration: {
    detected: number;
    spoken: number;
    muted: number;
    /** Clips synthesized but not yet spoken. */
    queued: number;
  };
  tts: {
    engine: string;
    elevenLabsCharsUsed: number;
  };
  /** Most recent warn/error line, so a reader sees the reason without parsing
   *  the whole timeline. */
  lastProblem: { at: string; level: LogLevel; code: EventCode | null; msg: string } | null;
  /** Why the run ended, written into the final snapshot before the process
   *  exits (#123). Absent while the relay is running — and absent in every
   *  snapshot older deploys wrote, so readers must treat it as optional.
   *  (The control app mirrors RelayStatus by hand and ignores unknown keys,
   *  so adding this here is safe without touching apps/control.) */
  endReason?: SourceEndReason;
}

/** Everything the snapshot cannot observe for itself, supplied by the relay on
 *  each poll. Kept as a pull (a getter the writer calls) rather than a push, so
 *  the caller cannot forget a field and leave a stale value on the operator's
 *  phone. */
export interface StatusProbe {
  readerAttached: boolean;
  pendingClips: number;
  respawns: number;
  sourceState: RelayStatus["source"]["state"];
  sourceDetail: string | null;
  matchFinished: boolean;
  eventCount: number;
  lastEventAt: string | null;
  ttsEngine: string;
  elevenLabsCharsUsed: number;
}

export interface TelemetryOptions {
  runDir: string;
  matchId: number;
  startedAt?: Date;
  /** Test seam: fixed clock. */
  now?: () => Date;
}

export class Telemetry {
  private readonly runDir: string;
  private readonly matchId: number;
  private readonly startedAt: Date;
  private readonly now: () => Date;
  private counts = { detected: 0, synthesized: 0, spoken: 0, muted: 0 };
  private lastProblem: RelayStatus["lastProblem"] = null;
  /** Set once a write fails, so a broken path logs once instead of on every
   *  poll — a telemetry failure must not drown the log it is meant to explain. */
  private warnedAboutWrites = false;

  constructor(opts: TelemetryOptions) {
    this.runDir = opts.runDir;
    this.matchId = opts.matchId;
    this.startedAt = opts.startedAt ?? new Date();
    this.now = opts.now ?? (() => new Date());
    try {
      mkdirSync(this.runDir, { recursive: true });
    } catch {
      // Reported on the first real write attempt instead.
    }
  }

  get statusPath(): string {
    return join(this.runDir, `status-${this.matchId}.json`);
  }

  get timelinePath(): string {
    return join(this.runDir, `timeline-${this.matchId}.ndjson`);
  }

  /** Routes every log line into the timeline. Call once at startup. */
  attachToLog(): void {
    setLogSink((entry) => {
      if (entry.level === "warn" || entry.level === "error") {
        this.lastProblem = { at: entry.at, level: entry.level, code: entry.code, msg: entry.msg };
      }
      this.append({
        at: entry.at,
        kind: "log",
        level: entry.level,
        code: entry.code,
        msg: entry.msg,
      });
    });
  }

  detachFromLog(): void {
    setLogSink(null);
  }

  narrationDetected(clip: NarrationStage): void {
    this.counts.detected++;
    this.append({ at: this.now().toISOString(), kind: "detected", id: clip.id, text: clip.text });
  }

  narrationSynthesized(clip: NarrationStage, engine: string, ms: number): void {
    this.counts.synthesized++;
    this.append({
      at: this.now().toISOString(),
      kind: "synthesized",
      id: clip.id,
      text: clip.text,
      engine,
      ms,
    });
  }

  /** `muted` = the clip was produced while ffmpeg was not attached, so nobody
   *  heard it. Counting these separately is the whole point: five minutes of
   *  muted narration looks identical to five minutes of silence in the old log,
   *  and that is exactly what happened in match 145889 on 29.7.2026. */
  narrationSpoken(clip: NarrationStage, muted: boolean): void {
    if (muted) this.counts.muted++;
    else this.counts.spoken++;
    this.append({
      at: this.now().toISOString(),
      kind: "spoken",
      id: clip.id,
      text: clip.text,
      muted,
    });
  }

  /** Rewrites status-<ID>.json. Safe to call on every poll. */
  writeStatus(probe: StatusProbe): void {
    const at = this.now();
    const status: RelayStatus = {
      at: at.toISOString(),
      matchId: this.matchId,
      startedAt: this.startedAt.toISOString(),
      uptimeSec: Math.max(0, Math.round((at.getTime() - this.startedAt.getTime()) / 1000)),
      readerAttached: probe.readerAttached,
      pendingClips: probe.pendingClips,
      respawns: probe.respawns,
      source: { state: probe.sourceState, detail: probe.sourceDetail },
      match: {
        finished: probe.matchFinished,
        eventCount: probe.eventCount,
        lastEventAt: probe.lastEventAt,
      },
      narration: {
        detected: this.counts.detected,
        spoken: this.counts.spoken,
        muted: this.counts.muted,
        queued: Math.max(0, this.counts.synthesized - this.counts.spoken - this.counts.muted),
      },
      tts: { engine: probe.ttsEngine, elevenLabsCharsUsed: probe.elevenLabsCharsUsed },
      lastProblem: this.lastProblem,
    };
    this.writeAtomic(this.statusPath, JSON.stringify(status, null, 2) + "\n");
  }

  private append(record: TimelineRecord): void {
    try {
      appendFileSync(this.timelinePath, JSON.stringify(record) + "\n");
    } catch (err) {
      this.noteWriteFailure(err);
    }
  }

  /** Write-then-rename. A reader polling this file every second would
   *  otherwise catch a partial JSON document regularly enough to matter. */
  private writeAtomic(path: string, contents: string): void {
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, contents);
      renameSync(tmp, path);
    } catch (err) {
      this.noteWriteFailure(err);
    }
  }

  private noteWriteFailure(err: unknown): void {
    if (this.warnedAboutWrites) return;
    this.warnedAboutWrites = true;
    // Deliberately console.error, not logWarn: routing this back through the
    // logger would re-enter the sink that just failed.
    console.error(
      `[telemetria] kirjoitus epäonnistui, telemetria pois käytöstä tältä ajolta: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}
