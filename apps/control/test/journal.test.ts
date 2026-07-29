/** How a journald record becomes a line in the operator's log view.
 *
 *  This used to be guesswork: every relay line arrived at PRIORITY=6 and the
 *  level was inferred by matching Finnish words, so a reworded log call could
 *  silently turn an error into an info line and leave the phone green during a
 *  dead broadcast. The relay now sends a real priority and a stable event code.
 *
 *  The tests are split accordingly: coded lines (the relay as deployed from
 *  29.7.2026 onward) must be read, never guessed, and un-coded lines (older
 *  builds still sitting in journald, or a relay that has not been redeployed
 *  yet) must keep the cautious old behaviour. */

import { describe, expect, it } from "vitest";
import { toLogLine, type JournalRecord } from "../src/server/journal.js";

/** 2026-07-29T08:00:00Z in journald's microseconds. */
const USEC = "1785312000000000";

function record(message: string, priority?: string): JournalRecord {
  return { MESSAGE: message, PRIORITY: priority, __REALTIME_TIMESTAMP: USEC };
}

describe("coded lines from the current relay", () => {
  it("reads the level off the priority and lifts the code out of the text", () => {
    const line = toLogLine(record("[12.30.45] ffmpeg.respawn: Uudelleenyritys 2000ms kuluttua…", "4"));
    expect(line).toEqual({
      ts: "2026-07-29T08:00:00.000Z",
      level: "warn",
      code: "ffmpeg.respawn",
      msg: "Uudelleenyritys 2000ms kuluttua…",
    });
  });

  it("maps every priority the relay emits", () => {
    const at = (pri: string) => toLogLine(record(`[1.00.00] relay.start: x`, pri))?.level;
    expect(at("3")).toBe("error");
    expect(at("4")).toBe("warn");
    expect(at("6")).toBe("info");
    expect(at("7")).toBe("debug");
  });

  /** The regression the code exists to prevent. This line is info — it merely
   *  mentions a failure count — and the old prose rule called it an error. */
  it("does not let wording override a coded info line", () => {
    const line = toLogLine(
      record("[1.00.00] api.fetch_recovered: Haku onnistui jälleen — 3 peräkkäistä hakuvirhettä takana.", "6")
    );
    expect(line?.level).toBe("info");
    expect(line?.code).toBe("api.fetch_recovered");
  });

  it("keeps Finnish prose containing a colon intact", () => {
    const line = toLogLine(record("[1.00.00] match.score: Pisteet (1. jakso): PY 0-2 IPV", "6"));
    expect(line?.code).toBe("match.score");
    expect(line?.msg).toBe("Pisteet (1. jakso): PY 0-2 IPV");
  });

  /** A colon-bearing sentence with no code must not have its first words eaten
   *  and passed off as an event code. */
  it("does not invent a code out of ordinary text", () => {
    const line = toLogLine(record("[1.00.00] Sammutetaan: kaikki valmista", "6"));
    expect(line?.code).toBeNull();
    expect(line?.msg).toBe("Sammutetaan: kaikki valmista");
  });
});

describe("un-coded lines from an older relay build", () => {
  /** ~/relay-deploy only moves when someone runs relay:deploy, so a broadcast
   *  can be running a build that predates event codes. Those lines still have
   *  to be readable, and an error in them still has to look like one. */
  it("still falls back to prose when there is no code", () => {
    expect(toLogLine(record("[1.00.00] Selostusvirhe: synteesi kaatui", "6"))?.level).toBe("error");
    expect(toLogLine(record("[1.00.00] Lähde luovuttaa", "6"))?.level).toBe("warn");
    expect(toLogLine(record("[1.00.00] Selostus: Ottelu alkoi!", "6"))?.level).toBe("info");
  });

  it("prefers a real priority over prose even without a code", () => {
    expect(toLogLine(record("[1.00.00] Selostusvirhe: kaatui", "4"))?.level).toBe("warn");
  });
});

describe("robustness", () => {
  it("decodes a MESSAGE that journald handed over as bytes", () => {
    const bytes = Array.from(Buffer.from("[1.00.00] match.palo: Palo: IPV 1", "utf8"));
    const line = toLogLine({ MESSAGE: bytes, PRIORITY: "6", __REALTIME_TIMESTAMP: USEC });
    expect(line?.code).toBe("match.palo");
    expect(line?.msg).toBe("Palo: IPV 1");
  });

  it("drops an empty line rather than rendering a blank row", () => {
    expect(toLogLine(record("[1.00.00] ", "6"))).toBeNull();
    expect(toLogLine(record("", "6"))).toBeNull();
  });

  /** A code with no message never comes out of the relay, and if one somehow
   *  did, showing it verbatim beats dropping it: an operator can act on a
   *  strange line, not on a missing one. The code pattern needs text after the
   *  colon, so such a line simply stays uncoded. */
  it("shows a degenerate code-only line rather than swallowing it", () => {
    const line = toLogLine(record("[1.00.00] relay.start: ", "6"));
    expect(line?.msg).toBe("relay.start:");
    expect(line?.code).toBeNull();
  });

  it("survives a missing or unparseable priority", () => {
    expect(toLogLine(record("[1.00.00] relay.start: x"))?.level).toBe("info");
    expect(toLogLine(record("[1.00.00] relay.start: x", "ei-numero"))?.level).toBe("info");
  });
});
