import { loadRelayEnv } from "./relayEnv.js";
import { mkdirSync } from "node:fs";
import { parseRelayConfig } from "./config.js";
import { logDebug, logError, logInfo, logWarn } from "./log.js";
import { CommentaryLoop } from "./commentaryLoop.js";
import { PiperTts } from "./piperTts.js";
import { ElevenLabsTts } from "./elevenLabsTts.js";
import { FfmpegMixer, SourceExhaustedError } from "./ffmpegMixer.js";
import { NoSignalSlate } from "./noSignalSlate.js";
import { pruneRunDir, DAY_MS } from "./runRetention.js";
import { Telemetry } from "./telemetry.js";

// Before any config is parsed: same .env.relay systemd's EnvironmentFile
// provides, so a manual dry-run and the live service read identical settings.
loadRelayEnv();

async function main(): Promise<void> {
  const config = parseRelayConfig();
  mkdirSync(config.runDir, { recursive: true });

  // Attached before the first line so the timeline holds the whole run,
  // including the config lines that explain how it was started.
  const telemetry = new Telemetry({ runDir: config.runDir, matchId: config.matchId });
  telemetry.attachToLog();

  logInfo("relay.start", "Pesisselostaja Relay");
  logInfo("relay.config", `Ottelu ID: ${config.matchId}`);
  logInfo("relay.config", `YouTube-lähde: ${config.youtubeUrl}`);
  logInfo("relay.config", `Ääni: ${config.elevenLabsApiKey ? `ElevenLabs ${config.elevenLabsVoiceId} (${config.elevenLabsModelId}), fallback Piper ${config.voice}` : `Piper ${config.voice}`}`);
  logInfo("relay.config", `Dry run: ${config.dryRun}`);
  if (!config.dryRun) logInfo("relay.config", `Lähteen antelias aikaikkuna ennen luovutusta: ${Math.round(config.maxFailureWindowMs / 60000)} min`);
  if (config.recordFile) logInfo("relay.config", `Tallennetaan paikalliseen tiedostoon: ${config.recordFile}`);

  // run/ retention (issue #39) — before synthesis starts, so the TTS cache has
  // room. Only the relay's own artifacts are in scope; operator material in
  // run/ is never removed automatically.
  const pruned = await pruneRunDir(config.runDir, {
    maxAgeMs: config.runRetentionDays * DAY_MS,
    ttsCacheMaxBytes: config.ttsCacheMaxBytes,
    keepMatchIds: [config.matchId],
  });
  if (pruned.removed.length > 0) {
    logInfo(
      "relay.config",
      `Säilytyskäytäntö: poistettu ${pruned.removed.length} vanhaa ajotiedostoa ` +
        `(${(pruned.freedBytes / (1024 * 1024)).toFixed(1)} MiB vapautui).`
    );
  }

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

  const loop = new CommentaryLoop(
    config,
    async (spoken, readable) => {
      if (config.dryRun || !mixer) {
        logDebug("speech.dry_run", `[DRY-RUN synteesi] ${readable}`);
        return;
      }
      let pcm: Buffer;
      let engine = elevenLabs ? "elevenlabs" : "piper";
      const startedAt = Date.now();
      if (elevenLabs) {
        try {
          // ElevenLabs reads abbreviations correctly → readable text, no substitutions.
          pcm = await elevenLabs.synthesize(readable);
        } catch (err) {
          logWarn("tts.elevenlabs_failed", `ElevenLabs epäonnistui (${err instanceof Error ? err.message : err}) — Piper-fallback`);
          pcm = await piper.synthesize(spoken);
          engine = "piper-fallback";
        }
      } else {
        pcm = await piper.synthesize(spoken);
      }
      // The id the loop assigned is not threaded through SpeechSink (it is a
      // two-argument port shared with the dry-run path), so the synthesis
      // record is keyed by text. Detected/spoken still carry the id.
      telemetry.narrationSynthesized({ id: "", text: readable }, engine, Date.now() - startedAt);
      mixer.enqueueNarration(pcm);
    },
    {
      // Dry-run never attaches ffmpeg but should still log fillers, so report
      // "ready" there; otherwise defer to the live mixer's session/queue state
      // so pre-game filler isn't synthesized before ffmpeg is reading it
      // (HANDOFF.md 7).
      isReaderAttached: () => config.dryRun || (mixer?.isReaderAttached ?? false),
      pendingClips: () => mixer?.pendingClips ?? 0,
      // Dry-run reports epoch 0 = "attached long ago", so the first-speech
      // grace never delays dry-run logging.
      firstAttachedAt: () => (config.dryRun ? 0 : (mixer?.firstAttachedAt ?? null)),
    },
    {
      detected: (clip) => telemetry.narrationDetected(clip),
      spoken: (clip, muted) => telemetry.narrationSpoken(clip, muted),
    }
  );

  // status-<ID>.json is rewritten on the poll cadence rather than on every
  // event: the control app polls it, and a snapshot that is at most one poll
  // stale is exactly as fresh as the data behind it.
  const writeStatus = () =>
    telemetry.writeStatus({
      readerAttached: config.dryRun || (mixer?.isReaderAttached ?? false),
      pendingClips: mixer?.pendingClips ?? 0,
      respawns: mixer?.respawnCount ?? 0,
      sourceState: mixer?.sourceState ?? (config.dryRun ? "unknown" : "resolving"),
      sourceDetail: mixer?.sourceDetail ?? null,
      matchFinished: loop.matchFinished,
      eventCount: loop.eventCount,
      lastEventAt: loop.lastEventAt,
      ttsEngine: elevenLabs ? "elevenlabs" : "piper",
      elevenLabsCharsUsed: elevenLabs?.totalCharsUsed ?? 0,
    });

  // Katvekuvan tekstirivit päivitetään samalla pollin tahdilla kuin
  // telemetriakin: kuvaa ohjaa drawtextin `reload`, joten tuore tiedosto
  // näkyy ruudulla ilman respawnia. Turha kutsu on halpa — NoSignalSlate
  // kirjoittaa vain muuttuneen rivin.
  const pushSlateSituation = (): void => mixer?.setSlateSituation(loop.slateSituation);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo("relay.shutdown", "Sammutetaan…");
    // Final snapshot, so the file left in run/ describes how the run ENDED
    // rather than where it happened to be one poll before.
    writeStatus();
    if (elevenLabs) logInfo("relay.tts_usage", `ElevenLabs-merkkejä käytetty tässä ajossa: ${elevenLabs.totalCharsUsed}`);
    loop.stop();
    mixer?.stop();
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Once immediately: the control app should find a snapshot the moment the
  // unit reports active, not one poll later — and a relay that dies during
  // startup would otherwise leave no trace of having started at all.
  writeStatus();
  const statusTimer = setInterval(() => {
    writeStatus();
    pushSlateSituation();
  }, config.pollInterval);
  statusTimer.unref();

  if (!config.dryRun) {
    const fifoPath = `${config.runDir}relay-${config.matchId}.pcm`;
    // Katvekuva (issue #104) on oletuksena pois. Kun se on päällä, kuva
    // renderöidään kerran tässä: epäonnistuminen ei ole virhe vaan tarkoittaa
    // vain että katvetila ohitetaan ja respawn-silmukka toimii kuten ennen.
    let slate: NoSignalSlate | null = null;
    if (config.noSignalSlate) {
      slate = new NoSignalSlate({
        matchId: config.matchId,
        runDir: config.runDir,
        width: config.noSignalSlateWidth,
        height: config.noSignalSlateHeight,
      });
      await slate.prepare();
      logInfo(
        "relay.config",
        `Katvekuva: ${slate.available ? "PÄÄLLÄ" : "PÄÄLLÄ mutta ei käytettävissä"} ` +
          `(kynnys ${Math.round(config.noSignalSlateAfterMs / 1000)} s, ` +
          // Resoluutio lokiin, koska sen EROAMINEN lähteestä on se asia joka
          // aiheuttaa ylimääräisen katkon vaihdossa — ja se on ainoa tapa
          // huomata se jälkikäteen lokista.
          `${config.noSignalSlateWidth}x${config.noSignalSlateHeight})`
      );
    }
    mixer = new FfmpegMixer({
      youtubeUrl: config.youtubeUrl,
      rtmpUrl: config.rtmpUrl,
      streamKey: config.streamKey,
      narrationGain: config.narrationGain,
      urlRefreshMs: config.urlRefreshMs,
      maxFailureWindowMs: config.maxFailureWindowMs,
      finishedFailureWindowMs: config.finishedFailureWindowMs,
      // The loop owns the finished state; the supervisor uses it to give up
      // on a dead source quickly once the match has ended (HANDOFF 6.2).
      isMatchFinished: () => loop.matchFinished,
      heartbeatExtra: () => loop.pollStatsSummary,
      fifoPath,
      recordFile: config.recordFile,
      slate,
      slateAfterMs: config.noSignalSlateAfterMs,
      // Ohjaamon havainto on VAPAAEHTOINEN tulo: se ei laukaise katvetilaa
      // (se on relayn oma paikallinen päätös), vaan estää sen kun lähetys on
      // päätetty ja tarkentaa tilannerivin sanamuotoa.
      sourceIngest: () => loop.sourceIngest,
    });
    pushSlateSituation();
    mixer.start().catch((err) => {
      logError("ffmpeg.supervisor_failed", `ffmpeg-valvoja päättyi virheeseen: ${err instanceof Error ? err.message : err}`);
      if (err instanceof SourceExhaustedError) {
        logError("relay.source_gone", "Alkuperäinen lähde ei palautunut — sammutetaan koko relay.");
        shutdown();
      }
    });
  } else {
    logInfo("relay.dry_run", "Dry-run: ffmpegiä/RTMP:ää ei käynnistetä, selostus vain lokitetaan.");
  }

  await loop.run();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
