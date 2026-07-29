import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseRelayConfig, DEFAULT_NARRATION_DELAY_MS } from "../src/config.js";

/** Env keys parseRelayConfig reads that must not leak in from the shell — the
 *  point of these tests is the built-in default, not the machine's .env. */
const ENV_KEYS = [
  "RELAY_NARRATION_DELAY_MS",
  "RELAY_POLL_INTERVAL",
  "RELAY_DRY_RUN",
  "RELAY_NO_SIGNAL_SLATE",
  "RELAY_NO_SIGNAL_SLATE_AFTER_MS",
];

const originalArgv = process.argv;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // --dry-run so the RTMP destination isn't required (see parseRelayConfig).
  process.argv = [
    "node",
    "relay.js",
    "--match-id", "900001",
    "--youtube-url", "https://example.invalid/live",
    "--dry-run",
  ];
});

afterEach(() => {
  process.argv = originalArgv;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("narration delay default (issue #53)", () => {
  it("is the live-calibrated 4000 ms, not the old 2000", () => {
    expect(DEFAULT_NARRATION_DELAY_MS).toBe(4000);
  });

  it("parseRelayConfig uses it when nothing overrides the delay", () => {
    expect(parseRelayConfig().narrationDelayMs).toBe(DEFAULT_NARRATION_DELAY_MS);
  });

  it("falls back to the default (not NaN) on an unparseable value", () => {
    process.env.RELAY_NARRATION_DELAY_MS = "kolme sekuntia";
    expect(parseRelayConfig().narrationDelayMs).toBe(DEFAULT_NARRATION_DELAY_MS);
  });

  it("still lets env/CLI override the default", () => {
    process.env.RELAY_NARRATION_DELAY_MS = "5000";
    expect(parseRelayConfig().narrationDelayMs).toBe(5000);
  });
});

describe("no-signal slate (issue #104)", () => {
  /** Oletus on POIS, ja se on tarkoituksellinen: katve on uusi ffmpeg-polku
   *  joka ajaa nimenomaan silloin kun lähetys on jo vaikeuksissa, eikä sitä
   *  ole koeteltu livenä. Ensimmäisen kokeilun on oltava tietoinen valinta. */
  it("is OFF unless RELAY_NO_SIGNAL_SLATE is exactly 'true'", () => {
    expect(parseRelayConfig().noSignalSlate).toBe(false);
    process.env.RELAY_NO_SIGNAL_SLATE = "1";
    expect(parseRelayConfig().noSignalSlate).toBe(false);
    process.env.RELAY_NO_SIGNAL_SLATE = "kylla";
    expect(parseRelayConfig().noSignalSlate).toBe(false);
  });

  it("turns on with RELAY_NO_SIGNAL_SLATE=true", () => {
    process.env.RELAY_NO_SIGNAL_SLATE = "true";
    expect(parseRelayConfig().noSignalSlate).toBe(true);
  });

  it("uses an 8 s threshold by default — a one-second blip must not flash the slate", () => {
    expect(parseRelayConfig().noSignalSlateAfterMs).toBe(8000);
  });

  it("lets the threshold be tuned, and ignores garbage", () => {
    process.env.RELAY_NO_SIGNAL_SLATE_AFTER_MS = "5000";
    expect(parseRelayConfig().noSignalSlateAfterMs).toBe(5000);
    process.env.RELAY_NO_SIGNAL_SLATE_AFTER_MS = "pian";
    expect(parseRelayConfig().noSignalSlateAfterMs).toBe(8000);
  });
});
