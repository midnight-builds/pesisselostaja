/** The stdout contract between the relay and journald.
 *
 *  The control app's log view used to guess a line's severity by matching
 *  Finnish words, and its own header called that a losing game: a missed error
 *  shows the operator a green phone while the broadcast is down. These tests
 *  pin the two things that replaced the guessing — a real syslog priority and a
 *  stable event code — including the bit that is easy to get wrong: the
 *  priority prefix must appear ONLY under systemd, or an operator running
 *  `relay:dev` in a terminal reads `<4>` on every line. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatLine, log, logDebug, logError, logInfo, logWarn, setLogSink } from "../src/log.js";

const TS = "12.30.45";
let originalJournalStream: string | undefined;

beforeEach(() => {
  originalJournalStream = process.env.JOURNAL_STREAM;
});

afterEach(() => {
  if (originalJournalStream === undefined) delete process.env.JOURNAL_STREAM;
  else process.env.JOURNAL_STREAM = originalJournalStream;
  setLogSink(null);
  vi.restoreAllMocks();
});

describe("under systemd (JOURNAL_STREAM set)", () => {
  beforeEach(() => {
    process.env.JOURNAL_STREAM = "8:12345";
  });

  it("prefixes the syslog priority systemd expects", () => {
    expect(formatLine("error", "speech.failed", "kaatui", TS)).toBe(
      "<3>[12.30.45] speech.failed: kaatui"
    );
    expect(formatLine("warn", "ffmpeg.respawn", "uudelleen", TS)).toBe(
      "<4>[12.30.45] ffmpeg.respawn: uudelleen"
    );
    expect(formatLine("info", "relay.start", "alkaa", TS)).toBe(
      "<6>[12.30.45] relay.start: alkaa"
    );
    expect(formatLine("debug", "api.delta_fetch", "polli", TS)).toBe(
      "<7>[12.30.45] api.delta_fetch: polli"
    );
  });

  /** journalctl -p warning has to catch a warning and skip an info line; that
   *  only works if the two priorities differ across the 4/6 boundary. */
  it("puts warn and error above the info threshold", () => {
    const pri = (line: string) => Number(/^<(\d)>/.exec(line)?.[1]);
    expect(pri(formatLine("error", null, "x", TS))).toBeLessThan(4);
    expect(pri(formatLine("warn", null, "x", TS))).toBeLessThanOrEqual(4);
    expect(pri(formatLine("info", null, "x", TS))).toBeGreaterThan(4);
  });
});

describe("in a terminal (no JOURNAL_STREAM)", () => {
  beforeEach(() => {
    delete process.env.JOURNAL_STREAM;
  });

  it("prints a clean line with no priority marker", () => {
    expect(formatLine("warn", "ffmpeg.respawn", "uudelleen", TS)).toBe(
      "[12.30.45] ffmpeg.respawn: uudelleen"
    );
  });

  it("keeps an uncoded line exactly as it always looked", () => {
    expect(formatLine("info", null, "Pesisselostaja Relay", TS)).toBe(
      "[12.30.45] Pesisselostaja Relay"
    );
  });
});

describe("sink", () => {
  it("reports level, code and text for every helper", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const seen: Array<{ level: string; code: string | null; msg: string }> = [];
    setLogSink((e) => seen.push({ level: e.level, code: e.code, msg: e.msg }));

    logDebug("api.first_seen", "d");
    logInfo("match.palo", "i");
    logWarn("speech.muted", "w");
    logError("relay.source_gone", "e");
    log("uncoded");

    expect(seen).toEqual([
      { level: "debug", code: "api.first_seen", msg: "d" },
      { level: "info", code: "match.palo", msg: "i" },
      { level: "warn", code: "speech.muted", msg: "w" },
      { level: "error", code: "relay.source_gone", msg: "e" },
      { level: "info", code: null, msg: "uncoded" },
    ]);
  });

  it("stamps an ISO instant, not the display time", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let at = "";
    setLogSink((e) => {
      at = e.at;
    });
    logInfo("relay.start", "x");
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
