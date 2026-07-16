import { parseArgs } from "node:util";

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
   *  instead of ahead of it once the API skip-delay shortened the feed lag
   *  (HANDOFF.md 8). Default 0 (no delay). Runtime-overridable via the control
   *  file — see commentaryLoop. */
  narrationDelayMs: number;
  urlRefreshMs: number;
  maxFailureWindowMs: number;
  announceBatterChanges: boolean;
  dryRun: boolean;
  recordFile?: string;
  apiKey: string;
  apiBase: string;
  stateFile: string;
  runDir: string;
  pronunciationsFile: string;
  /** JSON file the commentary loop re-reads each poll so an operator can flip
   *  announceBatterChanges mid-match without restarting — see commentaryLoop. */
  controlFile: string;
  /** When set, ElevenLabs is the primary TTS engine and Piper the fallback. */
  elevenLabsApiKey?: string;
  elevenLabsVoiceId: string;
  elevenLabsModelId: string;
}

function requireValue(name: string, cliValue: string | undefined, envName: string): string {
  const value = cliValue ?? process.env[envName];
  if (!value) {
    console.error(`Error: ${name} is required (--${name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())} or ${envName})`);
    process.exit(1);
  }
  return value;
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
  const pollInterval = parseInt(values["poll-interval"] ?? process.env.RELAY_POLL_INTERVAL ?? "4000", 10);
  const narrationGain = parseFloat(values["narration-gain"] ?? process.env.RELAY_NARRATION_GAIN ?? "1.3");
  // Artificial narration delay (HANDOFF.md 8). Default 0 = current behavior;
  // the real value is calibrated live. A bad value falls back to 0 rather than
  // NaN (which would make every wait computation NaN). Negative is clamped to 0.
  const narrationDelayRaw = parseInt(values["narration-delay-ms"] ?? process.env.RELAY_NARRATION_DELAY_MS ?? "0", 10);
  const narrationDelayMs = Number.isNaN(narrationDelayRaw) ? 0 : Math.max(0, narrationDelayRaw);
  const urlRefreshMs = parseInt(values["url-refresh-ms"] ?? process.env.RELAY_URL_REFRESH_MS ?? String(15 * 60 * 1000), 10);
  // How long resolveSourceUrl/ffmpeg-start may fail continuously before the
  // relay gives up and shuts down (see SourceExhaustedError). Kept generous
  // by default so a relay started a few minutes ahead of the phone's
  // announced go-live time doesn't give up before the source ever appears.
  const maxFailureWindowMs = parseInt(
    values["max-failure-window-ms"] ?? process.env.RELAY_MAX_FAILURE_WINDOW_MS ?? String(12 * 60 * 1000),
    10
  );
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
    urlRefreshMs,
    maxFailureWindowMs,
    announceBatterChanges,
    dryRun,
    recordFile,
    apiKey,
    apiBase,
    stateFile,
    runDir,
    pronunciationsFile,
    controlFile,
    elevenLabsApiKey,
    elevenLabsVoiceId,
    elevenLabsModelId,
  };
}
