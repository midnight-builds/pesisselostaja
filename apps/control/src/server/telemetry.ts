/** The relay's telemetry, read back on the control side.
 *
 *  Issue #97: for anything both processes know, the RELAY is the source of
 *  truth — it is the only one that knows what was actually said, in which
 *  wording, with which roster, and whether anyone heard it. The control app
 *  reads; it does not re-derive. This file is the whole reading half:
 *
 *  - `status-<matchId>.json` — the relay's snapshot of itself, rewritten every
 *    poll and replaced by rename(2), so a read either sees the previous
 *    snapshot or the new one, never half of either.
 *  - `timeline-<matchId>.ndjson` — the append-only history. Narration clips
 *    appear as `detected` and then `spoken` (with a `muted` flag), which is
 *    exactly the two-phase list the operator's phone renders.
 *
 *  Both files are written by whatever commit is deployed at ~/relay-deploy,
 *  which can be older than this checkout (issue #59). So nothing here trusts a
 *  field's presence or type: a missing file, a truncated final line and an
 *  unknown record kind are all normal, and none of them may take down the live
 *  view. */

import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { NarrationLine, RelayTelemetry } from "../shared/types.js";
import { CONFIG } from "./config.js";

/** Narration lines kept in memory / pushed to the client. */
const NARRATION_KEEP = 40;

export function statusPath(matchId: number): string {
  return join(CONFIG.relayRunDir, `status-${matchId}.json`);
}

export function timelinePath(matchId: number): string {
  return join(CONFIG.relayRunDir, `timeline-${matchId}.ndjson`);
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

// ------------------------------------------------------------ status-<ID>.json

type Raw = Record<string, unknown>;

function obj(value: unknown): Raw {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : {};
}

function str(value: unknown, fallback: string | null = null): string | null {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Jokainen `RelayTelemetry["source"]["state"]`-unionin arvo. `Record`-tyyppi
 *  vartioi kattavuuden molempiin suuntiin käännösaikana: unioniin lisätty tila
 *  joka puuttuu tästä kaataa käännöksen, samoin unioniin kuulumaton avain.
 *  Näin uusi lähdetila ei voi enää pudota hiljaa "unknown"iin, kuten kävi
 *  `ended`ille ja `no_signal`ille (#117). */
const SOURCE_STATE_SET: Record<RelayTelemetry["source"]["state"], true> = {
  live: true,
  scheduled: true,
  resolving: true,
  failed: true,
  ended: true,
  no_signal: true,
  reconnecting: true,
  unknown: true,
};

export const SOURCE_STATES = Object.keys(SOURCE_STATE_SET) as RelayTelemetry["source"]["state"][];

function sourceState(value: unknown): RelayTelemetry["source"]["state"] {
  return (SOURCE_STATES as readonly unknown[]).includes(value)
    ? (value as RelayTelemetry["source"]["state"])
    : "unknown";
}

/** Sama vartiointi kuin SOURCE_STATE_SETillä, `RelayTelemetry["endReason"]`ille:
 *  relayn `SourceEndReason` (apps/broadcast/src/ffmpegMixer.ts) on peilattu
 *  käsin shared/types.ts:ään, ja `Record` pitää listat samoina käännösaikana.
 *  `null` on mukana koska kenttä on nullable; se ei ole relayn arvo eikä siksi
 *  koskaan jäsenny tiedostosta. */
const END_REASON_SET: Record<NonNullable<RelayTelemetry["endReason"]>, true> = {
  ended: true,
  exhausted: true,
  hard_stop: true,
};

export const END_REASONS = Object.keys(END_REASON_SET) as NonNullable<
  RelayTelemetry["endReason"]
>[];

/** Tuntematon arvo (uudempi relay-deploy kuin tämä ohjaamo) → null, ei heittoa:
 *  lopetussyy on lisätieto, eikä sen takia saa menettää koko snapshottia. */
function endReason(value: unknown): RelayTelemetry["endReason"] {
  return (END_REASONS as readonly unknown[]).includes(value)
    ? (value as NonNullable<RelayTelemetry["endReason"]>)
    : null;
}

function level(value: unknown): "debug" | "info" | "warn" | "error" {
  return value === "debug" || value === "info" || value === "warn" || value === "error"
    ? value
    : "info";
}

/** null when the file is absent (relay never ran for this match, or runs an
 *  older build), or when it carries no usable timestamp — a snapshot we cannot
 *  date is a snapshot we cannot judge for staleness, and showing it as current
 *  would be exactly the "green while broken" lie this view exists to prevent.
 *  Anything else throws, so a corrupt file surfaces as an error rather than as
 *  silence. */
export function parseRelayStatus(text: string): RelayTelemetry | null {
  const raw = obj(JSON.parse(text) as unknown);
  const at = str(raw.at);
  if (!at || !Number.isFinite(Date.parse(at))) return null;
  const source = obj(raw.source);
  const match = obj(raw.match);
  const narration = obj(raw.narration);
  const tts = obj(raw.tts);
  const problem = raw.lastProblem == null ? null : obj(raw.lastProblem);
  const problemAt = problem ? str(problem.at) : null;
  return {
    at,
    matchId: num(raw.matchId, -1),
    startedAt: str(raw.startedAt, at) as string,
    uptimeSec: num(raw.uptimeSec),
    readerAttached: bool(raw.readerAttached),
    pendingClips: num(raw.pendingClips),
    respawns: num(raw.respawns),
    source: { state: sourceState(source.state), detail: str(source.detail) },
    endReason: endReason(raw.endReason),
    match: {
      finished: bool(match.finished),
      eventCount: num(match.eventCount),
      lastEventAt: str(match.lastEventAt),
    },
    narration: {
      detected: num(narration.detected),
      spoken: num(narration.spoken),
      muted: num(narration.muted),
      queued: num(narration.queued),
    },
    tts: { engine: str(tts.engine, "?") as string, elevenLabsCharsUsed: num(tts.elevenLabsCharsUsed) },
    lastProblem:
      problem && problemAt
        ? {
            at: problemAt,
            level: level(problem.level),
            code: str(problem.code),
            msg: str(problem.msg, "") as string,
          }
        : null,
  };
}

export async function readRelayStatus(matchId: number): Promise<RelayTelemetry | null> {
  let text: string;
  try {
    text = await readFile(statusPath(matchId), "utf8");
  } catch (err) {
    // No file = the relay has not started for this match (or runs a build from
    // before telemetry). That is a fact about the relay, not a read failure.
    if (isMissing(err)) return null;
    throw err;
  }
  return parseRelayStatus(text);
}

// -------------------------------------------------------- timeline-<ID>.ndjson

/** Incremental tail of one match's timeline.
 *
 *  Reads only the bytes appended since the last poll: a two-hour broadcast
 *  writes every log line here too, so re-reading the whole file every five
 *  seconds would grow into megabytes of pointless work exactly while the box is
 *  busiest. State kept across polls is therefore a byte offset plus a decoder,
 *  which also makes multi-byte characters split across a read boundary a
 *  non-issue (Finnish narration is full of them). */
export class NarrationTimeline {
  private readonly path: string;
  private readonly keep: number;
  private offset = 0;
  private decoder = new StringDecoder("utf8");
  private partial = "";
  /** Running number of narration records seen, prefixed onto each line's id:
   *  the relay's own `c1`, `c2`, … restart from scratch when the relay is
   *  restarted mid-match, and the file is appended to, not replaced. */
  private seq = 0;
  /** The clip id is kept beside each line rather than inside it: it is relay
   *  bookkeeping, not something the phone renders. */
  private retained: Array<{ clipId: string; line: NarrationLine }> = [];
  /** Relay clip id -> the line object it produced, so a `spoken` record can
   *  complete the `detected` one instead of appearing as a second row. */
  private byClipId = new Map<string, NarrationLine>();

  constructor(matchId: number, opts: { path?: string; keep?: number } = {}) {
    this.path = opts.path ?? timelinePath(matchId);
    this.keep = opts.keep ?? NARRATION_KEEP;
  }

  /** Oldest first — the order the relay decided them, which is the only
   *  ordering that survives several clips landing in the same second (#98). */
  lines(): NarrationLine[] {
    return this.retained.map((entry) => ({ ...entry.line }));
  }

  async poll(): Promise<void> {
    let size: number;
    try {
      ({ size } = await stat(this.path));
    } catch (err) {
      if (isMissing(err)) return; // relay hasn't written anything for this match
      throw err;
    }
    // A shorter file than last time means it was replaced or truncated under
    // us; keeping the old offset would splice two different files together.
    if (size < this.offset) this.reset();
    if (size === this.offset) return;

    const handle = await open(this.path, "r");
    try {
      const length = size - this.offset;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
      this.offset += bytesRead;
      this.consume(this.decoder.write(buffer.subarray(0, bytesRead)));
    } finally {
      await handle.close();
    }
  }

  private reset(): void {
    this.offset = 0;
    this.decoder = new StringDecoder("utf8");
    this.partial = "";
    this.seq = 0;
    this.retained = [];
    this.byClipId.clear();
  }

  private consume(chunk: string): void {
    const parts = (this.partial + chunk).split("\n");
    // The relay appends with a trailing newline, so the last element is either
    // empty or a line still being written. Either way it waits for more bytes.
    this.partial = parts.pop() ?? "";
    for (const line of parts) {
      if (!line.trim()) continue;
      let record: Raw;
      try {
        record = obj(JSON.parse(line) as unknown);
      } catch {
        continue; // one malformed record must not cost us the rest of the file
      }
      this.apply(record);
    }
  }

  private apply(record: Raw): void {
    const clipId = str(record.id);
    const at = str(record.at);
    if (!clipId || !at) return;

    if (record.kind === "detected") {
      const line: NarrationLine = {
        id: `${++this.seq}:${clipId}`,
        detectedAt: at,
        spokenAt: null,
        muted: false,
        text: str(record.text, "") as string,
      };
      this.byClipId.set(clipId, line);
      this.retained.push({ clipId, line });
      while (this.retained.length > this.keep) {
        const dropped = this.retained.shift();
        // Keeps the map bounded by the visible window rather than by the whole
        // match; a `spoken` for a line that already scrolled off changes
        // nothing anyone can see. The identity check matters after a relay
        // restart, when `c1` is a different clip than the `c1` being dropped.
        if (dropped && this.byClipId.get(dropped.clipId) === dropped.line) {
          this.byClipId.delete(dropped.clipId);
        }
      }
      return;
    }

    if (record.kind === "spoken") {
      const line = this.byClipId.get(clipId);
      // An orphan `spoken` (its `detected` scrolled out of the window, or the
      // file starts mid-clip) is dropped rather than shown as a bare line: a
      // row with no detection time would render as "spoken out of nowhere".
      if (!line || line.spokenAt !== null) return;
      line.spokenAt = at;
      line.muted = bool(record.muted);
    }
    // `synthesized` and `log` records are deliberately ignored here: the log
    // view has its own source, and "synthesized" is not a state the operator
    // can act on differently from "queued".
  }
}
