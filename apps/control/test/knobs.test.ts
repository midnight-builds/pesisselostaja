// readKnobs/writeKnobs/nudgeDelay talk to the relay's own control file
// (run/.control-<matchId>.json, re-read by the live relay every poll — see
// apps/control/src/server/relay.ts). CONFIG.relayRunDir is redirected to a
// temp dir for every test, never the real apps/broadcast/run/.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG } from "../src/server/config.js";
import { controlFilePath, nudgeDelay, readKnobs, writeKnobs } from "../src/server/relay.js";
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
