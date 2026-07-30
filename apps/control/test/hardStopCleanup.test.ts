/** Hard stopin siivous (#123, vaihe 2).
 *
 *  Kun relay sammuttaa itsensä takarajan takia, kukaan ei enää lopeta
 *  YouTube-lähetyksiä — juuri se jätti ottelussa 145900 lähetyksen työntämään
 *  roskaa (#121). Laskeva reuna live.ts:ssä on ainoa aina päällä oleva
 *  havainnoija, joten siivous tehdään siellä.
 *
 *  Kaksi rajaa, jotka nämä testit vartioivat:
 *   - siivous tehdään VAIN kun relay kertoo `endReason === "hard_stop"`;
 *   - LÄHDElähetykseen kosketaan vain kun CONTROL_HARD_STOP_SOURCE on päällä.
 *
 *  Erillään runEnd.test.ts:stä tarkoituksella: se on tunnetusti herkkä
 *  ajastinkilpailulle, eikä sen mockeja haluta sotkea tähän.
 *  Joukkueiden nimet ovat keksittyjä (julkinen repo). */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, RelayProcess, RelayTelemetry } from "../src/shared/types.js";
import type { TransitionResult } from "../src/server/youtube.js";

let relayState: RelayProcess = {
  activeState: "inactive",
  active: false,
  uptimeSec: null,
  deployedCommit: null,
  nRestarts: 0,
};

vi.mock("../src/server/relay.js", () => ({
  getRelayProcess: vi.fn(async () => relayState),
  readKnobs: vi.fn(async () => ({
    announceBatterChanges: true,
    narrationDelayMs: 4000,
    deltaFetch: true,
    pollIntervalMs: 3000,
  })),
  readRunningMatchId: vi.fn(async () => null),
  writeSourceIngest: vi.fn(async () => undefined),
  readSourceIngest: vi.fn(async () => null),
}));
vi.mock("../src/server/journal.js", () => ({ readLog: vi.fn(async () => []) }));
vi.mock("../src/server/system.js", () => ({
  getSystemState: vi.fn(async () => ({
    diskFreeBytes: 10 * 1024 ** 3,
    diskTotalBytes: 30 * 1024 ** 3,
    diskCritical: false,
    memFreeBytes: 1024 ** 3,
    memTotalBytes: 4 * 1024 ** 3,
    load1: 0.5,
    cpuCount: 4,
  })),
}));
vi.mock("../src/server/matches.js", () => ({
  getMatchState: vi.fn(async () => {
    throw new Error("ei pollata testissä");
  }),
}));
// Ei koskaan oikeaa YouTube-API:a testistä: aggregaattori saa siivoajan
// injektiona, mutta moduuli ladataan silti importissa.
const forbidden = (name: string) =>
  vi.fn(async () => {
    throw new Error(`oikeaa YouTube-kutsua (${name}) ei saa tehdä testissä`);
  });
vi.mock("../src/server/youtube.js", () => ({
  transitionBroadcast: forbidden("transitionBroadcast"),
  // sourceIngest.ts nostaa nämä samasta moduulista; mock korvaa koko moduulin,
  // joten puuttuva export kaataisi importin.
  listBroadcasts: forbidden("listBroadcasts"),
  getStreamStatus: forbidden("getStreamStatus"),
}));

// Telemetria mockataan moduulitasolla, jottei aggregaattorin tikki tee YHTÄÄN
// oikeaa levyluentaa: fake-timerit eivät odota oikeaa I/O:ta, ja kesken jäävä
// tikki estää `fastBusy`-vahdin takia seuraavan — juuri se tekee
// runEnd.test.ts:stä ajoittain herkän. Siivouksen oma telemetrian luku
// injektoidaan erikseen (readTelemetry-optio).
vi.mock("../src/server/telemetry.js", () => ({
  readRelayStatus: vi.fn(async () => null),
  NarrationTimeline: class {
    async poll(): Promise<void> {}
    lines(): [] {
      return [];
    }
  },
}));

const { startLiveAggregator } = await import("../src/server/live.js");

const SOURCE_VIDEO_ID = "srcVIDEO123";
const TARGET_VIDEO_ID = "tgtVIDEO456";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    status: "live",
    createdAt: "2026-07-30T05:00:00.000Z",
    matchId: 145900,
    home: "Ketut",
    away: "Sudet",
    seriesName: null,
    stadium: null,
    startsAt: null,
    sourceUrl: `https://www.youtube.com/watch?v=${SOURCE_VIDEO_ID}`,
    targetStreamKey: "key",
    targetRtmpUrl: "rtmp://a.rtmp.youtube.com/live2",
    targetVideoId: TARGET_VIDEO_ID,
    startedAt: "2026-07-30T05:30:00.000Z",
    endedAt: null,
    note: null,
    ...overrides,
  };
}

function telemetry(endReason: RelayTelemetry["endReason"]): RelayTelemetry {
  return {
    at: "2026-07-30T06:27:00.000Z",
    matchId: 145900,
    startedAt: "2026-07-30T05:30:00.000Z",
    uptimeSec: 3522,
    readerAttached: false,
    pendingClips: 0,
    respawns: 3,
    source: { state: "no_signal", detail: "ffmpeg poistui heti" },
    match: { finished: true, eventCount: 412, lastEventAt: "2026-07-30T06:23:59.000Z" },
    narration: { detected: 90, spoken: 90, muted: 0, queued: 0 },
    tts: { engine: "piper", elevenLabsCharsUsed: 0 },
    lastProblem: null,
    endReason,
  };
}

function ok(videoId: string): TransitionResult {
  return { videoId, ok: true, skipped: false, reason: "lopetettu (live -> complete)", lifeCycleStatus: "live" };
}

async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5000);
}

/** Ajaa yhden laskevan reunan: relay ajossa -> relay poissa. */
async function runFallingEdge(options: {
  endReason: RelayTelemetry["endReason"];
  hardStopSource?: boolean;
  transition?: (videoId: string) => Promise<TransitionResult>;
}): Promise<{ transition: ReturnType<typeof vi.fn>; closeRunningJob: ReturnType<typeof vi.fn> }> {
  let active: Job | null = job();
  const closeRunningJob = vi.fn(async () => {
    const closed: Job = { ...(active as Job), status: "finished" };
    active = null;
    return closed;
  });
  const transition = vi.fn(options.transition ?? (async (videoId: string) => ok(videoId)));

  relayState = { ...relayState, activeState: "active", active: true };
  const live = startLiveAggregator({
    getActiveJob: async () => active,
    closeRunningJob,
    transitionBroadcast: transition,
    readTelemetry: async () => telemetry(options.endReason),
    hardStopSource: options.hardStopSource ?? false,
  });
  await tick();
  relayState = { ...relayState, activeState: "inactive", active: false };
  await tick();
  live.stop();
  return { transition, closeRunningJob };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("hard stop -siivous laskevalla reunalla", () => {
  it("lippu pois: kohde sammutetaan, lähteeseen EI kosketa", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { transition, closeRunningJob } = await runFallingEdge({
      endReason: "hard_stop",
      hardStopSource: false,
    });

    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledWith(TARGET_VIDEO_ID);
    expect(closeRunningJob).toHaveBeenCalledTimes(1);
    // Operaattorin on nähtävä lokista MIKSI lähteeseen ei koskettu.
    const skipLine = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(skipLine).toContain(SOURCE_VIDEO_ID);
    expect(skipLine).toContain("CONTROL_HARD_STOP_SOURCE");
  });

  it("lippu päällä: sekä kohde että lähde sammutetaan", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { transition } = await runFallingEdge({ endReason: "hard_stop", hardStopSource: true });

    expect(transition.mock.calls.map((c) => c[0])).toEqual([TARGET_VIDEO_ID, SOURCE_VIDEO_ID]);
  });

  it("normaali lopetus: ei transitiota lainkaan (enableAutoStop hoitaa kohteen)", async () => {
    const { transition, closeRunningJob } = await runFallingEdge({
      endReason: "ended",
      hardStopSource: true,
    });
    expect(transition).not.toHaveBeenCalled();
    expect(closeRunningJob).toHaveBeenCalledTimes(1);
  });

  it("vanha deploy joka ei kerro lopetussyytä: ei transitiota", async () => {
    const { transition } = await runFallingEdge({ endReason: null, hardStopSource: true });
    expect(transition).not.toHaveBeenCalled();
  });

  it("lähde ei ole omalla kanavalla: kohde sammuu ja lähteestä jää selkeä syy lokiin", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { transition, closeRunningJob } = await runFallingEdge({
      endReason: "hard_stop",
      hardStopSource: true,
      // Tyhjä id-haku = video ei ole omalla kanavalla. Siisti tulos, ei heitto.
      transition: async (videoId: string) =>
        videoId === SOURCE_VIDEO_ID
          ? {
              videoId,
              ok: false,
              skipped: true,
              reason: "lähetys ei ole tämän kanavan omistama (id-haku palautti tyhjän) — ei oikeutta lopettaa",
              lifeCycleStatus: null,
            }
          : ok(videoId),
    });

    expect(transition).toHaveBeenCalledTimes(2);
    expect(closeRunningJob).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("ei ole tämän kanavan omistama");
  });

  it("transitio kaatuu: työ suljetaan silti", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { transition, closeRunningJob } = await runFallingEdge({
      endReason: "hard_stop",
      hardStopSource: true,
      transition: async () => {
        throw new Error("YouTube API liveBroadcasts/transition -> HTTP 403");
      },
    });

    // Molemmat yritettiin, kumpikaan ei onnistunut — eikä työ jäänyt auki.
    expect(transition).toHaveBeenCalledTimes(2);
    expect(closeRunningJob).toHaveBeenCalledTimes(1);
  });
});
