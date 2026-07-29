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

interface JournalRecord {
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

/** VÄLIAIKAINEN HEURISTIIKKA — poistetaan vaiheessa B.
 *
 *  The relay currently logs everything at stdout/PRIORITY=6, so syslog priority
 *  tells us almost nothing and the only signal left is the Finnish prose. That
 *  is a losing game: the wording changes whenever someone edits a log call, and
 *  a missed "error" here means the operator's phone shows green while the
 *  broadcast is down.
 *
 *  Phase B gives every one of the ~90 log call sites a stable event code
 *  (`ffmpeg.respawn`, `source.not_live`, …) plus a real level. When that lands,
 *  `code` stops being null and this pattern matching is deleted rather than
 *  extended. Until then the rules are deliberately CAUTIOUS: they only fire on
 *  words that cannot plausibly appear in a healthy line, because a false "error"
 *  on the field costs more attention than a missed one. */
function inferLevel(text: string, priority: number | null): Level {
  // A real syslog priority, if one ever shows up, beats any guess from prose.
  if (priority !== null) {
    if (priority <= 3) return "error";
    if (priority === 4) return "warn";
    if (priority >= 7) return "debug";
  }
  if (/virhe|epäonnistui|kaatui|✗/i.test(text)) return "error";
  if (/varoitus|⚠|luovuttaa/i.test(text)) return "warn";
  return "info";
}

/** "[16.40.44] teksti" → "teksti". The separator is a dot under fi-FI
 *  (toLocaleTimeString("fi-FI")) but colons show up in older lines and in
 *  anything logged by another tool, so both are accepted. The bracket group
 *  must look like a clock — a line that merely starts with "[" keeps its text. */
const TIME_PREFIX = /^\[\d{1,2}[.:]\d{2}[.:]\d{2}\]\s*/;

function stripTimePrefix(text: string): string {
  return text.replace(TIME_PREFIX, "");
}

function toLogLine(record: JournalRecord): LogLine | null {
  const msg = stripTimePrefix(decodeMessage(record.MESSAGE).trimEnd());
  if (!msg) return null;
  const usec = Number(record.__REALTIME_TIMESTAMP);
  const ts = Number.isFinite(usec) ? new Date(usec / 1000).toISOString() : new Date().toISOString();
  const priorityRaw = Number(record.PRIORITY);
  return {
    ts,
    level: inferLevel(msg, Number.isFinite(priorityRaw) ? priorityRaw : null),
    // Null until phase B — see inferLevel. The client must not key any logic on
    // codes yet.
    code: null,
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
