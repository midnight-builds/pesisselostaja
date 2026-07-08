import "dotenv/config";
import { parseArgs } from "node:util";
import { mkdirSync, existsSync, openSync, writeSync, ftruncateSync, closeSync, statSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { fetchMatchMetadata, fetchLiveEvents } from "../../src/api.js";
import {
  buildPlayerLookup,
  subEventToSpeech,
  isRunScoringSubEvent,
  isOutSubEvent,
  isMatchEndSubEvent,
  runValueOfSubEvent,
  type SpeechContext,
} from "../../src/speech.js";
import { loadState, addRun, getPeriodScore, periodsWon, type WatcherState } from "../../src/state.js";
import { loadPronunciations, applyPronunciations, preventOrdinalReading } from "../../src/pronunciation.js";
import { PiperTts } from "./piperTts.js";
import { buildMixFilterComplex } from "./ffmpegMixer.js";
import { log } from "./log.js";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_SEC = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
const MIN_FREE_GB = 2;

interface SpeechLine {
  offsetSec: number;
  spoken: string;
  readable: string;
}

function execFileP(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.toString());
    });
  });
}

function runInherit(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
    child.once("error", reject);
  });
}

/** Aborts per the global disk-space guard: never let a video download or
 *  ffmpeg mux run the host below MIN_FREE_GB free. */
async function assertDiskSpace(path: string): Promise<void> {
  const out = await execFileP("df", ["-k", "--output=avail", path]);
  const availKb = parseInt(out.trim().split("\n")[1]?.trim() ?? "0", 10);
  const availGb = availKb / (1024 * 1024);
  if (availGb < MIN_FREE_GB) {
    throw new Error(`Levytila loppumassa (${availGb.toFixed(1)} Gt vapaana, raja ${MIN_FREE_GB} Gt) — pysäytetään.`);
  }
  log(`Levytilaa vapaana: ${availGb.toFixed(1)} Gt`);
}

async function downloadVod(youtubeUrl: string, outPath: string): Promise<void> {
  if (existsSync(outPath) && statSync(outPath).size > 0) {
    log(`Video jo ladattu: ${outPath} (poista tiedosto pakottaaksesi uudelleenlatauksen)`);
    return;
  }
  log("Ladataan VOD yt-dlp:llä…");
  await runInherit("yt-dlp", [
    "--no-playlist",
    "-f", "bv*+ba/best",
    "--merge-output-format", "mp4",
    "-o", outPath,
    youtubeUrl,
  ]);
}

async function probeDurationSec(path: string): Promise<number> {
  const out = await execFileP("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    path,
  ]);
  const sec = parseFloat(out.trim());
  if (!Number.isFinite(sec) || sec <= 0) throw new Error(`ffprobe ei löytänyt kestoa: ${path}`);
  return sec;
}

/** Replays the full (already-finished) event history into a flat list of
 *  speech lines tagged with event.timestamp (seconds elapsed since match
 *  start — confirmed against the raw API response, not wall-clock). Mirrors
 *  CommentaryLoop's per-sub-event scoring/state bookkeeping, but processes
 *  the whole match in one batch instead of live polling, and — unlike the
 *  live loop — does NOT skip historical events, since replaying them is the
 *  whole point here. Bat-turn-change announcements and periodic summaries
 *  are intentionally omitted: those are triggered by live poll timing, which
 *  historical data doesn't carry. */
async function buildTimeline(
  matchId: number,
  apiBase: string,
  apiKey: string,
  pronunciationsFile: string
): Promise<SpeechLine[]> {
  const meta = await fetchMatchMetadata(matchId, { apiBase, apiKey });
  const lookup = buildPlayerLookup(meta);
  const { events } = await fetchLiveEvents(matchId, { apiBase });
  const pronunciations = loadPronunciations(pronunciationsFile);

  log(`${meta.home.name} vs ${meta.away.name} — ${events.length} tapahtumaa`);

  const state: WatcherState = loadState("/nonexistent/simulate-scratch-state.json");
  const lines: SpeechLine[] = [];
  let lastSpoken: string | null = null;

  for (const event of events) {
    if (event.team != null && event.team !== state.currentBatTeamId) {
      state.currentBatTeamId = event.team;
      state.currentOuts = 0;
    }
    if (event.period > 0) state.currentPeriod = event.period;

    for (const sub of event.events) {
      if (isMatchEndSubEvent(sub)) state.finished = true;
      if (isRunScoringSubEvent(sub)) {
        const value = runValueOfSubEvent(sub);
        if (event.team != null && value > 0) addRun(state, event.period, event.team === meta.home.id, value);
      }
      if (isOutSubEvent(sub)) state.currentOuts++;

      const periodScore = getPeriodScore(state, state.currentPeriod);
      const won = periodsWon(state);
      const ctx: SpeechContext = {
        periodHomeRuns: periodScore.home,
        periodAwayRuns: periodScore.away,
        homePeriodsWon: won.home,
        awayPeriodsWon: won.away,
        currentOuts: state.currentOuts,
        currentPeriod: state.currentPeriod,
        currentBatTeamId: state.currentBatTeamId,
      };
      const readable = subEventToSpeech(event, sub, meta, lookup, true, ctx);
      if (!readable || readable === lastSpoken) continue;
      lastSpoken = readable;

      const spoken = preventOrdinalReading(applyPronunciations(readable, pronunciations));
      lines.push({ offsetSec: event.timestamp ?? 0, spoken, readable });
    }
  }
  return lines;
}

async function synthesizeTrack(
  lines: SpeechLine[],
  piper: PiperTts,
  pcmPath: string,
  leadInSec: number,
  totalDurationSec: number
): Promise<void> {
  const fd = openSync(pcmPath, "w");
  let maxEndByte = 0;
  try {
    for (const line of lines) {
      log(`[${(line.offsetSec + leadInSec).toFixed(0)}s] ${line.readable}`);
      const pcm = await piper.synthesize(line.spoken);
      const offsetBytes = Math.max(0, Math.round((line.offsetSec + leadInSec) * BYTES_PER_SEC));
      writeSync(fd, pcm, 0, pcm.length, offsetBytes);
      maxEndByte = Math.max(maxEndByte, offsetBytes + pcm.length);
    }
    const totalBytes = Math.round(totalDurationSec * BYTES_PER_SEC);
    ftruncateSync(fd, Math.max(totalBytes, maxEndByte));
  } finally {
    closeSync(fd);
  }
}

async function mixAudio(videoPath: string, pcmPath: string, outPath: string, narrationGain: number): Promise<void> {
  log("Miksataan selostus videoon ffmpegillä…");
  await runInherit("ffmpeg", [
    "-y", "-nostdin", "-loglevel", "warning",
    "-i", videoPath,
    "-f", "s16le", "-ar", `${SAMPLE_RATE}`, "-ac", `${CHANNELS}`,
    "-i", pcmPath,
    "-filter_complex", buildMixFilterComplex(narrationGain),
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "160k", "-ar", `${SAMPLE_RATE}`,
    outPath,
  ]);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "match-id": { type: "string" },
      "youtube-url": { type: "string" },
      "out-dir": { type: "string" },
      "lead-in": { type: "string" },
      "voice": { type: "string" },
      "piper-bin": { type: "string" },
      "narration-gain": { type: "string" },
    },
    strict: true,
  });

  const matchId = parseInt(values["match-id"] ?? "", 10);
  const youtubeUrl = values["youtube-url"];
  if (!matchId || isNaN(matchId) || !youtubeUrl) {
    console.error("Usage: relay:simulate -- --match-id <id> --youtube-url <url> [--out-dir <dir>] [--lead-in <sec>] [--voice harri-medium] [--narration-gain 1.3]");
    process.exit(1);
  }

  const outDir = values["out-dir"] ?? new URL(`../run/simulate-${matchId}/`, import.meta.url).pathname;
  mkdirSync(outDir, { recursive: true });

  const leadInSec = parseFloat(values["lead-in"] ?? "0");
  const voice = values.voice ?? "harri-medium";
  const piperBin = values["piper-bin"] ?? "piper";
  const narrationGain = parseFloat(values["narration-gain"] ?? "1.3");
  const apiKey = process.env.PESISTULOKSET_API_KEY ?? "wRX0tTke3DZ8RLKAMntjZ81LwgNQuSN9";
  const apiBase = process.env.PESISTULOKSET_API_BASE ?? "https://api.pesistulokset.fi/api/v1";
  const pronunciationsFile = process.env.PRONUNCIATIONS_FILE ?? ".pronunciations.json";

  const videoPath = `${outDir}source.mp4`;
  const pcmPath = `${outDir}narration.pcm`;
  const outPath = `${outDir}mixed.mp4`;

  log("Pesisselostaja Relay — simulaatio (dry-run videolle)");
  log(`Ottelu ID: ${matchId}, lead-in: ${leadInSec}s, ääni: ${voice}, gain: ${narrationGain}`);

  await assertDiskSpace(outDir);
  await downloadVod(youtubeUrl, videoPath);
  await assertDiskSpace(outDir);

  const durationSec = await probeDurationSec(videoPath);
  log(`Videon kesto: ${Math.round(durationSec)}s`);

  const lines = await buildTimeline(matchId, apiBase, apiKey, pronunciationsFile);
  log(`${lines.length} selostusriviä rakennettu aikajanalle`);

  const voicesDir = new URL("../voices/", import.meta.url).pathname;
  const piper = new PiperTts({ piperBin, voice, voicesDir });
  await synthesizeTrack(lines, piper, pcmPath, leadInSec, durationSec);

  await assertDiskSpace(outDir);
  await mixAudio(videoPath, pcmPath, outPath, narrationGain);

  log(`Valmis: ${outPath}`);
  log("Muista poistaa relay/run/simulate-*/ kun olet katsonut tuloksen — video+seos vievät tilaa.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
