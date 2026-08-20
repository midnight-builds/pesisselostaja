/** Issue #120: how far behind the scorer the narration is, measured during the
 *  run instead of reconstructed from the logs afterwards.
 *
 *  The distinction these tests exist to protect is "not measured" vs. "no
 *  delay". `created` is an optional field, and a missing one that reported 0 s
 *  would be a confident lie in exactly the situation that needs the truth. */

import { describe, it, expect } from "vitest";
import {
  emptyLagWindow,
  eventCreatedMs,
  eventLagMs,
  formatLagWindow,
  recordEventLag,
} from "../src/eventLag.js";
import type { LiveEvent } from "../src/types.js";

const NOW = Date.UTC(2026, 6, 30, 5, 40, 14); // 08:40:14 Suomen aikaa

function event(created?: number | null): LiveEvent {
  return {
    id: 18, groupType: "x", period: 0, inning: 0, batTurn: 0, team: 100, hTeam: 100,
    batter: null, pairIndex: null, hitNumber: null, hit: null, events: [], timestamp: null,
    ...(created === undefined ? {} : { created }),
  };
}

/** Ottelun 145900 kolmas palo: kirjattu 08:39:31, havaittu 08:40:14. */
const THIRD_PALO_CREATED = Math.floor(Date.UTC(2026, 6, 30, 5, 39, 31) / 1000);

describe("eventCreatedMs", () => {
  it("reads the scorer's marking instant from unix seconds", () => {
    expect(eventCreatedMs(event(THIRD_PALO_CREATED))).toBe(THIRD_PALO_CREATED * 1000);
  });

  it("answers null when the field is absent, null or not a number", () => {
    expect(eventCreatedMs(event())).toBeNull();
    expect(eventCreatedMs(event(null))).toBeNull();
    expect(eventCreatedMs(event(Number.NaN))).toBeNull();
  });

  it("rejects values outside a plausible range instead of reporting an absurd lag", () => {
    // Milliseconds mistaken for seconds is the realistic way this goes wrong.
    expect(eventCreatedMs(event(0))).toBeNull();
    expect(eventCreatedMs(event(THIRD_PALO_CREATED * 1000))).toBeNull();
  });
});

describe("eventLagMs", () => {
  it("measures the 43 s gap that started this issue", () => {
    expect(eventLagMs(event(THIRD_PALO_CREATED), NOW)).toBe(43_000);
  });

  it("is null, not zero, when the event carries no created field", () => {
    expect(eventLagMs(event(), NOW)).toBeNull();
  });

  it("clamps clock skew to zero rather than reporting a negative delay", () => {
    const future = Math.floor(NOW / 1000) + 5;
    expect(eventLagMs(event(future), NOW)).toBe(0);
  });
});

describe("LagWindow", () => {
  it("keeps the largest lag, not an average that would hide the spike", () => {
    const w = emptyLagWindow();
    for (const s of [27, 13, 43, 20]) {
      recordEventLag(w, event(Math.floor(NOW / 1000) - s), NOW);
    }
    expect(w.maxMs).toBe(43_000);
    expect(w.latestMs).toBe(20_000);
    expect(w.samples).toBe(4);
  });

  it("counts unmeasurable events separately from measured ones", () => {
    const w = emptyLagWindow();
    expect(recordEventLag(w, event(), NOW)).toBeNull();
    recordEventLag(w, event(THIRD_PALO_CREATED), NOW);
    expect(w).toMatchObject({ samples: 1, missing: 1, maxMs: 43_000 });
  });

  it("starts with nothing measured", () => {
    expect(emptyLagWindow()).toEqual({ latestMs: null, maxMs: null, samples: 0, missing: 0 });
  });
});

describe("formatLagWindow", () => {
  it("says 'ei mitattua' when nothing was seen at all", () => {
    expect(formatLagWindow(emptyLagWindow())).toBe("ei mitattua");
  });

  it("names the reason when events arrived but none carried created", () => {
    const w = emptyLagWindow();
    recordEventLag(w, event(), NOW);
    recordEventLag(w, event(), NOW);
    // Not "0 s": the feed was moving, we just could not measure it.
    expect(formatLagWindow(w)).toBe("ei mitattavissa (2 ilman created-kenttää)");
  });

  it("reports latest and max in seconds", () => {
    const w = emptyLagWindow();
    recordEventLag(w, event(Math.floor(NOW / 1000) - 43), NOW);
    recordEventLag(w, event(Math.floor(NOW / 1000) - 20), NOW);
    expect(formatLagWindow(w)).toBe("viimeisin 20 s, suurin 43 s (2 kpl)");
  });

  it("mentions unmeasurable events alongside the measured ones", () => {
    const w = emptyLagWindow();
    recordEventLag(w, event(Math.floor(NOW / 1000) - 5), NOW);
    recordEventLag(w, event(), NOW);
    expect(formatLagWindow(w)).toBe("viimeisin 5 s, suurin 5 s (1 kpl, 1 ilman created-kenttää)");
  });
});
