import { describe, it, expect, vi, afterEach } from "vitest";
import { unlink } from "node:fs/promises";
import { FfmpegMixer, SourceExhaustedError } from "../src/ffmpegMixer.js";
import { fakeFfmpeg } from "./fakeFfmpeg.js";

/** Issue #122: three telemetry fields lied at the same moment in match 145900
 *  (30.7.2026), and each one pointed the operator away from the real problem —
 *  the meter read healthy, the status row said ffmpeg was running, and the only
 *  warning blamed the one part of the chain that was fine.
 *
 *  These are mixer-level tests on purpose. `Telemetry` (telemetry.ts) copies
 *  the probe through verbatim, so a test there can only prove that a lie is
 *  faithfully transcribed; the values themselves are decided here. */

interface HonestyMixerOpts {
  fifoPath: string;
  lifetimesMs: number[];
  minProductiveRunMs: number;
  maxFailureWindowMs?: number;
  finishedFailureWindowMs?: number;
  matchFinished?: boolean;
  stderrLine?: string;
  exitCode?: number;
  onSessionEnd?: (at: number, ranMs: number) => void;
}

function honestyMixer(o: HonestyMixerOpts): FfmpegMixer {
  let index = 0;
  return new FfmpegMixer({
    youtubeUrl: "https://example.invalid/live",
    rtmpUrl: "",
    streamKey: "",
    narrationGain: 1.3,
    fifoPath: o.fifoPath,
    isMatchFinished: () => o.matchFinished ?? false,
    maxFailureWindowMs: o.maxFailureWindowMs ?? 10 * 60 * 1000,
    finishedFailureWindowMs: o.finishedFailureWindowMs ?? 10 * 60 * 1000,
    minProductiveRunMs: o.minProductiveRunMs,
    urlRefreshMs: 15 * 60 * 1000,
    // Note this replaces yt-dlp ONLY. Since #122 the state bookkeeping around
    // the resolve runs for the test seam too — without that, these tests would
    // exercise a state machine production never reaches, which is precisely
    // how the respawn counter stayed green in CI while reading 0 on the relay.
    resolveTestSource: () => "/dev/null",
    spawnMixerProcess: () => {
      const lifetime = o.lifetimesMs[Math.min(index, o.lifetimesMs.length - 1)]!;
      index++;
      return fakeFfmpeg(o.fifoPath, lifetime, o.stderrLine, o.exitCode ?? 0);
    },
    onSessionEnd: o.onSessionEnd,
  });
}

/** Resolves once `count` sessions have ended, plus a beat for the supervisor
 *  to react — judging on session count rather than wall clock keeps these
 *  tests off the machine's load. */
function afterSessions(seen: number[], count: number, graceMs = 200): Promise<void> {
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      if (seen.length >= count) {
        clearInterval(poll);
        setTimeout(resolve, graceMs);
      }
    }, 25);
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of ["a", "b", "c"]) {
    await unlink(`/tmp/pesis-test-honesty-${p}.pcm`).catch(() => undefined);
  }
});

describe("respawn counter (#122, part 1)", () => {
  it("counts every ffmpeg restart, so the meter moves while the picture stutters", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const sessions: number[] = [];
    const mixer = honestyMixer({
      fifoPath: "/tmp/pesis-test-honesty-a.pcm",
      // Long enough to count as real broadcast, so the relay keeps respawning
      // instead of giving up — the shape where a climbing counter is the whole
      // point.
      lifetimesMs: [300],
      minProductiveRunMs: 100,
      onSessionEnd: (_at, ranMs) => sessions.push(ranMs),
    });
    void mixer.start().catch(() => undefined);
    await afterSessions(sessions, 3);
    const counted = mixer.respawnCount;
    mixer.stop();

    // Three sessions = the first start plus two respawns. The old inference
    // (sessionIndex / respawns / sourceStateValue) yielded 0 here — every one
    // of its three signals was unavailable in the production configuration,
    // which is what `status-145900.json` reported after three logged respawns.
    expect(sessions.length).toBeGreaterThanOrEqual(3);
    expect(counted).toBeGreaterThanOrEqual(2);
    expect(counted).toBe(sessions.length - 1);
  }, 20000);
});

describe("source state while ffmpeg is not running (#122, part 2)", () => {
  it("stops claiming 'live' / 'ffmpeg käynnissä' the moment the session dies", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const sessions: number[] = [];
    const observed: { state: string; detail: string | null }[] = [];
    const mixer: FfmpegMixer = honestyMixer({
      fifoPath: "/tmp/pesis-test-honesty-b.pcm",
      lifetimesMs: [300],
      minProductiveRunMs: 100,
      onSessionEnd: (_at, ranMs) => {
        sessions.push(ranMs);
        // Sampled at the instant the session ended — the same instant the
        // snapshot was written in 145900, where it read live/"ffmpeg käynnissä"
        // next to a readerAttached:false in the very same file.
        observed.push({ state: mixer.sourceState, detail: mixer.sourceDetail });
      },
    });
    void mixer.start().catch(() => undefined);
    await afterSessions(sessions, 2);
    mixer.stop();

    expect(observed.length).toBeGreaterThanOrEqual(2);
    for (const o of observed) {
      expect(o.state).toBe("reconnecting");
      expect(o.state).not.toBe("live");
      expect(o.detail ?? "").not.toBe("ffmpeg käynnissä");
      expect(o.detail ?? "").toMatch(/ei ole käynnissä/i);
    }
  }, 20000);

  it("goes back to 'live' on the next successful attach", async () => {
    // The state has to be a description of now, not a latch: a healthy URL
    // rotation passes through reconnecting every 15 minutes and must come back
    // green on its own.
    vi.spyOn(console, "log").mockImplementation(() => {});
    const sessions: number[] = [];
    const mixer = honestyMixer({
      fifoPath: "/tmp/pesis-test-honesty-c.pcm",
      lifetimesMs: [300],
      minProductiveRunMs: 100,
      onSessionEnd: (_at, ranMs) => sessions.push(ranMs),
    });
    void mixer.start().catch(() => undefined);
    await afterSessions(sessions, 1);
    // Polled rather than sampled at a computed instant: the gaps are driven by
    // the doubling backoff, so any single sleep lands wherever the machine's
    // load puts it. The claim is "it comes back", not "it comes back at t+1.4s".
    let sawLive = false;
    for (let i = 0; i < 100 && !sawLive; i++) {
      if (mixer.sourceState === "live") sawLive = true;
      else await new Promise((r) => setTimeout(r, 50));
    }
    mixer.stop();
    expect(sawLive).toBe(true);
    expect(sessions.length).toBeGreaterThanOrEqual(1); // it really did respawn
  }, 20000);
});

describe("failure side on a clean exit (#122, part 3)", () => {
  it("blames nobody — and names the source ending — when ffmpeg exited 0", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // The 145900/145905 shape exactly: the phone stops, ffmpeg reads the tail
    // to EOF and exits 0, and the only stderr is the FLV muxer closing up.
    const err = await honestyMixer({
      fifoPath: "/tmp/pesis-test-honesty-a.pcm",
      lifetimesMs: [200],
      minProductiveRunMs: 10_000, // every session is unproductive
      finishedFailureWindowMs: 50, // → gives up on the second attempt
      matchFinished: true,
      stderrLine: "[flv @ 0x5581c0] Failed to update header with correct duration.",
      exitCode: 0,
      onSessionEnd: () => undefined,
    })
      .start()
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(SourceExhaustedError);
    const message = String((err as Error).message);
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");

    // The two sentences the operator actually read on 30.7. — the give-up
    // verdict and the warning line — must no longer send them to the target.
    expect(message).not.toMatch(/KOHTEESEEN/);
    expect(logged).not.toMatch(/tarkista stream key/i);
    expect(logged).toMatch(/syöte loppui/i);
  }, 20000);
});
