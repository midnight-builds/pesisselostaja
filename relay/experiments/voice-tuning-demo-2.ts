import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Follow-up listening demo answering two open questions from
 *  voice-tuning-demo.md ("Päätettävää seuraavassa sessiossa" #2 and #3):
 *   1. Does noise_w keep sounding more natural as it rises, or does
 *      pronunciation start breaking down at some point?
 *   2. Is the current per-line noise_w jitter (0.75/0.95/0.85) a clearly
 *      audible difference, or does the range need widening?
 *  Uses fictional names/teams (not the real match 143267 lines from the
 *  first demo) since this script is committed to a public repo.
 *  Run: npx tsx relay/experiments/voice-tuning-demo-2.ts */

const VOICES_DIR = new URL("../voices/", import.meta.url).pathname;
const MODEL_PATH = join(VOICES_DIR, "fi_FI-harri-medium.onnx");
const OUT_DIR = new URL("../run/voice-tuning-demo-2/", import.meta.url).pathname;
const CLIPS_DIR = join(OUT_DIR, "clips");

interface SynthParams {
  noiseScale?: number;
  noiseW?: number;
  lengthScale?: number;
}

const PIPER_DEFAULTS: Required<SynthParams> = { noiseScale: 0.667, noiseW: 0.8, lengthScale: 1.0 };

function execFileP(cmd: string, args: string[], input?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, (err) => (err ? reject(err) : resolve()));
    if (input !== undefined) child.stdin?.end(input);
  });
}

let clipCounter = 0;

async function synth(text: string, params: SynthParams = {}): Promise<string> {
  const p = { ...PIPER_DEFAULTS, ...params };
  const outPath = join(CLIPS_DIR, `${String(clipCounter++).padStart(2, "0")}.wav`);
  await execFileP(
    "piper",
    [
      "--model", MODEL_PATH,
      "--output_file", outPath,
      "--noise_scale", String(p.noiseScale),
      "--noise_w", String(p.noiseW),
      "--length_scale", String(p.lengthScale),
    ],
    text
  );
  return outPath;
}

async function silence(seconds: number, sampleRate: number): Promise<string> {
  const outPath = join(CLIPS_DIR, `${String(clipCounter++).padStart(2, "0")}-sil.wav`);
  await execFileP("ffmpeg", [
    "-y", "-f", "lavfi", "-i", `anullsrc=r=${sampleRate}:cl=mono`,
    "-t", String(seconds),
    outPath,
  ]);
  return outPath;
}

async function probeSampleRate(wavPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate", "-of", "csv=p=0", wavPath],
      (err, stdout) => (err ? reject(err) : resolve(parseInt(stdout.toString().trim(), 10)))
    );
  });
}

// Fictional lines, same style as real narration but no real players/teams.
const LINE_RUN = "9 T Salonen löi juoksun, tuojana 4 M Virtanen. 2, 1, Kotikylä johtaa.";
const LINE_PALO_A = "Palo! Kotikylä, toinen palo.";
const LINE_BATTER = "Vuorossa 7 A Koskinen.";
const LINE_PALO_B = "Palo! Pesäkylä, ensimmäinen palo.";

async function main(): Promise<void> {
  mkdirSync(CLIPS_DIR, { recursive: true });

  const probe = await synth("Testi.", {});
  const sampleRate = await probeSampleRate(probe);

  const shortSil = await silence(0.5, sampleRate);
  const longSil = await silence(1.1, sampleRate);

  const timeline: string[] = [];
  const say = async (text: string, params: SynthParams = {}) => timeline.push(await synth(text, params));
  const pause = (short = true) => timeline.push(short ? shortSil : longSil);

  await say(
    "Jatkodemo kahdesta avoimesta kysymyksestä. Ensin noise w -tikapuu, sitten " +
      "vertailu peräkkäisten ilmoitusten vaihteluvälin leveydestä."
  );
  pause(false);

  // --- Question 2: noise_w ladder, same line, rising values ---
  await say("Osa yksi. Sama lause viidellä nousevalla noise w -arvolla.");
  pause(false);

  const ladder = [0.8, 1.1, 1.3, 1.6, 2.0];
  for (const noiseW of ladder) {
    const [intPart, decPart] = noiseW.toFixed(2).split(".");
    await say(`Noise w ${intPart} pilkku ${decPart}.`);
    pause();
    await say(LINE_RUN, { noiseW });
    pause(false);
  }

  // --- Question 3: narrow vs wide per-line jitter, same three lines ---
  await say(
    "Osa kaksi. Kolme peräkkäistä ilmoitusta ilman välikommentteja, ensin " +
      "nykyisellä vaihteluvälillä, noise w 0 pilkku 75, 0 pilkku 95, 0 pilkku 85."
  );
  pause();
  await say(LINE_PALO_A, { noiseW: 0.75 });
  pause();
  await say(LINE_BATTER, { noiseW: 0.95 });
  pause();
  await say(LINE_PALO_B, { noiseW: 0.85 });
  pause(false);

  await say(
    "Sama kolmikko leveämmällä vaihteluvälillä, noise w 0 pilkku 6, 1 pilkku 0, 0 pilkku 75."
  );
  pause();
  await say(LINE_PALO_A, { noiseW: 0.6 });
  pause();
  await say(LINE_BATTER, { noiseW: 1.0 });
  pause();
  await say(LINE_PALO_B, { noiseW: 0.75 });

  const listPath = join(OUT_DIR, "concat-list.txt");
  writeFileSync(listPath, timeline.map((p) => `file '${p}'`).join("\n"));

  const outPath = join(OUT_DIR, "demo.mp3");
  await execFileP("ffmpeg", [
    "-y", "-f", "concat", "-safe", "0",
    "-i", listPath,
    "-c:a", "libmp3lame", "-q:a", "4",
    outPath,
  ]);

  console.log(`Valmis: ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
