// Jaksotauko (#302): jakson päättymisen ja seuraavan jakson ensimmäisen
// tapahtuman välissä täytteet ja koosteet eivät saa väittää kenenkään olevan
// sisävuorossa — livenä 6.9.2026 täyte sanoi "sisävuorossa on IPV" keskellä
// jaksotaukoa (ja uudestaan ottelun lopussa).
import { describe, expect, it } from "vitest";
import {
  deserializeWatcherState,
  emptyState,
  formatIdleSummary,
  formatSituationSummary,
  isPeriodEndSubEvent,
  serializeWatcherState,
  type MatchMetadata,
  type SpeechContext,
  type SubEvent,
} from "../src/index.js";

// Fiktiiviset nimet (julkinen repo).
const meta: MatchMetadata = {
  id: 1, date: "2026-09-06",
  home: { id: 100, name: "Ketut", shorthand: "Ketut", players: [], all_players: [] },
  away: { id: 200, name: "Sudet", shorthand: "Sudet", players: [], all_players: [] },
  series: {}, stadium: null,
  live: true, started: true,
};

function ctxWith(overrides: Partial<SpeechContext> = {}): SpeechContext {
  return {
    periodHomeRuns: 3, periodAwayRuns: 1,
    homePeriodsWon: 0, awayPeriodsWon: 0, periodsPlayed: 1,
    currentOuts: 2, currentPeriod: 0, currentBatTeamId: 200,
    currentInning: 3, currentBatTurn: 0,
    periodBreak: true,
    ...overrides,
  };
}

function textSub(text: string): SubEvent {
  return { texts: [{ type: "event", text, base: null }] };
}

describe("jaksotauon koosteet (#302)", () => {
  // pickVariant arpoo — kaikki variantit on koeteltava, siksi silmukka.
  it("idle-täyte ei väitä ketään sisävuoroon eikä sano 'menossa'", () => {
    for (let i = 0; i < 25; i++) {
      const s = formatIdleSummary(meta, ctxWith());
      expect(s.toLowerCase()).not.toContain("sisävuoro");
      expect(s.toLowerCase()).not.toContain("menossa");
      expect(s).toContain("3, 1");
      expect(s).toContain("Ketut");
    }
  });

  it("tilannekooste käyttäytyy tauolla samoin", () => {
    for (let i = 0; i < 25; i++) {
      const s = formatSituationSummary(meta, ctxWith());
      expect(s.toLowerCase()).not.toContain("sisävuoro");
      expect(s).toContain("3, 1");
    }
  });

  it("tasajakso kerrotaan tasatuloksena ilman voittajaa", () => {
    const s = formatIdleSummary(meta, ctxWith({ periodHomeRuns: 2, periodAwayRuns: 2 }));
    expect(s).toContain("tasan 2, 2");
  });

  it("ilman taukoa täyte toimii kuten ennen (sisävuoro mukana)", () => {
    const s = formatIdleSummary(meta, ctxWith({ periodBreak: false }));
    expect(s).toContain("sisävuorossa on Sudet");
  });
});

describe("isPeriodEndSubEvent", () => {
  it("tunnistaa jakson ja supervuoron päättymisen, ei muuta", () => {
    expect(isPeriodEndSubEvent(textSub("Ensimmäinen jakso päättyi"))).toBe(true);
    expect(isPeriodEndSubEvent(textSub("Toinen jakso päättyi"))).toBe(true);
    expect(isPeriodEndSubEvent(textSub("Supervuoro päättyi"))).toBe(true);
    expect(isPeriodEndSubEvent(textSub("Ottelu päättyi"))).toBe(false);
    expect(isPeriodEndSubEvent(textSub("Palo"))).toBe(false);
    expect(isPeriodEndSubEvent(textSub("Toinen jakso alkoi"))).toBe(false);
  });
});

describe("periodBreak-tilan serialisointi", () => {
  it("säilyy roundtripissa", () => {
    const state = emptyState();
    state.periodBreak = true;
    const back = deserializeWatcherState(JSON.parse(JSON.stringify(serializeWatcherState(state))));
    expect(back.periodBreak).toBe(true);
  });

  it("vanha resume-tiedosto ilman kenttää palautuu falseksi", () => {
    const legacy = serializeWatcherState(emptyState()) as Record<string, unknown>;
    delete legacy.periodBreak;
    expect(deserializeWatcherState(legacy).periodBreak).toBe(false);
  });
});
