/** Relay logging: one human line on stdout, one machine record to telemetry.
 *
 *  Until now every line went out at the same stdout priority with nothing but
 *  Finnish prose to distinguish "ffmpeg respawned" from "poll 412 returned 3
 *  events". The control app had to guess the level by matching words like
 *  "virhe", which its own header calls a losing game: the wording changes
 *  whenever someone edits a log call, and a missed error shows the operator a
 *  green phone while the broadcast is down.
 *
 *  Two channels now carry that meaning explicitly:
 *
 *  1. **Syslog priority on stdout.** systemd reads a leading `<N>` on a
 *     service's stdout and records it as journald PRIORITY (SyslogLevelPrefix,
 *     on by default). So `journalctl -p warning` works, and the control app
 *     reads a real priority instead of inferring one. The prefix is emitted
 *     ONLY under systemd — detected via JOURNAL_STREAM, which systemd sets —
 *     so `relay:dev` in a terminal still prints clean lines.
 *  2. **A stable event code** (`ffmpeg.respawn`, `source.not_live`, …) that
 *     survives rewording, prefixed to the message so it is readable in
 *     journalctl and trivially parseable by the log view.
 *
 *  `log()` without a code still works and still means info. It is kept for the
 *  handful of one-off lines where a code would be noise, not for new code. */

import { fstatSync } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Stable machine identifiers for log lines. Adding one here is deliberate:
 *  the control app's log view and its notification rules key off these, so a
 *  code is part of the contract in the same way a route is. Grouped by the
 *  subsystem that owns the line. */
export type EventCode =
  // relay lifecycle
  | "relay.start"
  | "relay.config"
  | "relay.shutdown"
  | "relay.dry_run"
  | "relay.tts_usage"
  | "relay.source_gone"
  // Lähde päätettiin hallitusti — ei vika (#103).
  | "relay.source_ended"
  // yt-dlp source resolution
  | "source.resolving"
  | "source.not_live"
  | "source.progressive_fallback"
  // ffmpeg supervisor
  | "ffmpeg.starting"
  | "ffmpeg.exit"
  | "ffmpeg.respawn"
  | "ffmpeg.start_failed"
  | "ffmpeg.unproductive"
  | "ffmpeg.failure_side"
  | "ffmpeg.heartbeat"
  | "ffmpeg.supervisor_failed"
  // pesistulokset API / poll loop
  | "api.fetching_meta"
  | "api.match"
  | "api.skip_history"
  | "api.skipped"
  | "api.match_finished"
  | "api.loop_start"
  | "api.fetch_failed"
  | "api.fetch_recovered"
  | "api.delta_reset"
  | "api.delta_inconsistent"
  | "api.delta_fetch"
  | "api.first_seen"
  // match events worth seeing in the log
  | "match.score"
  | "match.palo"
  | "match.event"
  | "match.score_after_finish"
  // narration
  | "speech.spoken"
  | "speech.muted"
  | "speech.failed"
  | "speech.resumed"
  | "speech.dry_run"
  // synthesis
  | "tts.elevenlabs"
  | "tts.elevenlabs_failed"
  | "tts.piper_failed"
  | "tts.cache_write_failed"
  // live control file
  | "control.write_failed"
  | "control.batter_changes"
  | "control.narration_delay"
  | "control.delta_fetch"
  | "control.poll_interval"
  // narration FIFO
  | "fifo.write_failed"
  | "fifo.tick_failed";

const PRIORITY: Record<LogLevel, number> = {
  debug: 7,
  info: 6,
  warn: 4,
  error: 3,
};

/** Whether OUR stdout is the journald stream, which decides whether the `<N>`
 *  prefix gets interpreted or just litters an operator's terminal.
 *
 *  Presence of JOURNAL_STREAM alone is not enough, and assuming it was is a
 *  real bug: the variable is inherited by every child process, so a relay
 *  started by hand from a shell that itself runs under a systemd unit would
 *  print `<6>` on every line. systemd documents the variable as
 *  `device:inode` OF the stream it handed over, precisely so a process can
 *  check identity rather than presence — so compare it against fstat of fd 1.
 *
 *  Computed once: fd 1 does not change under us, and this runs on every
 *  single log line. */
function detectJournald(): boolean {
  const raw = process.env.JOURNAL_STREAM;
  if (!raw) return false;
  const [dev, ino] = raw.split(":");
  try {
    const st = fstatSync(1);
    return String(st.dev) === dev && String(st.ino) === ino;
  } catch {
    return false;
  }
}

let journaldCache: boolean | null = null;

function underJournald(): boolean {
  if (journaldCache === null) journaldCache = detectJournald();
  return journaldCache;
}

/** Tests only: forget the cached stdout check after changing JOURNAL_STREAM. */
export function resetJournaldDetection(): void {
  journaldCache = null;
}

/** Receives every line as structured data. Set by telemetry.ts at startup;
 *  registered rather than imported so log.ts stays dependency-free and the two
 *  modules cannot form a cycle. A throwing sink must never take the broadcast
 *  down, so emit() swallows its errors. */
export type LogSink = (entry: {
  at: string;
  level: LogLevel;
  code: EventCode | null;
  msg: string;
}) => void;

let sink: LogSink | null = null;

export function setLogSink(next: LogSink | null): void {
  sink = next;
}

/** Exported for tests: builds the exact stdout line, without writing it. */
export function formatLine(level: LogLevel, code: EventCode | null, msg: string, ts: string): string {
  const prefix = underJournald() ? `<${PRIORITY[level]}>` : "";
  const tag = code ? `${code}: ` : "";
  return `${prefix}[${ts}] ${tag}${msg}`;
}

function emit(level: LogLevel, code: EventCode | null, msg: string): void {
  const now = new Date();
  console.log(formatLine(level, code, msg, now.toLocaleTimeString("fi-FI")));
  try {
    sink?.({ at: now.toISOString(), level, code, msg });
  } catch {
    // Telemetry is an observer. It never gets a vote on whether the relay runs.
  }
}

/** Uncoded info line. */
export function log(msg: string): void {
  emit("info", null, msg);
}

export const logInfo = (code: EventCode, msg: string): void => emit("info", code, msg);
export const logWarn = (code: EventCode, msg: string): void => emit("warn", code, msg);
export const logError = (code: EventCode, msg: string): void => emit("error", code, msg);
export const logDebug = (code: EventCode, msg: string): void => emit("debug", code, msg);
