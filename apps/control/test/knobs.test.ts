// readKnobs/writeKnobs/nudgeDelay talk to the relay's own control file
// (run/.control-<matchId>.json, re-read by the live relay every poll — see
// apps/control/src/server/relay.ts). CONFIG.relayRunDir is redirected to a
// temp dir for every test, never the real apps/broadcast/run/.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG } from "../src/server/config.js";
import {
  controlFilePath,
  nudgeDelay,
  readKnobs,
  readSourceIngest,
  writeKnobs,
  writeSourceIngest,
} from "../src/server/relay.js";
import { DEFAULT_NARRATION_DELAY_MS } from "../../broadcast/src/config.js";

const MATCH_ID = 12345;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pesis-control-knobs-"));
  CONFIG.relayRunDir = tmpDir;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeControlFile(value: Record<string, unknown>): void {
  writeFileSync(controlFilePath(MATCH_ID), JSON.stringify(value));
}

function readControlFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(controlFilePath(MATCH_ID), "utf8")) as Record<string, unknown>;
}

describe("readKnobs", () => {
  it("returns defaults when the control file doesn't exist", async () => {
    const knobs = await readKnobs(MATCH_ID);
    expect(knobs).toEqual({
      announceBatterChanges: true,
      narrationDelayMs: DEFAULT_NARRATION_DELAY_MS,
      deltaFetch: true,
      pollIntervalMs: 3000,
    });
  });

  it("returns defaults when the control file is corrupt JSON", async () => {
    writeFileSync(controlFilePath(MATCH_ID), "{ not json");
    const knobs = await readKnobs(MATCH_ID);
    expect(knobs.narrationDelayMs).toBe(DEFAULT_NARRATION_DELAY_MS);
  });
});

describe("writeKnobs", () => {
  it("does a partial write: unrelated keys the relay owns survive untouched", async () => {
    // Simulate the relay having already written extra keys this build knows
    // nothing about (phase B: mute, volume) plus its current announce setting.
    writeControlFile({ announceBatterChanges: false, mute: true, volume: 0.8 });
    await writeKnobs(MATCH_ID, { pollIntervalMs: 5000 });
    const raw = readControlFile();
    expect(raw.mute).toBe(true);
    expect(raw.volume).toBe(0.8);
    expect(raw.announceBatterChanges).toBe(false);
    expect(raw.pollIntervalMs).toBe(5000);
  });

  it("overwrites only the keys present in the patch", async () => {
    writeControlFile({ announceBatterChanges: true, deltaFetch: true, pollIntervalMs: 3000 });
    const result = await writeKnobs(MATCH_ID, { deltaFetch: false });
    expect(result.deltaFetch).toBe(false);
    expect(result.announceBatterChanges).toBe(true);
  });

  it("creates a fresh control file when none exists", async () => {
    const result = await writeKnobs(MATCH_ID, { announceBatterChanges: false });
    expect(result.announceBatterChanges).toBe(false);
    expect(readControlFile().announceBatterChanges).toBe(false);
  });

  it("clamps narrationDelayMs to [0, 15000]", async () => {
    const tooHigh = await writeKnobs(MATCH_ID, { narrationDelayMs: 999_999 });
    expect(tooHigh.narrationDelayMs).toBe(15000);
    const tooLow = await writeKnobs(MATCH_ID, { narrationDelayMs: -500 });
    expect(tooLow.narrationDelayMs).toBe(0);
  });

  it("clamps pollIntervalMs to a 2000 ms floor", async () => {
    const result = await writeKnobs(MATCH_ID, { pollIntervalMs: 500 });
    expect(result.pollIntervalMs).toBe(2000);
  });

  it("clamps pollIntervalMs to a 60000 ms ceiling", async () => {
    const result = await writeKnobs(MATCH_ID, { pollIntervalMs: 500_000 });
    expect(result.pollIntervalMs).toBe(60_000);
  });
});

describe("nudgeDelay", () => {
  it("adds the delta to the current narrationDelayMs", async () => {
    await writeKnobs(MATCH_ID, { narrationDelayMs: 4000 });
    const result = await nudgeDelay(MATCH_ID, 500);
    expect(result.narrationDelayMs).toBe(4500);
  });

  it("clamps at the 15000 ms ceiling when nudging up near the limit", async () => {
    await writeKnobs(MATCH_ID, { narrationDelayMs: 14_800 });
    const result = await nudgeDelay(MATCH_ID, 500);
    expect(result.narrationDelayMs).toBe(15_000);
  });

  it("clamps at the 0 ms floor when nudging down near zero", async () => {
    await writeKnobs(MATCH_ID, { narrationDelayMs: 200 });
    const result = await nudgeDelay(MATCH_ID, -500);
    expect(result.narrationDelayMs).toBe(0);
  });

  it("starts from the default delay when nudging with no control file yet", async () => {
    const result = await nudgeDelay(MATCH_ID, 500);
    expect(result.narrationDelayMs).toBe(DEFAULT_NARRATION_DELAY_MS + 500);
  });
});

// --------------------------------------------------- lähteen tila (issue #104)
//
// Sama tiedosto, kaksi kirjoittajaa: operaattorin klikkaus (writeKnobs) ja
// ohjaamon 30 s välein kirjoittava lähteen tilan polleri (writeSourceIngest).
// Molempien on säilytettävä toisen avaimet — myös silloin kun kirjoitukset
// lähtevät samalla hetkellä.
describe("writeSourceIngest / readSourceIngest", () => {
  const INGEST = {
    observedAt: "2026-07-29T15:00:00.000Z",
    videoId: "SOURCEID123",
    lifeCycleStatus: "live",
    streamStatus: "active",
    healthStatus: "good",
    error: null,
  };

  it("säilyttää säätöavaimet ja relayn omat tuntemattomat avaimet", async () => {
    writeControlFile({ announceBatterChanges: false, narrationDelayMs: 4000, mute: true });
    await writeSourceIngest(MATCH_ID, INGEST);
    const raw = readControlFile();
    expect(raw.announceBatterChanges).toBe(false);
    expect(raw.narrationDelayMs).toBe(4000);
    expect(raw.mute).toBe(true);
    expect(raw.sourceIngest).toEqual(INGEST);
  });

  it("writeKnobs ei pudota sourceIngestiä", async () => {
    await writeSourceIngest(MATCH_ID, INGEST);
    await writeKnobs(MATCH_ID, { pollIntervalMs: 5000 });
    const raw = readControlFile();
    expect(raw.sourceIngest).toEqual(INGEST);
    expect(raw.pollIntervalMs).toBe(5000);
  });

  it("rinnakkaiset kirjoitukset eivät hukkaa päivitystä", async () => {
    // Ilman sarjallistusta molemmat lukisivat saman tyhjän tiedoston ja
    // jälkimmäinen rename pyyhkisi ensimmäisen avaimen kokonaan.
    await Promise.all([
      writeKnobs(MATCH_ID, { narrationDelayMs: 4500 }),
      writeSourceIngest(MATCH_ID, INGEST),
    ]);
    const raw = readControlFile();
    expect(raw.narrationDelayMs).toBe(4500);
    expect(raw.sourceIngest).toEqual(INGEST);
  });

  it("rinnakkaiset nudget lasketaan yhteen eikä lähtöarvoa lueta kahdesti", async () => {
    await writeKnobs(MATCH_ID, { narrationDelayMs: 4000 });
    await Promise.all([nudgeDelay(MATCH_ID, 500), nudgeDelay(MATCH_ID, 500)]);
    expect((await readKnobs(MATCH_ID)).narrationDelayMs).toBe(5000);
  });

  it("lukee kirjoitetun havainnon takaisin", async () => {
    await writeSourceIngest(MATCH_ID, INGEST);
    expect(await readSourceIngest(MATCH_ID)).toEqual(INGEST);
  });

  it("puuttuva, väärän tyyppinen tai rikkinäinen havainto on null, ei virhe", async () => {
    expect(await readSourceIngest(MATCH_ID)).toBeNull();

    writeControlFile({ announceBatterChanges: true });
    expect(await readSourceIngest(MATCH_ID)).toBeNull();

    writeControlFile({ sourceIngest: "ei objekti" });
    expect(await readSourceIngest(MATCH_ID)).toBeNull();

    // observedAt/videoId ovat pakolliset; ilman niitä havaintoa ei voi
    // tuoreuttaa eikä kohdistaa oikeaan videoon.
    writeControlFile({ sourceIngest: { videoId: "SOURCEID123" } });
    expect(await readSourceIngest(MATCH_ID)).toBeNull();
  });

  it("täydentää puuttuvat tilakentät nulliksi eikä keksi arvoja", async () => {
    writeControlFile({ sourceIngest: { observedAt: INGEST.observedAt, videoId: INGEST.videoId } });
    expect(await readSourceIngest(MATCH_ID)).toEqual({
      observedAt: INGEST.observedAt,
      videoId: INGEST.videoId,
      lifeCycleStatus: null,
      streamStatus: null,
      healthStatus: null,
      error: null,
    });
  });
});
