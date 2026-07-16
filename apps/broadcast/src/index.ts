import "dotenv/config";
import { mkdirSync } from "node:fs";
import { parseRelayConfig } from "./config.js";
import { log } from "./log.js";
import { CommentaryLoop } from "./commentaryLoop.js";
import { PiperTts } from "./piperTts.js";
import { ElevenLabsTts } from "./elevenLabsTts.js";
import { FfmpegMixer, SourceExhaustedError } from "./ffmpegMixer.js";

async function main(): Promise<void> {
  const config = parseRelayConfig();
  mkdirSync(config.runDir, { recursive: true });

  log("Pesisselostaja Relay");
  log(`Ottelu ID: ${config.matchId}`);
  log(`YouTube-lähde: ${config.youtubeUrl}`);
  log(`Ääni: ${config.elevenLabsApiKey ? `ElevenLabs ${config.elevenLabsVoiceId} (${config.elevenLabsModelId}), fallback Piper ${config.voice}` : `Piper ${config.voice}`}`);
  log(`Dry run: ${config.dryRun}`);
  if (config.recordFile) log(`Tallennetaan paikalliseen tiedostoon: ${config.recordFile}`);

  const voicesDir = new URL("../voices/", import.meta.url).pathname;
  const piper = new PiperTts({ piperBin: config.piperBin, voice: config.voice, voicesDir });
  const elevenLabs = config.elevenLabsApiKey
    ? new ElevenLabsTts({
        apiKey: config.elevenLabsApiKey,
        voiceId: config.elevenLabsVoiceId,
        modelId: config.elevenLabsModelId,
        cacheDir: `${config.runDir}tts-cache/`,
      })
    : null;

  let mixer: FfmpegMixer | null = null;

  const loop = new CommentaryLoop(config, async (spoken, readable) => {
    if (config.dryRun || !mixer) {
      log(`[DRY-RUN synteesi] ${readable}`);
      return;
    }
    let pcm: Buffer;
    if (elevenLabs) {
      try {
        // ElevenLabs reads abbreviations correctly → readable text, no substitutions.
        pcm = await elevenLabs.synthesize(readable);
      } catch (err) {
        log(`ElevenLabs epäonnistui (${err instanceof Error ? err.message : err}) — Piper-fallback`);
        pcm = await piper.synthesize(spoken);
      }
    } else {
      pcm = await piper.synthesize(spoken);
    }
    mixer.enqueueNarration(pcm);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("Sammutetaan…");
    if (elevenLabs) log(`ElevenLabs-merkkejä käytetty tässä ajossa: ${elevenLabs.totalCharsUsed}`);
    loop.stop();
    mixer?.stop();
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (!config.dryRun) {
    const fifoPath = `${config.runDir}relay-${config.matchId}.pcm`;
    mixer = new FfmpegMixer({
      youtubeUrl: config.youtubeUrl,
      rtmpUrl: config.rtmpUrl,
      streamKey: config.streamKey,
      narrationGain: config.narrationGain,
      urlRefreshMs: config.urlRefreshMs,
      maxFailureWindowMs: config.maxFailureWindowMs,
      fifoPath,
      recordFile: config.recordFile,
    });
    mixer.start().catch((err) => {
      log(`ffmpeg-valvoja päättyi virheeseen: ${err instanceof Error ? err.message : err}`);
      if (err instanceof SourceExhaustedError) {
        log("Alkuperäinen lähde ei palautunut — sammutetaan koko relay.");
        shutdown();
      }
    });
  } else {
    log("Dry-run: ffmpegiä/RTMP:ää ei käynnistetä, selostus vain lokitetaan.");
  }

  await loop.run();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
