import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock ONLY the network call, like commentaryLoopDelta.test.ts does.
vi.mock("@pesisselostaja/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pesisselostaja/core")>();
  return { ...actual, fetchLiveEvents: vi.fn() };
});

import { fetchLiveEvents } from "@pesisselostaja/core";
import type { LiveEvent, LiveEventsResult } from "@pesisselostaja/core";
import { CommentaryLoop, formatFetchDurations } from "../src/commentaryLoop.js";
import type { RelayConfig } from "../src/config.js";

const fetchMock = vi.mocked(fetchLiveEvents);

/** Issue #156: onnistuneen haun kestoa ei mitattu lainkaan, vain
 *  epäonnistuneen. Aikakatkaisuja viritettiin siksi kahdesti (#47, #81)
 *  pelkän jakauman hännän perusteella, ja kolmannella kerralla se johti
 *  väärään päätelmään. Nämä testit lukitsevat sen, että mittari mittaa
 *  oikeaa asiaa — ei sitä, mikä luku aikakatkaisu sattuu olemaan. */

function makeConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    matchId: 900001,
    youtubeUrl: "https://example.invalid/live",
    rtmpUrl: "", streamKey: "",
    voice: "harri-medium", piperBin: "piper",
    pollInterval: 3000, narrationGain: 1.3, narrationDelayMs: 0, firstSpeechDelayMs: 0,
    urlRefreshMs: 900000, maxFailureWindowMs: 720000, finishedFailureWindowMs: 120000, hardStopQuietMs: 180000,
    noSignalSlate: false, noSignalSlateAfterMs: 8000,
    noSignalSlateWidth: 1920, noSignalSlateHeight: 1080,
    deltaFetch: true,
    pollTrace: false, announceBatterChanges: true, dryRun: false,
    apiKey: "test", apiBase: "https://example.invalid/api",
    stateFile: "/tmp/pesis-test-nonexistent-state.json",
    runDir: "/tmp/",
    runRetentionDays: 0,
    ttsCacheMaxBytes: 0,
    pronunciationsFile: "/tmp/pesis-test-nonexistent-pron.json",
    controlFile: "/tmp/pesis-test-nonexistent-control.json",
    elevenLabsVoiceId: "x", elevenLabsModelId: "y",
    ...overrides,
  };
}

interface LoopInternals {
  fetchFullEvents(): Promise<LiveEventsResult>;
  fetchEventsForPoll(): Promise<LiveEventsResult | null>;
  maybeLogPollWindow(): void;
  lastPollSummaryAtMs: number;
  lastServerDateMs: number | null;
  lastFullFetchAt: number;
  history: { size: number };
  pollWindow: { fetchMs: { small: number[]; full: number[] }; failures: number };
}

function makeLoop(): LoopInternals {
  return new CommentaryLoop(makeConfig(), async () => {}) as unknown as LoopInternals;
}

// Fictional data only (public repo).
function ev(id: number): LiveEvent {
  return {
    id, groupType: "x", period: 0, inning: 0, batTurn: 0, team: 100, hTeam: 100,
    batter: null, pairIndex: null, hitNumber: null, hit: null,
    events: [], timestamp: 10, updated: null,
  };
}

function result(events: LiveEvent[] = []): LiveEventsResult {
  return { events, notModified: false, etag: null, serverDateMs: Date.parse("2026-07-31T10:00:00Z") };
}

beforeEach(() => fetchMock.mockReset());

describe("formatFetchDurations (#156)", () => {
  it("sanoo suoraan kun otos on tyhjä eikä esitä nollaa kestona", () => {
    // Tyhjä ikkuna on oikeasti mahdollinen: pelkkiä epäonnistumisia, tai
    // yhteenveto heti käynnistyksen jälkeen. "mediaani 0 ms" olisi valhe.
    expect(formatFetchDurations([])).toBe("ei onnistuneita hakuja");
  });

  it("raportoi MEDIAANIN eikä keskiarvoa, jottei yksi jumittunut haku piilota normaalitasoa", () => {
    // Tämä on koko mittarin pointti. 31.7.2026 ottelussa 145918 jakauma oli
    // kaksihuippuinen: ~100 ms tai yli 4000 ms. Keskiarvo tästä otoksesta
    // olisi 1075 ms — luku jota ei esiintynyt kertaakaan, ja joka olisi
    // saanut 4 s aikakatkaisun näyttämään perustellulta.
    const bimodal = [100, 100, 100, 4000];
    const formatted = formatFetchDurations(bimodal);
    expect(formatted).toContain("mediaani 100 ms");
    expect(formatted).toContain("max 4000 ms");
    expect(formatted).not.toContain("1075");
  });

  it("kertoo otoskoon, jotta lukua osaa painottaa", () => {
    expect(formatFetchDurations([5, 5, 5])).toContain("n=3");
  });

  it("ei riipu syötteen järjestyksestä eikä muuta sitä", () => {
    const samples = [300, 50, 200];
    const before = [...samples];
    expect(formatFetchDurations(samples)).toBe(formatFetchDurations([50, 200, 300]));
    expect(samples).toEqual(before);
  });
});

describe("pollWindow.fetchMs (#156)", () => {
  it("kirjaa onnistuneen haun keston", async () => {
    const loop = makeLoop();
    fetchMock.mockResolvedValueOnce(result());
    await loop.fetchFullEvents();
    expect(loop.pollWindow.fetchMs.full).toHaveLength(1);
    expect(loop.pollWindow.fetchMs.full[0]).toBeGreaterThanOrEqual(0);
    // Täyshaku EI saa päätyä pieneen otokseen: sitä säätelee eri raja.
    expect(loop.pollWindow.fetchMs.small).toEqual([]);
  });

  it("EI kirjaa epäonnistunutta hakua otokseen", async () => {
    // Regressio siitä, että ajanotto siirrettäisiin `finally`-lohkoon. Silloin
    // jokainen aikakatkaisu työntäisi otokseen tasan aikakatkaisun mittaisen
    // arvon, ja mittari alkaisi perustella itse sitä rajaa jota sen on
    // tarkoitus arvioida — sama kehäpäätelmä joka #156:n synnytti.
    const loop = makeLoop();
    fetchMock.mockRejectedValueOnce(new Error("This operation was aborted"));
    await expect(loop.fetchFullEvents()).rejects.toThrow("aborted");
    expect(loop.pollWindow.fetchMs.full).toEqual([]);
    expect(loop.pollWindow.fetchMs.small).toEqual([]);
  });

  it("kerää useamman haun samaan ikkunaan", async () => {
    const loop = makeLoop();
    fetchMock.mockResolvedValue(result());
    await loop.fetchFullEvents();
    await loop.fetchFullEvents();
    await loop.fetchFullEvents();
    expect(loop.pollWindow.fetchMs.full).toHaveLength(3);
  });

  it("mittaa DELTA-haun ja kirjaa sen pieneen otokseen", async () => {
    // Adversariaalinen katselmus 31.7.2026 huomautti, että alkuperäiset testit
    // ajoivat vain fetchFullEventsia: timedFetchin olisi voinut poistaa
    // delta-kutsusta ja sarja olisi pysynyt vihreänä — vaikka lähes kaikki
    // näytteet tulevat juuri sieltä (tyypillinen ikkuna: 304 5, delta 2,
    // täyshaku 0).
    const loop = makeLoop();
    // Delta vaatii palvelimen Date-leiman JA epätyhjän historian; ilman niitä
    // fetchEventsForPoll putoaa täyshakuun (ks. sen oma ehto). Historia
    // täytetään oikealla täyshaulla, koska `size` on vain getter.
    fetchMock.mockResolvedValueOnce(result([ev(1)]));
    await loop.fetchFullEvents();
    expect(loop.history.size).toBe(1);
    loop.lastFullFetchAt = Date.now();
    const fullBefore = loop.pollWindow.fetchMs.full.length;

    fetchMock.mockResolvedValueOnce({ ...result(), notModified: true });
    await loop.fetchEventsForPoll();

    expect(loop.pollWindow.fetchMs.small).toHaveLength(1);
    expect(loop.pollWindow.fetchMs.full).toHaveLength(fullBefore);
  });

  it("nollaa otoksen kun ikkuna raportoidaan, jottei se kasva ottelun mitassa", async () => {
    // Ajetaan fetchEventsForPollin kautta: maybeLogPollWindow palaa heti jos
    // `polls === 0`, ja laskuri kasvaa vain siellä. Suoraan fetchFullEventsia
    // kutsumalla nollausta ei testattaisi lainkaan.
    const loop = makeLoop();
    fetchMock.mockResolvedValue(result([ev(1)]));
    await loop.fetchEventsForPoll();
    await loop.fetchEventsForPoll();
    expect(loop.pollWindow.fetchMs.full.length + loop.pollWindow.fetchMs.small.length).toBeGreaterThan(0);

    // Pakota yhteenveto erääntymään.
    loop.lastPollSummaryAtMs = Date.now() - 60_000;
    loop.maybeLogPollWindow();

    expect(loop.pollWindow.fetchMs.full).toEqual([]);
    expect(loop.pollWindow.fetchMs.small).toEqual([]);
  });
});
