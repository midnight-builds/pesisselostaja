import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, rmSync, readFileSync } from "node:fs";
import { CommentaryLoop } from "../src/commentaryLoop.js";
import type { RelayConfig } from "../src/config.js";

/** Vartijatesti (#309): JOKAINEN operaattorin control-tiedostoon asettama
 *  säätö säilyy relayn restartin yli — ei vain ne joille on oma testi.
 *
 *  Ainoa tapa hukata operaattorin arvo on lisätä avain writeControlFilen
 *  values-objektiin ILMAN applyControlValues-käsittelyä: silloin relayn
 *  config-oletus jyrää operaattorin arvon käynnistyksessä. Tämä testi johtaa
 *  avainjoukon koodista itsestään (writeControlFilen kirjoittamasta
 *  tiedostosta), joten uusi avain tulee vartioiduksi ilman että kenenkään
 *  tarvitsee muistaa lisätä sitä tänne. */

const controlFile = "/tmp/pesis-test-control-restart.json";

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

interface LoopInternals {
  writeControlFile(): void;
}

function makeLoop(): LoopInternals {
  return new CommentaryLoop(makeConfig(), async () => {}) as unknown as LoopInternals;
}

function readControlFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(controlFile, "utf8")) as Record<string, unknown>;
}

/** Operaattorin arvo, joka eroaa oletuksesta ja kestää kelpuutuksen
 *  normalisoimatta: boolean käännetään, luku pysyy clampien sisällä
 *  (narrationGain ≤ 4, pollIntervalMs ≥ 2000) ja kokonaislukuna
 *  (Math.round ei muuta sitä). */
function operatorValueFor(key: string, defaultValue: unknown): unknown {
  if (typeof defaultValue === "boolean") return !defaultValue;
  if (typeof defaultValue === "number") {
    if (key === "narrationGain") return 0.7;
    return Math.round(defaultValue) * 2 + 100;
  }
  throw new Error(`Avaimelle ${key} (tyyppi ${typeof defaultValue}) ei ole operaattoriarvoa — laajenna operatorValueFor.`);
}

describe("control-avainten restart-säilyvyys (#309)", () => {
  afterEach(() => rmSync(controlFile, { force: true }));

  it("jokainen writeControlFilen kirjoittama avain säilyy operaattorin arvossa restartin yli", () => {
    // 1. ajo puhtaalta pöydältä paljastaa avainjoukon ja oletusarvot.
    makeLoop().writeControlFile();
    const defaults = readControlFile();
    expect(Object.keys(defaults).length).toBeGreaterThanOrEqual(6);

    // "Operaattori" säätää joka avainta pois oletuksesta...
    const operatorValues = Object.fromEntries(
      Object.entries(defaults).map(([key, value]) => [key, operatorValueFor(key, value)])
    );
    writeFileSync(controlFile, JSON.stringify(operatorValues));

    // ...ja relay käynnistyy uudelleen. Restart ei saa palauttaa yhtäkään
    // arvoa oletukseen — kesken ottelun tehty säätö on tuoreinta tietoa.
    makeLoop().writeControlFile();
    const afterRestart = readControlFile();
    for (const [key, operatorValue] of Object.entries(operatorValues)) {
      expect(afterRestart[key], `avain ${key} ei säilynyt restartin yli`).toBe(operatorValue);
    }
    // Eikä yksikään avain katoa tai ilmesty ohimennen.
    expect(Object.keys(afterRestart).sort()).toEqual(Object.keys(defaults).sort());
  });

  it("tarkoituksellinen poikkeus: katkaisijan jälki nollataan käynnistyksessä (#52)", () => {
    // deltaFetch: false YHDESSÄ deltaBreakerTripped-merkinnän kanssa on relayn
    // oma kirjaus, ei operaattorin valinta — restart palauttaa deltan configin
    // arvoon eikä jätä merkintää kummittelemaan seuraavaan ajoon.
    writeFileSync(controlFile, JSON.stringify({ deltaFetch: false, deltaBreakerTripped: true }));
    makeLoop().writeControlFile();
    const afterRestart = readControlFile();
    expect(afterRestart.deltaFetch).toBe(true);
    expect(afterRestart).not.toHaveProperty("deltaBreakerTripped");
  });

  it("tuntemattomat avaimet (esim. ohjaamon sourceIngest) säilyvät käynnistyskirjoituksessa", () => {
    writeFileSync(controlFile, JSON.stringify({ sourceIngest: { videoId: "abc" }, tulevaAvain: 42 }));
    makeLoop().writeControlFile();
    const afterRestart = readControlFile();
    expect(afterRestart.sourceIngest).toEqual({ videoId: "abc" });
    expect(afterRestart.tulevaAvain).toBe(42);
  });
});
