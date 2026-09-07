/** Hiljennys ja kirjaus myöhässä (#298).
 *
 *  Hiljennys on operaattorin tahtotila control-tiedostossa: speak() ajaa
 *  kirjanpitonsa mutta EI syntetisoi klippiä (≠ gain 0, joka syntetisoi ja
 *  vaimentaa). Kirjaus myöhässä johdetaan tulospalvelun ilmoittamasta
 *  alkuajasta: yli kynnyksen ilman yhtään tapahtumaa → tervetulotäyte pois.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { MatchMetadata } from "@pesisselostaja/core";
import { CommentaryLoop } from "../src/commentaryLoop.js";
import type { RelayConfig } from "../src/config.js";

const controlFile = "/tmp/pesis-test-control-silenced.json";

function makeConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    matchId: 900002,
    youtubeUrl: "https://example.invalid/live",
    rtmpUrl: "", streamKey: "",
    voice: "harri-medium", piperBin: "piper",
    pollInterval: 3000, narrationGain: 1.3, narrationDelayMs: 0, maxQueuedNarrationMs: 0, firstSpeechDelayMs: 0,
    urlRefreshMs: 900000, ytdlpExtractorArgs: "", maxFailureWindowMs: 720000,
    finishedFailureWindowMs: 120000, hardStopQuietMs: 180000, drainMaxMs: 0,
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
    controlFile,
    elevenLabsVoiceId: "x", elevenLabsModelId: "y",
    ...overrides,
  };
}

// Kuvitteelliset nimet — julkinen repo, ei koskaan oikeita kokoonpanoja.
function fakeMeta(date: string): MatchMetadata {
  return {
    id: 900002,
    date,
    home: { id: 1, name: "Kotipesä", shorthand: "KP", players: [], all_players: [] },
    away: { id: 2, name: "Lyöntilä", shorthand: "LT", players: [], all_players: [] },
    series: {},
    stadium: null,
    live: true,
    started: true,
  };
}

interface LoopInternals {
  refreshRuntimeControls(): Promise<void>;
  writeControlFile(): void;
  maybeAnnounceSummary(meta: MatchMetadata): Promise<void>;
  speak(text: string): void;
  silenced: boolean;
  recordingLate: boolean;
  meta: MatchMetadata | null;
  matchStarted: boolean;
  narrationEverReady: boolean;
  lastSpeechAt: number;
}

function makeLoop(sunk: string[], overrides: Partial<RelayConfig> = {}): LoopInternals {
  const loop = new CommentaryLoop(makeConfig(overrides), async (_spoken, readable) => {
    sunk.push(readable);
  }) as unknown as LoopInternals;
  loop.narrationEverReady = true;
  return loop;
}

/** Sink-kutsut valuvat synthQueuen kautta; yksi mikrotehtäväkierros riittää
 *  kun narrationDelayMs on 0. */
const drainQueue = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("hiljennys (#298)", () => {
  afterEach(() => rmSync(controlFile, { force: true }));

  it("estää synteesin mutta ajaa kirjanpidon", async () => {
    const sunk: string[] = [];
    const loop = makeLoop(sunk);
    writeFileSync(controlFile, JSON.stringify({ silenced: true }));
    await loop.refreshRuntimeControls();
    expect(loop.silenced).toBe(true);

    loop.speak("Palo! Kotipesä.");
    await drainQueue();
    // Klippiä ei syntetisoitu.
    expect(sunk).toEqual([]);

    // Mutta dedupe-kirjanpito eteni: sama teksti purun jälkeen on duplikaatti
    // eikä sitä puhuta — hiljennys ei saa nollata kirjanpitoa.
    writeFileSync(controlFile, JSON.stringify({ silenced: false }));
    await loop.refreshRuntimeControls();
    loop.speak("Palo! Kotipesä.");
    await drainQueue();
    expect(sunk).toEqual([]);
  });

  it("säilyy relayn restartin yli (#206-polku)", () => {
    writeFileSync(controlFile, JSON.stringify({ silenced: true }));
    const loop = makeLoop([]);
    loop.writeControlFile();
    expect(loop.silenced).toBe(true);
    expect(JSON.parse(readFileSync(controlFile, "utf8")).silenced).toBe(true);
  });

  it("purku kesken ottelun puhuu yhden tilannekatsauksen", async () => {
    const sunk: string[] = [];
    const loop = makeLoop(sunk);
    loop.meta = fakeMeta(new Date().toISOString());
    loop.matchStarted = true;

    writeFileSync(controlFile, JSON.stringify({ silenced: true }));
    await loop.refreshRuntimeControls();
    writeFileSync(controlFile, JSON.stringify({ silenced: false }));
    await loop.refreshRuntimeControls();
    await drainQueue();

    // Variantti vaihtelee; olennaista on että TASAN yksi tilannekatsaus puhuttiin.
    expect(sunk).toHaveLength(1);
    expect(sunk[0]).toMatch(/tilanne|tasatilanne/i);
  });

  it("purku ennen ottelun alkua ei puhu mitään (ei ole katsattavaa)", async () => {
    const sunk: string[] = [];
    const loop = makeLoop(sunk);
    loop.meta = fakeMeta(new Date().toISOString());

    writeFileSync(controlFile, JSON.stringify({ silenced: true }));
    await loop.refreshRuntimeControls();
    writeFileSync(controlFile, JSON.stringify({ silenced: false }));
    await loop.refreshRuntimeControls();
    await drainQueue();

    expect(sunk).toEqual([]);
  });

  it("hiljennettynä täytekierros ohitetaan ennen ajastuspäätöstä", async () => {
    const sunk: string[] = [];
    const loop = makeLoop(sunk);
    const meta = fakeMeta(new Date().toISOString());
    loop.meta = meta;
    writeFileSync(controlFile, JSON.stringify({ silenced: true }));
    await loop.refreshRuntimeControls();
    // lastSpeechAt kauas menneisyyteen: ilman hiljennystä tervetulotäyte
    // olisi erääntynyt.
    loop.lastSpeechAt = Date.now() - 10 * 60_000;
    await loop.maybeAnnounceSummary(meta);
    await drainQueue();
    expect(sunk).toEqual([]);
  });
});

describe("kirjaus myöhässä (#298)", () => {
  afterEach(() => rmSync(controlFile, { force: true }));

  it("laukeaa vasta kynnyksen jälkeen ja vain ilman tapahtumia", () => {
    const loop = makeLoop([]);
    // Ei metadataa → ei väitettä myöhästymisestä.
    expect(loop.recordingLate).toBe(false);

    loop.meta = fakeMeta(new Date(Date.now() - 20 * 60_000).toISOString());
    expect(loop.recordingLate).toBe(true);

    // Alkuaika vasta 5 min sitten — odottelu on vielä tervettä.
    loop.meta = fakeMeta(new Date(Date.now() - 5 * 60_000).toISOString());
    expect(loop.recordingLate).toBe(false);

    // Tapahtumia on → kirjaus käynnissä, myöhästymistila poistuu.
    loop.meta = fakeMeta(new Date(Date.now() - 20 * 60_000).toISOString());
    loop.matchStarted = true;
    expect(loop.recordingLate).toBe(false);
  });

  it("jäsentää tuotannon aikamuodon (Suomen aika offsetilla, ei UTC)", () => {
    // API antaa esim. "2026-08-05T18:00:00+03:00" — EI Z-päätettä. Väärä
    // UTC-oletus siirtäisi kynnystä kolme tuntia.
    const loop = makeLoop([]);
    const fmt = (ms: number) => {
      const d = new Date(ms + 3 * 3_600_000);
      return `${d.toISOString().slice(0, 19)}+03:00`;
    };
    loop.meta = fakeMeta(fmt(Date.now() - 20 * 60_000));
    expect(loop.recordingLate).toBe(true);
    loop.meta = fakeMeta(fmt(Date.now() - 5 * 60_000));
    expect(loop.recordingLate).toBe(false);
  });

  it("pudottaa tervetulotäytteen kun tila on päällä", async () => {
    const sunk: string[] = [];
    const loop = makeLoop(sunk);
    const meta = fakeMeta(new Date(Date.now() - 20 * 60_000).toISOString());
    loop.meta = meta;
    loop.lastSpeechAt = Date.now() - 10 * 60_000;
    await loop.maybeAnnounceSummary(meta);
    await drainQueue();
    expect(sunk).toEqual([]);
  });

  it("terve odottelu puhuu tervetulotäytteen normaalisti", async () => {
    const sunk: string[] = [];
    const loop = makeLoop(sunk);
    const meta = fakeMeta(new Date(Date.now() - 5 * 60_000).toISOString());
    loop.meta = meta;
    loop.lastSpeechAt = Date.now() - 10 * 60_000;
    await loop.maybeAnnounceSummary(meta);
    await drainQueue();
    expect(sunk).toHaveLength(1);
  });
});
