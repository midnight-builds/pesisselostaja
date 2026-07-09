import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One-off listening demo for tuning Piper's noise_w/length_scale, built from
 *  real narration lines out of match 143267 (Ikaalisten Tarmo - IPV). Not
 *  wired into any npm script — run directly with:
 *    npx tsx relay/experiments/voice-tuning-demo.ts
 *  See relay/experiments/voice-tuning-demo.md for what to listen for. */

const VOICES_DIR = new URL("../voices/", import.meta.url).pathname;
const MODEL_PATH = join(VOICES_DIR, "fi_FI-harri-medium.onnx");
const OUT_DIR = new URL("../run/voice-tuning-demo/", import.meta.url).pathname;
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

// Real lines from match 143267 (Ikaalisten Tarmo - IPV, D-tytöt), as spoken by
// CommentaryLoop/relay:simulate in the earlier test run — not invented text.
const LINE_RUN_1 = "4 A Tiainen löi juoksun, tuojana 1 A Hupli. 1, 0, IPV johtaa.";
const LINE_RUN_2 = "6 J Puonti löi juoksun, tuojana 10 S Karjalainen. 3, 0, IPV johtaa.";
const LINE_HOMERUN = "8 N Lappalainen löi kunnarin! 22, 2, IPV johtaa.";
const LINE_MATCH_END = "Ottelu päättyi! IPV voitti, Tarmo 2, IPV 22.";
const LINE_PALO_IPV = "Palo! IPV, ensimmäinen palo.";
const LINE_PALO_TARMO = "Palo! Tarmo, ensimmäinen palo.";
const LINE_BATTER = "Vuorossa 8 N Lappalainen.";

async function main(): Promise<void> {
  mkdirSync(CLIPS_DIR, { recursive: true });

  // Piper's WAV output rate is fixed by the model (22050 Hz for this voice);
  // probe it once from a real clip so generated silence matches exactly.
  const probe = await synth("Testi.", {});
  const sampleRate = await probeSampleRate(probe);

  const shortSil = await silence(0.5, sampleRate);
  const longSil = await silence(1.1, sampleRate);

  const timeline: string[] = [];
  const say = async (text: string, params: SynthParams = {}) => timeline.push(await synth(text, params));
  const pause = (short = true) => timeline.push(short ? shortSil : longSil);

  await say(
    "Ääninäyte selostuksen rytmivaihtoehdoista. Sama Piper-ääni, samat lauseet " +
      "oikeasta ottelusta, vain noise w ja length scale -parametrit muuttuvat."
  );
  pause(false);

  await say("Ensin oletusarvot. Noise w 0 pilkku 8, length scale 1 pilkku 0.");
  pause();
  await say(LINE_RUN_1);
  pause(false);

  await say("Noise w nostettu yhteen pilkku kolmeen. Enemmän vaihtelua tavujen pituudessa.");
  pause();
  await say(LINE_RUN_2, { noiseW: 1.3 });
  pause(false);

  await say("Length scale nopeutettu, 0 pilkku 85. Näin kunnari voisi kuulostaa.");
  pause();
  await say(LINE_HOMERUN, { lengthScale: 0.85, noiseScale: 0.8 });
  pause(false);

  await say("Length scale hidastettu, 1 pilkku 15. Painotusta ottelun lopetukseen.");
  pause();
  await say(LINE_MATCH_END, { lengthScale: 1.15 });
  pause(false);

  await say(
    "Lopuksi kolme peräkkäistä ilmoitusta, joissa noise w vaihtelee kevyesti " +
      "rivi riviltä ilman erillistä selitystä välissä."
  );
  pause();
  await say(LINE_PALO_IPV, { noiseW: 0.75 });
  pause();
  await say(LINE_BATTER, { noiseW: 0.95 });
  pause();
  await say(LINE_PALO_TARMO, { noiseW: 0.85 });

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
