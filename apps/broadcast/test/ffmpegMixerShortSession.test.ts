import { describe, it, expect, vi, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { unlink } from "node:fs/promises";
import { FfmpegMixer, SourceExhaustedError } from "../src/ffmpegMixer.js";

/** Stand-in for ffmpeg (see docs/adr/0002-ffmpeg-mixer-process-seam.md): opens
 *  the narration FIFO as a reader — which is what completes FfmpegMixer's
 *  handshake and makes the attempt count as "started" — stays up for
 *  `lifetimeMs`, then exits with code 0. That is exactly the shape of the
 *  issue #45 incident: the spawn succeeds, ffmpeg dies cleanly seconds later. */
function fakeFfmpeg(fifoPath: string, lifetimeMs: number): ChildProcess {
  const script = `cat "$1" > /dev/null & reader=$!; sleep ${lifetimeMs / 1000}; kill $reader 2>/dev/null; exit 0`;
  return spawn("sh", ["-c", script, "sh", fifoPath], { stdio: ["ignore", "ignore", "ignore"] });
}

interface SessionMixerOpts {
  fifoPath: string;
  /** Lifetime of the n:th fake ffmpeg session, in ms; the last value repeats. */
  lifetimesMs: number[];
  minProductiveRunMs: number;
  finishedFailureWindowMs: number;
  maxFailureWindowMs?: number;
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
    // Never actually read: the fake process ignores the argv it is handed.
    resolveTestSource: () => "/dev/null",
    spawnMixerProcess: () => {
      const lifetime = o.lifetimesMs[Math.min(index, o.lifetimesMs.length - 1)]!;
      index++;
      return fakeFfmpeg(o.fifoPath, lifetime);
    },
    onSessionEnd: (_at, ranMs) => o.sessions.push(ranMs),
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of ["a", "b", "c"]) {
    await unlink(`/tmp/pesis-test-short-session-${p}.pcm`).catch(() => undefined);
  }
});

describe("FfmpegMixer give-up window when ffmpeg starts but dies immediately (issue #45)", () => {
  it("gives up after repeated clean code=0 exits seconds after start-up", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
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
});
