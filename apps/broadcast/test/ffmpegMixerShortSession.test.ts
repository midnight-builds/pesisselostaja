import { describe, it, expect, vi, afterEach } from "vitest";
import { unlink } from "node:fs/promises";
import { FfmpegMixer, SourceExhaustedError } from "../src/ffmpegMixer.js";
import { fakeFfmpeg } from "./fakeFfmpeg.js";

interface SessionMixerOpts {
  fifoPath: string;
  /** Lifetime of the n:th fake ffmpeg session, in ms; the last value repeats. */
  lifetimesMs: number[];
  minProductiveRunMs: number;
  finishedFailureWindowMs: number;
  maxFailureWindowMs?: number;
  urlRefreshMs?: number;
  stderrLine?: string;
  /** Exit code of every fake session; 0 (clean EOF) unless a test says
   *  otherwise. See fakeFfmpeg. */
  exitCode?: number;
  sessions: number[];
}

function sessionMixer(o: SessionMixerOpts): FfmpegMixer {
  let index = 0;
  return new FfmpegMixer({
    youtubeUrl: "https://example.invalid/live",
    rtmpUrl: "", streamKey: "",
    narrationGain: 1.3,
    fifoPath: o.fifoPath,
    // The match is over in these tests, so the SHORT give-up window applies —
    // that is the window the operator's runbook promises will end the relay.
    isMatchFinished: () => true,
    finishedFailureWindowMs: o.finishedFailureWindowMs,
    maxFailureWindowMs: o.maxFailureWindowMs ?? 10 * 60 * 1000,
    minProductiveRunMs: o.minProductiveRunMs,
    urlRefreshMs: o.urlRefreshMs ?? 15 * 60 * 1000,
    // Never actually read: the fake process ignores the argv it is handed.
    resolveTestSource: () => "/dev/null",
    spawnMixerProcess: () => {
      const lifetime = o.lifetimesMs[Math.min(index, o.lifetimesMs.length - 1)]!;
      index++;
      return fakeFfmpeg(o.fifoPath, lifetime, o.stderrLine, o.exitCode ?? 0);
    },
    onSessionEnd: (_at, ranMs) => o.sessions.push(ranMs),
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of ["a", "b", "c", "d", "e"]) {
    await unlink(`/tmp/pesis-test-short-session-${p}.pcm`).catch(() => undefined);
  }
});

describe("FfmpegMixer give-up window when ffmpeg starts but dies immediately (issue #45)", () => {
  it("gives up after repeated clean code=0 exits seconds after start-up", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const sessions: number[] = [];
    const mixer = sessionMixer({
      fifoPath: "/tmp/pesis-test-short-session-a.pcm",
      lifetimesMs: [200],
      minProductiveRunMs: 10_000, // every 200 ms session is unproductive
      finishedFailureWindowMs: 50, // → the second unproductive attempt gives up
      sessions,
    });
    try {
      // Before the fix this never resolved: each successful spawn cleared
      // failingSince, so the window never accrued and the loop respawned
      // forever (the operator had to stop the service by hand).
      await expect(mixer.start()).rejects.toThrow(SourceExhaustedError);
    } finally {
      mixer.stop();
    }
    expect(sessions.length).toBeGreaterThanOrEqual(2); // it really did run sessions
    expect(Math.max(...sessions)).toBeLessThan(10_000);
    // The verdict must name the real reason. ffmpeg started every time, so
    // neither the start-up-failure log line nor its "ei ole vastannut"
    // wording may appear (they did while the give-up error leaked into
    // start()'s own catch block).
    await expect(sessionMixer({
      fifoPath: "/tmp/pesis-test-short-session-a.pcm",
      lifetimesMs: [200], minProductiveRunMs: 10_000, finishedFailureWindowMs: 50, sessions: [],
    }).start()).rejects.toThrow(/kuolleet alle 10 sekunnissa/);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("ffmpeg-käynnistysvirhe");
  }, 20000);

  it("does NOT give up on a healthy run that crashes — it just respawns", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const sessions: number[] = [];
    const mixer = sessionMixer({
      fifoPath: "/tmp/pesis-test-short-session-b.pcm",
      lifetimesMs: [400],
      minProductiveRunMs: 100, // 400 ms counts as real broadcast here
      // Absurdly short windows in BOTH modes: a productive run must never
      // accrue toward them, or a normal crash-and-respawn would shut the
      // relay down mid-match.
      finishedFailureWindowMs: 50,
      maxFailureWindowMs: 50,
      sessions,
    });
    const outcome = await Promise.race([
      mixer.start().then(() => "resolved", (e) => (e instanceof SourceExhaustedError ? "gave-up" : "other-error")),
      new Promise<string>((r) => setTimeout(() => r("still-running"), 3000)),
    ]);
    mixer.stop();
    expect(outcome).toBe("still-running");
    expect(sessions.length).toBeGreaterThanOrEqual(2); // respawn still works
  }, 20000);

  it("clears the window when the source comes back, so a later blip starts fresh", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const sessions: number[] = [];
    // Settles a moment after the 4th session's exit, i.e. after the supervisor
    // has had its chance to give up on it.
    const afterFourthSession = new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (sessions.length >= 4) {
          clearInterval(poll);
          setTimeout(resolve, 300);
        }
      }, 50);
    });
    const mixer = sessionMixer({
      fifoPath: "/tmp/pesis-test-short-session-c.pcm",
      // two dead sessions, then the source returns for a real run, then it
      // blips again — the blip must start a NEW window, not inherit the old.
      lifetimesMs: [100, 100, 600, 100],
      minProductiveRunMs: 300,
      finishedFailureWindowMs: 2500,
      sessions,
    });
    // Judged on session count, not wall clock: the verdict lands right after
    // the 4th (post-recovery) session ends. Without the reset that session's
    // window would still count from the first dead one — several seconds, well
    // past 2.5 s — and the relay would shut itself down although the source
    // had come back in between.
    const outcome = await Promise.race([
      mixer.start().then(() => "resolved", (e) => (e instanceof SourceExhaustedError ? "gave-up" : "other-error")),
      afterFourthSession.then(() => "still-running"),
    ]);
    mixer.stop();
    expect(outcome).toBe("still-running");
    expect(sessions.length).toBeGreaterThanOrEqual(4);
    expect(sessions.some((ms) => ms >= 300)).toBe(true); // the source did come back
  }, 25000);

  it("blames the TARGET, not the source, when ffmpeg's errors came from RTMP (issue #51)", async () => {
    // The 145164 shape: the push is refused (wrong stream key / another encoder
    // on the same key), so ffmpeg starts, errors and dies in seconds — exactly
    // the same session shape a dead phone produces. Since issue #45's fix makes
    // those short runs accrue toward the give-up window, the relay shuts down;
    // without this classification it would shut down blaming the source and
    // send the operator to check the phone.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const err = await sessionMixer({
        fifoPath: "/tmp/pesis-test-short-session-e.pcm",
        lifetimesMs: [200],
        minProductiveRunMs: 10_000,
        finishedFailureWindowMs: 50,
        stderrLine: "[rtmp @ 0x55f1a0] Server error: Authentication Failed.",
        // Non-zero, because that is what a refused push does. Held at 0 this
        // test would now (correctly, #122) get no verdict at all.
        exitCode: 1,
        sessions: [],
      }).start().then(() => null, (e) => e);

      expect(err).toBeInstanceOf(SourceExhaustedError);
      expect(String((err as Error).message)).toMatch(/KOHTEESEEN/);
      const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toMatch(/stream key/i);
    } finally {
      logSpy.mockRestore();
    }
  }, 20000);

  it("clears the window on a healthy session that ends in OUR OWN scheduled URL refresh", async () => {
    // The production case: urlRefreshMs (15 min) > maxFailureWindowMs (12 min),
    // so on a perfectly healthy source EVERY session ends in a refresh kill. If
    // a refresh kill were treated as neutral before checking the run length, a
    // failingSince set by one early blip would never be cleared again and the
    // next brief blip — hours later, mid-match — would shut the relay down.
    vi.spyOn(console, "log").mockImplementation(() => {});
    const sessions: number[] = [];
    const afterThirdSession = new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (sessions.length >= 3) {
          clearInterval(poll);
          setTimeout(resolve, 300);
        }
      }, 50);
    });
    const mixer = sessionMixer({
      fifoPath: "/tmp/pesis-test-short-session-d.pcm",
      // blip → long healthy session (cut short only by the refresh) → blip.
      // The 20 s lifetime is never reached: the refresh kills it at ~0.9 s
      // (urlRefreshMs + the mixer's 500 ms drain grace).
      lifetimesMs: [100, 20_000, 100],
      urlRefreshMs: 400,
      minProductiveRunMs: 500,
      finishedFailureWindowMs: 1500,
      sessions,
    });
    const outcome = await Promise.race([
      mixer.start().then(() => "resolved", (e) => (e instanceof SourceExhaustedError ? "gave-up" : "other-error")),
      afterThirdSession.then(() => "still-running"),
    ]);
    mixer.stop();
    expect(outcome).toBe("still-running");
    expect(sessions[1]).toBeGreaterThanOrEqual(500); // the refresh-killed run was healthy
    expect(sessions[1]).toBeLessThan(20_000); // …and it really was the refresh that ended it
  }, 25000);
});
