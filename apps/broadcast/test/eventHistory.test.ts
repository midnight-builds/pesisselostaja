import { describe, it, expect } from "vitest";
import { EventHistory } from "../src/eventHistory.js";
import type { LiveEvent, SubEvent } from "@pesisselostaja/core";

// Fictional data only (public repo).
function ev(overrides: Partial<LiveEvent> = {}, subs: SubEvent[] = []): LiveEvent {
  return {
    id: 1, groupType: "x", period: 0, inning: 0, batTurn: 0, team: 100, hTeam: 100,
    batter: null, pairIndex: null, hitNumber: null, hit: null,
    events: subs, timestamp: 10, updated: null,
    ...overrides,
  };
}
const palo: SubEvent = { texts: [{ type: "event", text: "Palo", base: null }, { type: "stat", out: 1 }] };
const run: SubEvent = { texts: [{ type: "stat", score: 1 }] };

describe("EventHistory keying", () => {
  it("treats the same id in different turns as different events (id resets per turn)", () => {
    const h = new EventHistory();
    h.replace([ev({ id: 2, batTurn: 0, team: 100 }, [palo])]);
    // Next turn: the other team's palo reuses id 2 — must NOT collapse.
    const merge = h.merge([ev({ id: 2, batTurn: 0, team: 200 }, [palo])]);
    expect(merge.added).toBe(1);
    expect(h.size).toBe(2);
  });
});

describe("EventHistory.merge", () => {
  it("appends new events in response order after the existing history", () => {
    const h = new EventHistory();
    h.replace([ev({ id: 1 }), ev({ id: 2 })]);
    const merge = h.merge([ev({ id: 3 }), ev({ id: 4 })]);
    expect(merge).toEqual({ added: 2, updated: 0, inconsistent: false });
    expect(h.events.map((e) => e.id)).toEqual([1, 2, 3, 4]);
  });

  it("replaces an existing event whose sub-event list grew, in place", () => {
    const h = new EventHistory();
    h.replace([ev({ id: 1 }, [palo]), ev({ id: 2 })]);
    const merge = h.merge([ev({ id: 1 }, [palo, run])]);
    expect(merge).toEqual({ added: 0, updated: 1, inconsistent: false });
    expect(h.events.map((e) => e.id)).toEqual([1, 2]); // order preserved
    expect(h.events[0].events).toHaveLength(2);
  });

  it("ignores a byte-identical re-delivery (delta windows overlap by design)", () => {
    const h = new EventHistory();
    h.replace([ev({ id: 1 }, [palo])]);
    const merge = h.merge([ev({ id: 1 }, [palo])]);
    expect(merge).toEqual({ added: 0, updated: 0, inconsistent: false });
    expect(h.size).toBe(1);
  });

  it("flags a shrunken sub-event list as inconsistent and leaves the stored event untouched", () => {
    const h = new EventHistory();
    h.replace([ev({ id: 1 }, [palo, run])]);
    const merge = h.merge([ev({ id: 1 }, [palo])]);
    expect(merge.inconsistent).toBe(true);
    expect(h.events[0].events).toHaveLength(2); // caller full-refetches instead
  });
});

describe("EventHistory.replace", () => {
  it("discards the previous history entirely (full fetch / resync semantics)", () => {
    const h = new EventHistory();
    h.replace([ev({ id: 1 }), ev({ id: 2 })]);
    h.replace([ev({ id: 5 })]);
    expect(h.events.map((e) => e.id)).toEqual([5]);
  });
});
