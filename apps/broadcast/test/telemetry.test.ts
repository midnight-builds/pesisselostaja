/** Telemetry writes two files a live control app reads while a broadcast is
 *  running. The tests below care about three things in this order:
 *
 *  1. A reader never sees a half-written snapshot.
 *  2. A telemetry failure never reaches the broadcast.
 *  3. The muted/spoken split is right — that is the number the whole module
 *     exists for. */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logError, logInfo, logWarn, setLogSink } from "../src/log.js";
import { Telemetry, type RelayStatus, type StatusProbe, type TimelineRecord } from "../src/telemetry.js";

let dir: string;

const PROBE: StatusProbe = {
  readerAttached: true,
  pendingClips: 2,
  respawns: 1,
  sourceState: "live",
  sourceDetail: "ffmpeg käynnissä",
  matchFinished: false,
  sourceLagMs: 4200,
  eventCount: 137,
  lastEventAt: "2026-07-29T08:00:00.000Z",
  ttsEngine: "elevenlabs",
  elevenLabsCharsUsed: 4253,
};

function make(overrides: Partial<ConstructorParameters<typeof Telemetry>[0]> = {}): Telemetry {
  return new Telemetry({ runDir: dir, matchId: 145889, ...overrides });
}

function readStatus(t: Telemetry): RelayStatus {
  return JSON.parse(readFileSync(t.statusPath, "utf8")) as RelayStatus;
}

function readTimeline(t: Telemetry): TimelineRecord[] {
  return readFileSync(t.timelinePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TimelineRecord);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pesis-telemetry-"));
});

afterEach(() => {
  setLogSink(null);
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("status snapshot", () => {
  it("names the files after the match, in run/", () => {
    const t = make();
    expect(t.statusPath).toBe(join(dir, "status-145889.json"));
    expect(t.timelinePath).toBe(join(dir, "timeline-145889.ndjson"));
  });

  it("writes a complete snapshot of what the probe reported", () => {
    const t = make();
    t.writeStatus(PROBE);
    const s = readStatus(t);
    expect(s.matchId).toBe(145889);
    expect(s.readerAttached).toBe(true);
    expect(s.respawns).toBe(1);
    expect(s.source).toEqual({ state: "live", detail: "ffmpeg käynnissä" });
    expect(s.match.eventCount).toBe(137);
    expect(s.tts.elevenLabsCharsUsed).toBe(4253);
  });

  /** The control app polls this file every second or two. A plain overwrite
   *  would hand it a truncated document often enough to matter, so the write
   *  goes to .tmp and renames. */
  it("leaves no partial file behind — the temp file is gone after the write", () => {
    const t = make();
    t.writeStatus(PROBE);
    expect(readdirSync(dir)).toEqual(["status-145889.json"]);
  });

  it("rewrites in place, so a reader always finds exactly one snapshot", () => {
    const t = make();
    t.writeStatus(PROBE);
    t.writeStatus({ ...PROBE, readerAttached: false, respawns: 4 });
    expect(readStatus(t).respawns).toBe(4);
    expect(readStatus(t).readerAttached).toBe(false);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("counts uptime from the run's start, not from the snapshot", () => {
    const started = new Date("2026-07-29T08:00:00.000Z");
    const t = make({ startedAt: started, now: () => new Date("2026-07-29T08:42:30.000Z") });
    t.writeStatus(PROBE);
    expect(readStatus(t).uptimeSec).toBe(2550);
  });
});

describe("narration stages", () => {
  it("keeps muted clips apart from spoken ones", () => {
    const t = make();
    t.narrationDetected({ id: "c1", text: "Ottelu alkoi!" });
    t.narrationSpoken({ id: "c1", text: "Ottelu alkoi!" }, true);
    t.narrationDetected({ id: "c2", text: "Toinen palo." });
    t.narrationSpoken({ id: "c2", text: "Toinen palo." }, false);

    t.writeStatus(PROBE);
    const n = readStatus(t).narration;
    expect(n.detected).toBe(2);
    expect(n.muted).toBe(1);
    expect(n.spoken).toBe(1);
  });

  /** The exact shape of the morning of 29.7.2026: the relay was up and
   *  narrating, but ffmpeg had not attached, so every line was muted. The
   *  snapshot has to make that obvious rather than showing a busy, healthy run. */
  it("shows an all-muted run for what it is", () => {
    const t = make();
    for (const text of ["Ottelu alkoi!", "Ensimmäinen palo!", "Juoksun löi Turunen."]) {
      t.narrationDetected({ id: text, text });
      t.narrationSpoken({ id: text, text }, true);
    }
    t.writeStatus({ ...PROBE, readerAttached: false });
    const s = readStatus(t);
    expect(s.narration.spoken).toBe(0);
    expect(s.narration.muted).toBe(3);
    expect(s.readerAttached).toBe(false);
  });

  it("records all three stages on the timeline with a shared id", () => {
    const t = make();
    const clip = { id: "c7", text: "Kolmas palo." };
    t.narrationDetected(clip);
    t.narrationSynthesized(clip, "elevenlabs", 812);
    t.narrationSpoken(clip, false);

    const kinds = readTimeline(t).map((r) => r.kind);
    expect(kinds).toEqual(["detected", "synthesized", "spoken"]);
    expect(readTimeline(t).every((r) => "id" in r && r.id === "c7")).toBe(true);
  });
});

describe("log capture", () => {
  it("puts every level and code on the timeline", () => {
    const t = make();
    t.attachToLog();
    vi.spyOn(console, "log").mockImplementation(() => {});
    logInfo("relay.start", "Pesisselostaja Relay");
    logWarn("ffmpeg.unproductive", "ffmpeg kuoli alle 60 s käynnistyksestä");

    const rows = readTimeline(t).filter((r) => r.kind === "log");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ level: "info", code: "relay.start" });
    expect(rows[1]).toMatchObject({ level: "warn", code: "ffmpeg.unproductive" });
  });

  /** The operator should not have to read the timeline to learn why the phone
   *  went red, so the newest warn/error rides along in the snapshot. */
  it("carries the latest problem into the snapshot, and only problems", () => {
    const t = make();
    t.attachToLog();
    vi.spyOn(console, "log").mockImplementation(() => {});
    logError("speech.failed", "Selostusvirhe: synteesi kaatui");
    logInfo("match.palo", "Palo: IPV 1");

    t.writeStatus(PROBE);
    expect(readStatus(t).lastProblem).toMatchObject({
      level: "error",
      code: "speech.failed",
      msg: "Selostusvirhe: synteesi kaatui",
    });
  });

  it("detaches cleanly", () => {
    const t = make();
    t.attachToLog();
    t.detachFromLog();
    vi.spyOn(console, "log").mockImplementation(() => {});
    logInfo("relay.start", "ei pitäisi päätyä aikajanalle");
    expect(readdirSync(dir)).not.toContain("timeline-145889.ndjson");
  });
});

describe("failure is never the broadcast's problem", () => {
  it("survives an unwritable run directory and says so exactly once", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // A FILE where the directory should be: every write below must fail.
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "");
    const t = new Telemetry({ runDir: blocked, matchId: 1 });

    expect(() => {
      t.writeStatus(PROBE);
      t.writeStatus(PROBE);
      t.narrationDetected({ id: "c1", text: "x" });
    }).not.toThrow();
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it("a throwing sink cannot take down a log call", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    setLogSink(() => {
      throw new Error("telemetria hajosi");
    });
    expect(() => logInfo("relay.start", "silti lokitetaan")).not.toThrow();
  });
});
