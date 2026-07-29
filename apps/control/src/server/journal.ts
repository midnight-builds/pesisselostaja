/** The relay's log, read back out of journald.
 *
 *  The relay logs to stdout via apps/broadcast/src/log.ts, which prefixes every
 *  line with a Finnish local time ("[16.40.44] Sammutetaan…"). systemd captures
 *  that verbatim, so journald gives us both a trustworthy timestamp
 *  (__REALTIME_TIMESTAMP) and a redundant, timezone-ambiguous one inside the
 *  text. We keep the first and strip the second. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LogLine } from "../shared/types.js";

const run = promisify(execFile);

const RELAY_UNIT = "pesisselostaja-relay";

/** journald can hand back a lot; the phone renders a scrollback, not an
 *  archive. */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
/** When a level filter is on we have to read a wider window than the caller
 *  asked for, otherwise "the last 50 warnings" would really mean "the warnings
 *  among the last 50 lines" — usually none, on a chatty relay. */
const FILTER_SCAN_LINES = 2000;

type Level = LogLine["level"];

const LEVEL_RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface JournalRecord {
  MESSAGE?: string | number[];
  PRIORITY?: string;
  __REALTIME_TIMESTAMP?: string;
}

/** journald emits MESSAGE as an array of bytes when the line isn't valid UTF-8.
 *  Rare, but a crash here would blank the whole log view. */
function decodeMessage(message: string | number[] | undefined): string {
  if (typeof message === "string") return message;
  if (Array.isArray(message)) return Buffer.from(message).toString("utf8");
  return "";
}

/** The relay now emits a real syslog priority (systemd reads a leading `<N>`
 *  on stdout) and a stable event code, so a line's severity is read, not
 *  guessed.
 *
 *  The prose matching below is what is LEFT of the old heuristic, and it is
 *  deliberately not deleted outright: journald still holds lines from relay
 *  builds that predate the change, and a broadcast can be running one of them
 *  right now — `~/relay-deploy` only moves when someone runs `relay:deploy`.
 *  Deleting it today would quietly re-label every historical error as info,
 *  which is the exact failure it was written to prevent.
 *
 *  It applies ONLY to lines that carry no event code, i.e. only to those older
 *  builds. Once no relay without codes can still be deployed, this function
 *  collapses to the priority mapping and the regexes go. */
function inferLevel(text: string, priority: number | null, code: string | null): Level {
  if (priority !== null) {
    if (priority <= 3) return "error";
    if (priority === 4) return "warn";
    if (priority >= 7) return "debug";
    // PRIORITY 5/6 from a coded line is the relay saying "info", and it means it.
    if (code) return "info";
  }
  if (/virhe|epäonnistui|kaatui|✗/i.test(text)) return "error";
  if (/varoitus|⚠|luovuttaa/i.test(text)) return "warn";
  return "info";
}

/** "ffmpeg.respawn: teksti" → code + text. Codes are `subsystem.event`, lower
 *  case with dots and underscores, so the pattern cannot swallow ordinary
 *  Finnish prose that happens to contain a colon ("Pisteet (1. jakso): 3-1"). */
const CODE_PREFIX = /^([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+):\s+/;

function splitCode(text: string): { code: string | null; msg: string } {
  const m = CODE_PREFIX.exec(text);
  if (!m) return { code: null, msg: text };
  return { code: m[1], msg: text.slice(m[0].length) };
}

/** "[16.40.44] teksti" → "teksti". The separator is a dot under fi-FI
 *  (toLocaleTimeString("fi-FI")) but colons show up in older lines and in
 *  anything logged by another tool, so both are accepted. The bracket group
 *  must look like a clock — a line that merely starts with "[" keeps its text. */
const TIME_PREFIX = /^\[\d{1,2}[.:]\d{2}[.:]\d{2}\]\s*/;

function stripTimePrefix(text: string): string {
  return text.replace(TIME_PREFIX, "");
}

/** Exported for tests: one journald record → one log line. This is the whole
 *  contract between the relay's stdout and the operator's log view, so it is
 *  worth pinning directly rather than only through readLog's journalctl shell-out. */
export function toLogLine(record: JournalRecord): LogLine | null {
  const text = stripTimePrefix(decodeMessage(record.MESSAGE).trimEnd());
  if (!text) return null;
  const { code, msg } = splitCode(text);
  if (!msg) return null;
  const usec = Number(record.__REALTIME_TIMESTAMP);
  const ts = Number.isFinite(usec) ? new Date(usec / 1000).toISOString() : new Date().toISOString();
  const priorityRaw = Number(record.PRIORITY);
  return {
    ts,
    level: inferLevel(msg, Number.isFinite(priorityRaw) ? priorityRaw : null, code),
    code,
    msg,
  };
}

function parseLevel(raw: string | undefined): Level | null {
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : null;
}

/** Newest journald entries for the relay unit, oldest-first (the order they
 *  scroll in).
 *
 *  `level` is a MINIMUM severity, not an exact match: asking for "warn" gets
 *  warnings and errors, which is what an operator scanning for trouble means. */
export async function readLog(opts: { limit?: number; level?: string } = {}): Promise<LogLine[]> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.round(opts.limit ?? DEFAULT_LIMIT)));
  const minLevel = parseLevel(opts.level);
  const scan = minLevel ? Math.max(limit, FILTER_SCAN_LINES) : limit;

  let stdout: string;
  try {
    ({ stdout } = await run(
      "journalctl",
      ["--user", "-u", RELAY_UNIT, "-o", "json", "-n", String(scan), "--no-pager"],
      // A long window of relay logs comfortably exceeds execFile's 1 MB default,
      // and the failure mode there is a truncated-output error — i.e. no log at
      // all exactly when the log matters most.
      { maxBuffer: 32 * 1024 * 1024 }
    ));
  } catch {
    // Unit never ran, journald unavailable, no permission: an empty log is a
    // survivable view, a thrown request is not.
    return [];
  }

  const lines: LogLine[] = [];
  for (const raw of stdout.split("\n")) {
    if (!raw.trim()) continue;
    let record: JournalRecord;
    try {
      record = JSON.parse(raw) as JournalRecord;
    } catch {
      continue; // one malformed record must not drop the rest
    }
    const line = toLogLine(record);
    if (!line) continue;
    if (minLevel && LEVEL_RANK[line.level] < LEVEL_RANK[minLevel]) continue;
    lines.push(line);
  }
  // journalctl already returns oldest-first; slicing from the end keeps the
  // NEWEST `limit` lines after filtering.
  return lines.slice(-limit);
}
