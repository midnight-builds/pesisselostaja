// Jaksotauko (#302): jakson päättymisen ja seuraavan jakson ensimmäisen
// pelitapahtuman välissä täytteet ja koosteet eivät saa väittää kenenkään
// olevan sisävuorossa — livenä 6.9.2026 täyte sanoi "sisävuorossa on IPV"
// keskellä jaksotaukoa (ja uudestaan ottelun lopussa).
//
// periodBreak on PÄÄTTYNEEN jakson numero (ei lippu): currentPeriod voi
// liikkua tauon aikana vastaustason rekonsiliaatiosta, ja taukofraasin on
// puhuttava päättyneestä jaksosta (adversariaalisen katselmuksen löydös 2).
import { describe, expect, it } from "vitest";
import {
  closesPeriodBreak,
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
    periodBreak: 0,
    ...overrides,
  };
}

function textSub(text: string): SubEvent {
  return { texts: [{ type: "event", text, base: null }] };
}
const runSub: SubEvent = { texts: [{ type: "event", text: "Juoksu", base: null }, { type: "stat", score: 1 }] };
const paloSub: SubEvent = { texts: [{ type: "event", text: "Palo", base: null }, { type: "stat", out: 1 }] };

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
    const s = formatIdleSummary(meta, ctxWith({ periodBreak: null }));
    expect(s).toContain("sisävuorossa on Sudet");
  });

  // Katselmuslöydös 2: rekonsiliaatio nostaa currentPeriodin uuteen jaksoon
  // kesken tauon — fraasin on silti puhuttava päättyneestä jaksosta.
  it("puhuu päättyneestä jaksosta vaikka currentPeriod olisi jo uusi", () => {
    for (let i = 0; i < 25; i++) {
      const s = formatIdleSummary(meta, ctxWith({ currentPeriod: 1, periodBreak: 0 }));
      expect(s.toLowerCase()).toContain("ensimmäinen jakso");
      expect(s.toLowerCase()).not.toContain("toinen jakso");
    }
  });

  // Katselmuslöydös 1: juuri päättynyt jakso lasketaan jaksotilanteeseen —
  // 2. jakson tauolla 1. jakson kotiin ja 2. vieraille = "Jaksot 1, 1".
  it("jaksotilanne sisältää juuri päättyneen jakson", () => {
    const s = formatIdleSummary(meta, ctxWith({
      currentPeriod: 1, periodBreak: 1,
      periodHomeRuns: 2, periodAwayRuns: 5,
      homePeriodsWon: 1, awayPeriodsWon: 0,
    }));
    expect(s).toContain("1");
    expect(s).toMatch(/Ketut 1.*Sudet 1|Jaksot.*1.*1/);
  });

  it("mutta ei laske sitä kahdesti kun currentPeriod on jo liikkunut", () => {
    // Rekonsiliaatio nosti currentPeriodin → periodsWon laski päättyneen
    // jakson jo mukaan (awayPeriodsWon: 1).
    const s = formatIdleSummary(meta, ctxWith({
      currentPeriod: 2, periodBreak: 1,
      periodHomeRuns: 2, periodAwayRuns: 5,
      homePeriodsWon: 1, awayPeriodsWon: 1,
    }));
    expect(s).not.toMatch(/Sudet 2/);
  });
});

describe("isPeriodEndSubEvent", () => {
  it("tunnistaa jakson ja supervuoron päättymisen, ei muuta", () => {
    expect(isPeriodEndSubEvent(textSub("Ensimmäinen jakso päättyi"))).toBe(true);
    expect(isPeriodEndSubEvent(textSub("Toinen jakso päättyi"))).toBe(true);
    expect(isPeriodEndSubEvent(textSub("Supervuoro päättyi"))).toBe(true);
    // Nähty livenä 6.9.2026: oma merkintänsä, joka voi edeltää "Ottelu
    // päättyi" -merkintää pitkälläkin viiveellä.
    expect(isPeriodEndSubEvent(textSub("Kotiutuslyöntikilpailu päättyi"))).toBe(true);
    expect(isPeriodEndSubEvent(textSub("Ottelu päättyi"))).toBe(false);
    expect(isPeriodEndSubEvent(textSub("Palo"))).toBe(false);
    expect(isPeriodEndSubEvent(textSub("Toinen jakso alkoi"))).toBe(false);
  });
});

describe("closesPeriodBreak", () => {
  // Katselmuslöydös 3: kirjurin vaihto- tai korjausmerkintä tauolla EI saa
  // sulkea taukoa — muuten täytteet palaavat väittämään sisävuoroa.
  it("kirjurin muu merkintä samassa jaksossa ei sulje taukoa", () => {
    expect(closesPeriodBreak(textSub("Pelaajavaihto"), 0, 0)).toBe(false);
  });

  it("pelitapahtumat ja uuden jakson merkinnät sulkevat", () => {
    expect(closesPeriodBreak(textSub("Toinen jakso alkoi"), 1, 0)).toBe(true);
    expect(closesPeriodBreak(textSub("mikä tahansa"), 1, 0)).toBe(true); // eri period
    expect(closesPeriodBreak(runSub, 0, 0)).toBe(true);
    expect(closesPeriodBreak(paloSub, 0, 0)).toBe(true);
    expect(closesPeriodBreak(textSub("Ottelu päättyi"), 0, 0)).toBe(true);
  });
});

describe("periodBreak-tilan serialisointi", () => {
  it("säilyy roundtripissa (myös jakso 0)", () => {
    const state = emptyState();
    state.periodBreak = 0;
    const back = deserializeWatcherState(JSON.parse(JSON.stringify(serializeWatcherState(state))));
    expect(back.periodBreak).toBe(0);
  });

  it("vanha resume-tiedosto ilman kenttää palautuu nulliksi", () => {
    const legacy = serializeWatcherState(emptyState()) as Record<string, unknown>;
    delete legacy.periodBreak;
    expect(deserializeWatcherState(legacy).periodBreak).toBe(null);
  });
});
