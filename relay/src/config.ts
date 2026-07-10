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
  dryRun: boolean;
  recordFile?: string;
  urlRefreshMs?: number;
  apiKey: string;
  apiBase: string;
  stateFile: string;
  runDir: string;
  pronunciationsFile: string;
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
  const pollInterval = parseInt(values["poll-interval"] ?? process.env.RELAY_POLL_INTERVAL ?? "6000", 10);
  const narrationGain = parseFloat(values["narration-gain"] ?? process.env.RELAY_NARRATION_GAIN ?? "1.3");
  // Source URLs from yt-dlp carry an `expire` param ~6 h out, so the proactive
  // refresh only needs to beat that — each refresh is a visible few-second
  // break in the output stream, so err toward fewer of them.
  const urlRefreshMs = process.env.RELAY_URL_REFRESH_MS
    ? parseInt(process.env.RELAY_URL_REFRESH_MS, 10)
    : undefined;
  const apiKey = process.env.PESISTULOKSET_API_KEY ?? "wRX0tTke3DZ8RLKAMntjZ81LwgNQuSN9";
  const apiBase = process.env.PESISTULOKSET_API_BASE ?? "https://api.pesistulokset.fi/api/v1";

  const runDir = new URL("../run/", import.meta.url).pathname;
  const stateFile = `${runDir}.state-${matchId}.json`;
  // Same file the main app's web UI writes to, so pronunciation overrides
  // configured there also apply to this relay's synthesized narration.
  const pronunciationsFile = process.env.PRONUNCIATIONS_FILE ?? ".pronunciations.json";

  return {
    matchId,
    youtubeUrl,
    rtmpUrl,
    streamKey,
    voice,
    piperBin,
    pollInterval,
    narrationGain,
    dryRun,
    recordFile,
    urlRefreshMs,
    apiKey,
    apiBase,
    stateFile,
    runDir,
    pronunciationsFile,
  };
}
