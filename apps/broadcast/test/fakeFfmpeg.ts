import { spawn, type ChildProcess } from "node:child_process";

/** Stand-in for ffmpeg (see docs/adr/0002-ffmpeg-mixer-process-seam.md): opens
 *  the narration FIFO as a reader — which is what completes FfmpegMixer's
 *  handshake and makes the attempt count as "started" — stays up for
 *  `lifetimeMs`, then exits. That is exactly the shape of the issue #45
 *  incident: the spawn succeeds, ffmpeg dies cleanly seconds later.
 *
 *  Shared by the give-up-window tests (#45/#51) and the telemetry-honesty
 *  tests (#122), which need the same process shape for opposite reasons.
 *
 *  `stderrLine` reproduces what ffmpeg prints in a given failure; stderr is
 *  piped only when a line is asked for, so the other tests stay quiet.
 *
 *  `exitCode` is load-bearing since #122: code=0 means ffmpeg read its input
 *  to EOF, so it can no longer be read as "the target refused us". A target
 *  that really refuses the push makes ffmpeg exit non-zero, and a test about
 *  that case has to say so or it is testing a process ffmpeg never produces.
 *  The SIGTERM trap still exits 0 — a scheduled refresh kill IS a clean stop. */
export function fakeFfmpeg(
  fifoPath: string,
  lifetimeMs: number,
  stderrLine?: string,
  exitCode = 0
): ChildProcess {
  const emit = stderrLine ? `printf '%s\\n' "$2" >&2; ` : "";
  const script =
    emit +
    `cat "$1" > /dev/null & reader=$!; ` +
    `trap 'kill $reader 2>/dev/null; exit 0' TERM; ` +
    `sleep ${lifetimeMs / 1000} & sleeper=$!; wait $sleeper; ` +
    `kill $reader 2>/dev/null; exit ${exitCode}`;
  return spawn("sh", ["-c", script, "sh", fifoPath, stderrLine ?? ""], {
    stdio: ["ignore", "ignore", stderrLine ? "pipe" : "ignore"],
  });
}
