import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock ONLY the network call, like commentaryLoopDelta.test.ts does.
vi.mock("@pesisselostaja/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pesisselostaja/core")>();
  return { ...actual, fetchLiveEvents: vi.fn() };
});

import { fetchLiveEvents } from "@pesisselostaja/core";
import type { LiveEventsResult } from "@pesisselostaja/core";
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
  pollWindow: { fetchMs: number[]; failures: number };
}

function makeLoop(): LoopInternals {
  return new CommentaryLoop(makeConfig(), async () => {}) as unknown as LoopInternals;
}

function result(): LiveEventsResult {
  return { events: [], notModified: false, etag: null, serverDateMs: Date.parse("2026-07-31T10:00:00Z") };
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
    expect(loop.pollWindow.fetchMs).toHaveLength(1);
    expect(loop.pollWindow.fetchMs[0]).toBeGreaterThanOrEqual(0);
  });

  it("EI kirjaa epäonnistunutta hakua otokseen", async () => {
    // Regressio siitä, että ajanotto siirrettäisiin `finally`-lohkoon. Silloin
    // jokainen aikakatkaisu työntäisi otokseen tasan aikakatkaisun mittaisen
    // arvon, ja mittari alkaisi perustella itse sitä rajaa jota sen on
    // tarkoitus arvioida — sama kehäpäätelmä joka #156:n synnytti.
    const loop = makeLoop();
    fetchMock.mockRejectedValueOnce(new Error("This operation was aborted"));
    await expect(loop.fetchFullEvents()).rejects.toThrow("aborted");
    expect(loop.pollWindow.fetchMs).toEqual([]);
  });

  it("kerää useamman haun samaan ikkunaan", async () => {
    const loop = makeLoop();
    fetchMock.mockResolvedValue(result());
    await loop.fetchFullEvents();
    await loop.fetchFullEvents();
    await loop.fetchFullEvents();
    expect(loop.pollWindow.fetchMs).toHaveLength(3);
  });
});
