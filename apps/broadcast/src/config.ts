import { parseArgs } from "node:util";
import { DEFAULT_RETENTION_DAYS, DEFAULT_TTS_CACHE_MAX_MB } from "./runRetention.js";

export interface RelayConfig {
  matchId: number;
  youtubeUrl: string;
  rtmpUrl: string;
  streamKey: string;
  voice: string;
  piperBin: string;
  pollInterval: number;
  narrationGain: number;
  /** Artificial delay (ms) inserted between detecting an event and handing its
   *  narration to synthesis, so speech lands after the corresponding video
   *  instead of ahead of it once the API skip-delay shortened the feed lag.
   *  Default DEFAULT_NARRATION_DELAY_MS. Runtime-overridable
   *  via the control file — see commentaryLoop. */
  narrationDelayMs: number;
  /** Don't speak until ffmpeg has been attached this long, measured from the
   *  FIRST attach ever (not relay start — the source can go live minutes
   *  later), so early viewers have time to join before the first line.
   *  0 = off. Only affects the start of the run;
   *  respawns after the first attach add no new delay. */
  firstSpeechDelayMs: number;
  urlRefreshMs: number;
  maxFailureWindowMs: number;
  /** Shorter give-up window used instead of maxFailureWindowMs once the match
   *  has finished — retrying a dead source for 12 min after "Ottelu päättyi"
   *  only delays cleanup. */
  finishedFailureWindowMs: number;
  /** Delta polling (after= + ETag) on by default; RELAY_DELTA_FETCH=false or
   *  the control file's deltaFetch key flips back to full fetches live. */
  deltaFetch: boolean;
  announceBatterChanges: boolean;
  dryRun: boolean;
  recordFile?: string;
  apiKey: string;
  apiBase: string;
  stateFile: string;
  runDir: string;
  /** run/ retention (issue #39): relay-owned artifacts older than this many
   *  days are swept on startup. 0 = off. Only touches the relay's own
   *  filename patterns — see runRetention.ts. */
  runRetentionDays: number;
  /** Size ceiling for run/tts-cache/ in bytes; least-recently-used clips are
   *  evicted above it. 0 = off. */
  ttsCacheMaxBytes: number;
  pronunciationsFile: string;
  /** JSON file the commentary loop re-reads each poll so an operator can flip
   *  announceBatterChanges mid-match without restarting — see commentaryLoop. */
  controlFile: string;
  /** When set, ElevenLabs is the primary TTS engine and Piper the fallback. */
  elevenLabsApiKey?: string;
  elevenLabsVoiceId: string;
  elevenLabsModelId: string;
}

/** Default artificial narration delay (ms) — the gap between detecting an event
 *  and handing its narration to synthesis, so speech lands just after the video
 *  instead of ahead of it.
 *
 *  4000 ms, not the earlier 2000: every live-calibrated match has needed the
 *  operator to raise it by hand mid-broadcast (one match settled on 4000 ms, a
 *  later run on 5000 ms), so 2000 only meant every broadcast started with
 *  speech running ahead of the picture until someone noticed (issue #53).
 *  4000 is the value confirmed live and is the conservative end of what
 *  calibration has produced. Still runtime-adjustable without a restart via the
 *  control file's `narrationDelayMs` (and at startup via
 *  `RELAY_NARRATION_DELAY_MS` / `--narration-delay-ms`). */
export const DEFAULT_NARRATION_DELAY_MS = 4000;

function requireValue(name: string, cliValue: string | undefined, envName: string): string {
  const value = cliValue ?? process.env[envName];
  if (!value) {
    console.error(`Error: ${name} is required (--${name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())} or ${envName})`);
    process.exit(1);
  }
  return value;
}

/** Env override that falls back to the default on garbage or negative input —
 *  a typo must never turn retention into an aggressive or NaN-driven sweep. */
function nonNegativeNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function parseRelayConfig(): RelayConfig {
  const { values } = parseArgs({
    options: {
      "match-id": { type: "string" },
      "youtube-url": { type: "string" },
      "rtmp-url": { type: "string" },
      "stream-key": { type: "string" },
      "voice": { type: "string" },
      "piper-bin": { type: "string" },
      "poll-interval": { type: "string" },
      "narration-gain": { type: "string" },
      "narration-delay-ms": { type: "string" },
      "url-refresh-ms": { type: "string" },
      "max-failure-window-ms": { type: "string" },
      "no-batter-changes": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "record-file": { type: "string" },
    },
    strict: true,
  });

  const matchIdStr = requireValue("matchId", values["match-id"], "RELAY_MATCH_ID");
  const matchId = parseInt(matchIdStr, 10);
  if (isNaN(matchId)) {
    console.error("Error: invalid --match-id / RELAY_MATCH_ID");
    process.exit(1);
  }

  const dryRun = values["dry-run"] || process.env.RELAY_DRY_RUN === "true";
  const recordFile = values["record-file"] ?? process.env.RELAY_RECORD_FILE;

  const youtubeUrl = requireValue("youtubeUrl", values["youtube-url"], "RELAY_YOUTUBE_URL");

  // The RTMP destination is only needed once we actually push a stream, so
  // dry runs (never touch ffmpeg/RTMP) and local-file record tests (write to
  // recordFile instead) don't need to supply it.
  const skipRtmpRequirement = dryRun || !!recordFile;
  const rtmpUrl = skipRtmpRequirement
    ? (values["rtmp-url"] ?? process.env.RELAY_RTMP_URL ?? "")
    : requireValue("rtmpUrl", values["rtmp-url"], "RELAY_RTMP_URL");
  const streamKey = skipRtmpRequirement
    ? (values["stream-key"] ?? process.env.RELAY_STREAM_KEY ?? "")
    : requireValue("streamKey", values["stream-key"], "RELAY_STREAM_KEY");

  const voice = values.voice ?? process.env.RELAY_VOICE ?? "harri-medium";
  const piperBin = values["piper-bin"] ?? process.env.RELAY_PIPER_BIN ?? "piper";
  // 3000 ms (was 4000): the delta+ETag path makes a tighter poll cheap, and
  // the server-side response cache is ~5 s anyway. Runtime-adjustable via the
  // control file's pollIntervalMs (min 2000 — see commentaryLoop).
  const pollInterval = parseInt(values["poll-interval"] ?? process.env.RELAY_POLL_INTERVAL ?? "3000", 10);
  const narrationGain = parseFloat(values["narration-gain"] ?? process.env.RELAY_NARRATION_GAIN ?? "1.3");
  // Artificial narration delay, see DEFAULT_NARRATION_DELAY_MS.
  // A bad value falls back to the default rather than NaN (which would make
  // every wait computation NaN).
  const narrationDelayRaw = parseInt(
    values["narration-delay-ms"] ?? process.env.RELAY_NARRATION_DELAY_MS ?? String(DEFAULT_NARRATION_DELAY_MS),
    10
  );
  const narrationDelayMs = Number.isNaN(narrationDelayRaw)
    ? DEFAULT_NARRATION_DELAY_MS
    : Math.max(0, narrationDelayRaw);
  // ~20 s grace from the FIRST ffmpeg attach before anything is spoken, so
  // viewers have time to open the stream. 0 = off.
  const firstSpeechDelayRaw = parseInt(process.env.RELAY_FIRST_SPEECH_DELAY_MS ?? "20000", 10);
  const firstSpeechDelayMs = Number.isNaN(firstSpeechDelayRaw) ? 20000 : Math.max(0, firstSpeechDelayRaw);
  const urlRefreshMs = parseInt(values["url-refresh-ms"] ?? process.env.RELAY_URL_REFRESH_MS ?? String(15 * 60 * 1000), 10);
  // How long resolveSourceUrl/ffmpeg-start may fail continuously before the
  // relay gives up and shuts down (see SourceExhaustedError). Kept generous
  // by default so a relay started a few minutes ahead of the phone's
  // announced go-live time doesn't give up before the source ever appears.
  const maxFailureWindowMs = parseInt(
    values["max-failure-window-ms"] ?? process.env.RELAY_MAX_FAILURE_WINDOW_MS ?? String(12 * 60 * 1000),
    10
  );
  // Once the match has finished, keeping the process up for the full generous
  // window is pointless — give up much sooner.
  const finishedFailureWindowMs = parseInt(
    process.env.RELAY_FINISHED_FAILURE_WINDOW_MS ?? String(2 * 60 * 1000),
    10
  );
  // Delta polling on by default (user decision); env or the control file's
  // deltaFetch key turns it off without a restart.
  const deltaFetch = process.env.RELAY_DELTA_FETCH !== "false";
  // Off if either the CLI flag or the env var says so; the control file (see
  // commentaryLoop) can still override this live once the loop is running.
  const announceBatterChanges =
    !(values["no-batter-changes"] ?? false) && process.env.RELAY_ANNOUNCE_BATTER_CHANGES !== "false";
  const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY || undefined;
  // Daniel — valittu kuuntelemalla 2026-07-15 (ks. ~/projects/elevenlabs-aanitestit/)
  const elevenLabsVoiceId = process.env.RELAY_ELEVENLABS_VOICE ?? "onwK4e9ZLuTAKqWW03F9";
  const elevenLabsModelId = process.env.RELAY_ELEVENLABS_MODEL ?? "eleven_multilingual_v2";
  const apiKey = process.env.PESISTULOKSET_API_KEY ?? "wRX0tTke3DZ8RLKAMntjZ81LwgNQuSN9";
  const apiBase = process.env.PESISTULOKSET_API_BASE ?? "https://api.pesistulokset.fi/api/v1";

  // run/ retention (issue #39). Deliberately cautious: a month of history is
  // kept and only the relay's own artifacts are in scope, so operator material
  // in run/ (demos, simulation output, recordings) survives untouched.
  const runRetentionDays = nonNegativeNumber(process.env.RELAY_RUN_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
  const ttsCacheMaxMb = nonNegativeNumber(process.env.RELAY_TTS_CACHE_MAX_MB, DEFAULT_TTS_CACHE_MAX_MB);

  const runDir = new URL("../run/", import.meta.url).pathname;
  const stateFile = `${runDir}.state-${matchId}.json`;
  const controlFile = `${runDir}.control-${matchId}.json`;
  // Repo-root file (historically written by the v1 server's web UI) so
  // existing pronunciation overrides keep applying regardless of the cwd the
  // broadcast is launched from (systemd uses repo root, npm workspace scripts
  // use apps/broadcast/).
  const pronunciationsFile =
    process.env.PRONUNCIATIONS_FILE ?? new URL("../../../.pronunciations.json", import.meta.url).pathname;

  return {
    matchId,
    youtubeUrl,
    rtmpUrl,
    streamKey,
    voice,
    piperBin,
    pollInterval,
    narrationGain,
    narrationDelayMs,
    firstSpeechDelayMs,
    urlRefreshMs,
    maxFailureWindowMs,
    finishedFailureWindowMs,
    deltaFetch,
    announceBatterChanges,
    dryRun,
    recordFile,
    apiKey,
    apiBase,
    stateFile,
    runDir,
    runRetentionDays,
    ttsCacheMaxBytes: Math.round(ttsCacheMaxMb * 1024 * 1024),
    pronunciationsFile,
    controlFile,
    elevenLabsApiKey,
    elevenLabsVoiceId,
    elevenLabsModelId,
  };
}
