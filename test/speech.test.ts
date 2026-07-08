import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { eventToSpeech, subEventToSpeech, buildPlayerLookup, eventFingerprint, type SpeechContext } from "../src/speech.js";
import { preventOrdinalReading } from "../src/pronunciation.js";
import type { LiveEventsResponse, MatchMetadata, LiveEvent } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "fixtures");

const matchMeta: MatchMetadata = JSON.parse(
  readFileSync(join(fixturesDir, "match-135155.json"), "utf-8")
);
const eventsData: LiveEventsResponse = JSON.parse(
  readFileSync(join(fixturesDir, "events-135155.json"), "utf-8")
);

const lookup = buildPlayerLookup(matchMeta);

describe("buildPlayerLookup", () => {
  it("should load players from both teams", () => {
    expect(lookup.byId.size).toBeGreaterThan(0);
    // Check a known player
    const player = lookup.byId.get(17865);
    expect(player).toBeDefined();
    expect(player?.last_name).toBe("Virtanen");
  });
});

describe("preventOrdinalReading", () => {
  it("detaches a sentence-final period from a digit so TTS reads a cardinal", () => {
    expect(preventOrdinalReading("Roihu EP johtaa, 10, 6.")).toBe("Roihu EP johtaa, 10, 6 .");
  });

  it("handles a digit before a period followed by another sentence", () => {
    expect(preventOrdinalReading("Jaksot Roihu EP 1, PuMu 0. Sisävuorossa PuMu."))
      .toBe("Jaksot Roihu EP 1, PuMu 0 . Sisävuorossa PuMu.");
  });

  it("leaves decimals untouched", () => {
    expect(preventOrdinalReading("arvo 6.5 metriä")).toBe("arvo 6.5 metriä");
  });
});

describe("eventToSpeech", () => {
  it("should produce speech for match start", () => {
    const matchStart = eventsData.events.find(
      (e) => e.events[0]?.texts?.some(
        (t) => typeof t === "object" && "type" in t && t.type === "event" && "text" in t && t.text === "Ottelu alkoi"
      )
    );
    expect(matchStart).toBeDefined();
    const speech = eventToSpeech(matchStart!, matchMeta, lookup);
    expect(speech).toContain("Ottelu alkoi");
    expect(speech).toContain("IPV");
    expect(speech).toContain("KiPa");
  });

  it("should produce speech for period start", () => {
    const periodStart = eventsData.events.find(
      (e) => e.events[0]?.texts?.some(
        (t) => typeof t === "object" && "type" in t && t.type === "event" && "text" in t && t.text?.includes("jakso alkoi")
      )
    );
    expect(periodStart).toBeDefined();
    const speech = eventToSpeech(periodStart!, matchMeta, lookup);
    expect(speech).toContain("jakso alkoi");
  });

  it("should produce speech for a run scored", () => {
    const runEvent = eventsData.events.find(
      (e) => e.events[0]?.texts?.some(
        (t) => typeof t === "object" && "type" in t && t.type === "event" && "text" in t && t.text?.includes("löi juoksun")
      )
    );
    expect(runEvent).toBeDefined();
    const speech = eventToSpeech(runEvent!, matchMeta, lookup);
    expect(speech).toBeDefined();
    expect(speech).toContain("löi juoksun");
    expect(speech).toContain("tuojana");
    // Should contain player names
    expect(speech).toMatch(/[A-ZÄÖÅ][a-zäöå]+/);
  });

  it("should produce speech for palo (out)", () => {
    const paloEvent = eventsData.events.find(
      (e) => e.events[0]?.texts?.some(
        (t) => typeof t === "object" && "type" in t && t.type === "event" && "text" in t && t.text === "Palo"
      )
    );
    expect(paloEvent).toBeDefined();
    const speech = eventToSpeech(paloEvent!, matchMeta, lookup);
    expect(speech).toContain("Palo");
  });

  it("should skip Lyöntivuorossa events", () => {
    const lyontiEvent = eventsData.events.find(
      (e) => e.events[0]?.texts?.some(
        (t) => typeof t === "object" && "settling-at-bat" in t
      )
    );
    expect(lyontiEvent).toBeDefined();
    // With batter announcements disabled, settling-at-bat events are skipped.
    const speech = eventToSpeech(lyontiEvent!, matchMeta, lookup, false);
    expect(speech).toBeNull();
  });

  it("should produce speech for draw of choice", () => {
    const doc = eventsData.events.find((e) => e.id === "drawofchoice");
    expect(doc).toBeDefined();
    const speech = eventToSpeech(doc!, matchMeta, lookup);
    expect(speech).toBeDefined();
    expect(speech).toContain("IPV");
  });
});

describe("formatMatchEnd (via subEventToSpeech)", () => {
  const matchEndEvent: LiveEvent = {
    id: 999, groupType: "info", period: 0, inning: 0, batTurn: 0,
    team: null, hTeam: matchMeta.home.id, batter: null, pairIndex: null,
    hitNumber: null, hit: null, timestamp: 2820,
    events: [{ texts: [{ type: "event", text: "Ottelu päättyi" }] }],
  };
  const sub = matchEndEvent.events[0];

  it("reports the actual score for a single-jakso match, not the meaningless 0-1 periodsWon split", () => {
    const ctx: SpeechContext = {
      periodHomeRuns: 2, periodAwayRuns: 22,
      homePeriodsWon: 0, awayPeriodsWon: 1, periodsPlayed: 1,
      currentOuts: 0, currentPeriod: 0, currentBatTeamId: null,
    };
    const speech = subEventToSpeech(matchEndEvent, sub, matchMeta, lookup, true, ctx);
    expect(speech).toContain(`${matchMeta.away.shorthand} voitti`);
    expect(speech).toContain(`${matchMeta.home.shorthand} 2, ${matchMeta.away.shorthand} 22`);
  });

  it("reports periods won for a multi-jakso match", () => {
    const ctx: SpeechContext = {
      periodHomeRuns: 3, periodAwayRuns: 5,
      homePeriodsWon: 2, awayPeriodsWon: 1, periodsPlayed: 3,
      currentOuts: 0, currentPeriod: 2, currentBatTeamId: null,
    };
    const speech = subEventToSpeech(matchEndEvent, sub, matchMeta, lookup, true, ctx);
    expect(speech).toContain(`${matchMeta.home.shorthand} voitti`);
    expect(speech).toContain(`${matchMeta.home.shorthand} 2, ${matchMeta.away.shorthand} 1`);
  });
});

describe("eventFingerprint", () => {
  it("should produce stable fingerprints", () => {
    const event = eventsData.events[0];
    const fp1 = eventFingerprint(event, 0);
    const fp2 = eventFingerprint(event, 0);
    expect(fp1).toBe(fp2);
  });

  it("should produce different fingerprints for different sub-events", () => {
    // Find an event with content
    const event = eventsData.events[0];
    const fp0 = eventFingerprint(event, 0);
    const fp1 = eventFingerprint(event, 1); // non-existent sub-event
    expect(fp0).not.toBe(fp1);
  });
});

describe("full event stream processing", () => {
  it("should produce reasonable speech for all fixture events", () => {
    const speeches: string[] = [];
    for (const event of eventsData.events) {
      const speech = eventToSpeech(event as LiveEvent, matchMeta, lookup);
      if (speech) speeches.push(speech);
    }
    // Should have some spoken events
    expect(speeches.length).toBeGreaterThan(3);
    // Should not contain raw JSON
    for (const s of speeches) {
      expect(s).not.toContain("{");
      expect(s).not.toContain("[object");
    }
  });
});
