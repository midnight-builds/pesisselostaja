/** The relay shuts itself down when the source ends — nobody calls
 *  /api/relay/stop for a normal broadcast (uptime first: we never cut it). The
 *  live aggregator is the only always-on observer of that moment, so it is the
 *  one that has to let go of the broadcast slot (#101).
 *
 *  Everything the aggregator reads from the machine is mocked; the job store is
 *  injected through its options, the way the health tests already do. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, RelayProcess } from "../src/shared/types.js";

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
// The match poller must never reach the real pesistulokset API from a test.
vi.mock("../src/server/matches.js", () => ({
  getMatchState: vi.fn(async () => {
    throw new Error("ei pollata testissä");
  }),
}));

const { startLiveAggregator } = await import("../src/server/live.js");

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    status: "live",
    createdAt: "2026-07-29T09:00:00.000Z",
    matchId: 144980,
    home: "Ketut",
    away: "Sudet",
    seriesName: null,
    stadium: null,
    startsAt: null,
    sourceUrl: "https://youtube.com/x",
    targetStreamKey: "key",
    targetRtmpUrl: "rtmp://a.rtmp.youtube.com/live2",
    targetVideoId: null,
    startedAt: "2026-07-29T09:05:00.000Z",
    endedAt: null,
    note: null,
    ...overrides,
  };
}

/** One aggregator cycle: the poll interval plus the awaits inside it. */
async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5000);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("relay run starting", () => {
  it("stamps the armed job as running when the unit comes up", async () => {
    // Covers a hand-started relay too: the UI's start button and systemctl look
    // identical from here, and neither used to tell the job store anything.
    let active: Job = job({ status: "arming", startedAt: null });
    const markRunStarted = vi.fn(async () => {
      active = { ...active, status: "live", startedAt: "2026-07-29T09:05:00.000Z" };
      return active;
    });
    relayState = { ...relayState, activeState: "inactive", active: false };

    const live = startLiveAggregator({ getActiveJob: async () => active, markRunStarted });
    await tick();
    expect(markRunStarted).not.toHaveBeenCalled();

    relayState = { ...relayState, activeState: "active", active: true };
    await tick();
    expect(markRunStarted).toHaveBeenCalledTimes(1);
    expect(live.current().job).toMatchObject({ status: "live" });

    // A steady relay is not a new start on every poll.
    await tick();
    expect(markRunStarted).toHaveBeenCalledTimes(1);
    live.stop();
  });
});

describe("relay run ending", () => {
  it("closes the job when the relay goes away on its own", async () => {
    let active: Job | null = job();
    const closeRunningJob = vi.fn(async () => {
      const closed: Job = { ...(active as Job), status: "finished" };
      active = null;
      return closed;
    });

    relayState = { ...relayState, activeState: "active", active: true };
    const live = startLiveAggregator({ getActiveJob: async () => active, closeRunningJob });
    await tick();
    expect(closeRunningJob, "ei suljeta mitään niin kauan kuin relay on ajossa").not.toHaveBeenCalled();

    // The relay self-shuts down: unit goes inactive without anyone asking.
    relayState = { ...relayState, activeState: "inactive", active: false };
    await tick();
    expect(closeRunningJob).toHaveBeenCalledTimes(1);
    // The closed job stays on screen — the operator still wants to see which
    // run just ended; it simply no longer holds the slot.
    expect(live.current().job).toMatchObject({ status: "finished" });

    // And only once: the following polls see a slot that is already free.
    await tick();
    await tick();
    expect(closeRunningJob).toHaveBeenCalledTimes(1);
    live.stop();
  });

  it("leaves an armed job alone before the relay has ever started", async () => {
    // The normal pre-broadcast state: .env.relay written, unit not started yet.
    // Closing here would cancel the next broadcast before it began.
    const closeRunningJob = vi.fn(async () => null);
    relayState = { ...relayState, activeState: "inactive", active: false };

    const live = startLiveAggregator({
      getActiveJob: async () => job({ status: "arming", startedAt: null }),
      closeRunningJob,
    });
    await tick();
    await tick();
    expect(closeRunningJob).not.toHaveBeenCalled();
    live.stop();
  });

  it("does not close anything when the job is already finished", async () => {
    const closeRunningJob = vi.fn(async () => null);
    relayState = { ...relayState, activeState: "active", active: true };

    const live = startLiveAggregator({
      getActiveJob: async () => job({ status: "finished" }),
      closeRunningJob,
    });
    await tick();
    relayState = { ...relayState, activeState: "inactive", active: false };
    await tick();
    expect(closeRunningJob).not.toHaveBeenCalled();
    live.stop();
  });
});
