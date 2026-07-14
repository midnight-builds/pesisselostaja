import { parseArgs } from "node:util";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { FfmpegMixer, indexedRecordPath } from "./ffmpegMixer.js";
import { log } from "./log.js";

const MIN_FREE_GB = 2;
const SAMPLE_RATE = 48000;
const CHANNELS = 2;

/** Reproduces ottelu 144203's observed cadence: the frozen source resolves
 *  fine and ffmpeg reads to a real EOF at ~33s every time (see
 *  relay/HANDOFF.md "Lähteen flappaus"). One session is deliberately longer
 *  (90s) so, if narration only ever recovers on it, that isolates hypothesis
 *  (c) — amix dropping the narration input on short sessions specifically —
 *  from (a)/(b), which predict failure regardless of session length. */
const SESSION_DURATIONS_SEC = [33, 33, 90, 33, 33];
const NARRATION_CADENCE_MS = 8000;
const NARRATION_CLIP_SEC = 2;
const NARRATION_FREQ_HZ = 1000;
const SOURCE_FREQ_HZ = 220;
/** Bandpassed mean volume above this is treated as "narration tone present".
 *  The 220Hz source tone falls well outside a 900-1100Hz bandpass, so a
 *  narration-free window measures near silence (~-80dB in manual checks);
 *  an actual 1000Hz clip (gain 1.3, limited to 0.95) sits close to 0dB. -35dB
 *  leaves a wide margin on both sides. */
const DETECTION_THRESHOLD_DB = -35;

function execFileP(cmd: string, args: string[]): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, encoding: "buffer" }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(" ")} failed: ${err.message}\n${stderr.toString()}`));
      else resolve({ stdout, stderr: stderr.toString() });
    });
  });
}

async function assertDiskSpace(path: string): Promise<void> {
  const { stdout } = await execFileP("df", ["-k", "--output=avail", path]);
  const availKb = parseInt(stdout.toString().trim().split("\n")[1]?.trim() ?? "0", 10);
  const availGb = availKb / (1024 * 1024);
  if (availGb < MIN_FREE_GB) {
    throw new Error(`Levytila loppumassa (${availGb.toFixed(1)} Gt vapaana, raja ${MIN_FREE_GB} Gt) — pysäytetään.`);
  }
  log(`Levytilaa vapaana: ${availGb.toFixed(1)} Gt`);
}

/** Synthetic "flapping source" fixture: colour bars + a steady 220Hz tone,
 *  exactly durationSec long, so ffmpeg reading it hits a real EOF at that
 *  point every time — no network/yt-dlp involved. */
async function buildSourceFixture(durationSec: number, outPath: string): Promise<void> {
  if (existsSync(outPath)) {
    log(`Lähdefixture on jo olemassa: ${outPath}`);
    return;
  }
  log(`Rakennetaan ${durationSec}s lähdefixture (${outPath})…`);
  await execFileP("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", `testsrc=size=640x480:rate=30:duration=${durationSec}`,
    "-f", "lavfi", "-i", `sine=frequency=${SOURCE_FREQ_HZ}:sample_rate=${SAMPLE_RATE}:duration=${durationSec}`,
    "-shortest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    outPath,
  ]);
}

/** One 2s, 1000Hz narration "clip" as raw s16le/48kHz/stereo PCM — the exact
 *  format NarrationFifo expects (see enqueueNarration/piperTts output). */
async function buildNarrationClipPcm(): Promise<Buffer> {
  const { stdout } = await execFileP("ffmpeg", [
    "-f", "lavfi", "-i", `sine=frequency=${NARRATION_FREQ_HZ}:sample_rate=${SAMPLE_RATE}:duration=${NARRATION_CLIP_SEC}`,
    "-f", "s16le", "-ar", `${SAMPLE_RATE}`, "-ac", `${CHANNELS}`,
    "-",
  ]);
  return stdout;
}

interface ClipRecord {
  enqueueEpoch: number;
}

interface SessionRecord {
  index: number;
  plannedDurationSec: number;
  startEpoch?: number;
  endEpoch?: number;
  ranMs?: number;
}

/** Runs `ffmpeg ... bandpass=f=1000 ... volumedetect` over [offsetSec,
 *  offsetSec+windowSec) of file and returns the reported mean_volume in dB,
 *  or null if ffmpeg produced no measurement (e.g. offset past EOF). */
async function measureNarrationBandDb(file: string, offsetSec: number, windowSec: number): Promise<number | null> {
  const { stderr } = await execFileP("ffmpeg", [
    "-y",
    "-ss", offsetSec.toFixed(2),
    "-t", windowSec.toFixed(2),
    "-i", file,
    "-af", `bandpass=f=${NARRATION_FREQ_HZ}:width_type=h:w=200,volumedetect`,
    "-f", "null",
    "-",
  ]);
  const m = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
  return m ? parseFloat(m[1]) : null;
}

function findSessionForEpoch(sessions: SessionRecord[], epoch: number): SessionRecord | null {
  for (const s of sessions) {
    if (s.startEpoch != null && s.endEpoch != null && epoch >= s.startEpoch && epoch < s.endEpoch) return s;
  }
  return null;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { "out-dir": { type: "string" } },
    strict: true,
  });

  const outDir = values["out-dir"] ?? new URL("../run/flap-test/", import.meta.url).pathname;
  mkdirSync(outDir, { recursive: true });
  await assertDiskSpace(outDir);

  log("Pesisselostaja Relay — flappaavan lähteen integraatiotesti");
  log(`Sessiosuunnitelma (s): ${SESSION_DURATIONS_SEC.join(", ")}`);

  const fixtureByDuration = new Map<number, string>();
  for (const d of new Set(SESSION_DURATIONS_SEC)) {
    const path = `${outDir}source-fixture-${d}s.mp4`;
    await buildSourceFixture(d, path);
    fixtureByDuration.set(d, path);
  }
  await assertDiskSpace(outDir);

  const narrationPcm = await buildNarrationClipPcm();
  log(`Selostusklippi valmis (${narrationPcm.length} tavua, ${NARRATION_CLIP_SEC}s, ${NARRATION_FREQ_HZ}Hz).`);

  const fifoPath = `${outDir}flap-test.pcm`;
  const recordFileBase = `${outDir}flap-test.mp4`;

  const sessions: SessionRecord[] = [];
  const clips: ClipRecord[] = [];
  let nextSourceIndex = 0;

  const mixer = new FfmpegMixer({
    youtubeUrl: "unused-in-test-mode",
    rtmpUrl: "",
    streamKey: "",
    narrationGain: 1.3,
    fifoPath,
    recordFile: recordFileBase,
    maxFailureWindowMs: 10 * 60 * 1000,
    resolveTestSource: () => {
      const plannedDurationSec = SESSION_DURATIONS_SEC[Math.min(nextSourceIndex, SESSION_DURATIONS_SEC.length - 1)];
      nextSourceIndex++;
      const path = fixtureByDuration.get(plannedDurationSec);
      if (!path) throw new Error(`No fixture built for duration ${plannedDurationSec}s`);
      return path;
    },
    onSessionStart: (epochMs) => {
      const index = sessions.length;
      const plannedDurationSec = SESSION_DURATIONS_SEC[Math.min(index, SESSION_DURATIONS_SEC.length - 1)];
      sessions.push({ index, plannedDurationSec, startEpoch: epochMs });
      log(`[flap-test] sessio ${index} alkoi (suunniteltu kesto ${plannedDurationSec}s)`);
    },
    onSessionEnd: (epochMs, ranMs) => {
      const s = sessions[sessions.length - 1];
      s.endEpoch = epochMs;
      s.ranMs = ranMs;
      log(`[flap-test] sessio ${s.index} päättyi, ajoaika ${Math.round(ranMs / 1000)}s`);
      if (sessions.length >= SESSION_DURATIONS_SEC.length) {
        mixer.stop();
      }
    },
  });

  const narrationTimer = setInterval(() => {
    clips.push({ enqueueEpoch: Date.now() });
    mixer.enqueueNarration(narrationPcm);
  }, NARRATION_CADENCE_MS);
  // Fire one immediately so session 0 gets a clip right away too.
  clips.push({ enqueueEpoch: Date.now() });
  mixer.enqueueNarration(narrationPcm);

  try {
    await mixer.start();
  } finally {
    clearInterval(narrationTimer);
  }

  log(`Ajo valmis: ${sessions.length} sessiota, ${clips.length} selostusklippiä lähetetty.`);

  // Respawn gaps: time between one session ending and the next starting —
  // the signal for the backoff-never-resets-under-60s finding (ffmpegMixer.ts
  // start(): backoffMs only resets to 1000 when a session ran >60s, so a run
  // of ~33s sessions climbs 1s->2->4->8->16->30s(capped) and stays there).
  const respawnGapsSec: number[] = [];
  for (let i = 1; i < sessions.length; i++) {
    const prevEnd = sessions[i - 1].endEpoch;
    const curStart = sessions[i].startEpoch;
    if (prevEnd != null && curStart != null) respawnGapsSec.push((curStart - prevEnd) / 1000);
  }

  // Map each clip to the session whose [start,end) window contains its
  // enqueue time (or "gap" if it fell in a backoff pause between sessions —
  // expected to be silently dropped by design, not itself a narration bug).
  const clipResults: Array<{
    enqueueEpoch: number;
    sessionIndex: number | null;
    offsetSec: number | null;
    meanVolumeDb: number | null;
    detected: boolean | null;
  }> = [];

  for (const clip of clips) {
    const session = findSessionForEpoch(sessions, clip.enqueueEpoch);
    if (!session || session.startEpoch == null) {
      clipResults.push({ enqueueEpoch: clip.enqueueEpoch, sessionIndex: null, offsetSec: null, meanVolumeDb: null, detected: null });
      continue;
    }
    const offsetSec = Math.max(0, (clip.enqueueEpoch - session.startEpoch) / 1000);
    const sessionFile = indexedRecordPath(recordFileBase, session.index);
    let meanVolumeDb: number | null = null;
    try {
      meanVolumeDb = await measureNarrationBandDb(sessionFile, offsetSec, NARRATION_CLIP_SEC + 0.5);
    } catch (err) {
      log(`Analyysivirhe (sessio ${session.index}, offset ${offsetSec.toFixed(1)}s): ${err instanceof Error ? err.message : err}`);
    }
    clipResults.push({
      enqueueEpoch: clip.enqueueEpoch,
      sessionIndex: session.index,
      offsetSec,
      meanVolumeDb,
      detected: meanVolumeDb == null ? null : meanVolumeDb > DETECTION_THRESHOLD_DB,
    });
  }

  const bySession = new Map<number, typeof clipResults>();
  for (const r of clipResults) {
    if (r.sessionIndex == null) continue;
    if (!bySession.has(r.sessionIndex)) bySession.set(r.sessionIndex, []);
    bySession.get(r.sessionIndex)!.push(r);
  }
  const sessionDetected = (i: number) => (bySession.get(i) ?? []).some((c) => c.detected === true);
  const sessionAllDetected = (i: number) => {
    const clipsForSession = bySession.get(i) ?? [];
    return clipsForSession.length > 0 && clipsForSession.every((c) => c.detected === true);
  };
  const sessionHasClips = (i: number) => (bySession.get(i) ?? []).length > 0;

  const longSessionIndex = SESSION_DURATIONS_SEC.findIndex((d, i) => i > 0 && d > 60);
  const shortPostRespawnIndices = SESSION_DURATIONS_SEC.map((_, i) => i).filter((i) => i > 0 && i !== longSessionIndex);
  const allSessionIndices = SESSION_DURATIONS_SEC.map((_, i) => i);

  let verdict: string;
  if (!sessionHasClips(0) || !sessionDetected(0)) {
    verdict =
      "Selostusta ei havaittu edes sessiossa 0 (ensimmäinen, ei respawnia) — tarkista ensin testihaaraston oma kytkentä " +
      "(enqueueNarration-kutsut, sävelkorkeuden kynnysarvo) ennen kuin tulosta tulkitaan tuotantobugiksi.";
  } else if (allSessionIndices.every((i) => sessionAllDetected(i))) {
    verdict =
      "EI REPRODUSOITU tällä ajolla: selostus kuului JOKAISESSA sessiossa (myös jokaisen respawnin jälkeen ja " +
      "90s-sessiossa) johdonmukaisella tasolla. Tämä ei tue mitään hypoteeseista (a)/(b)/(c) FfmpegMixerin/FIFOn/" +
      "amixin tasolla paikallisella nauhoituksella — vika ei siis todennäköisesti ole tässä putken osassa näillä " +
      "ehdoilla. Todennäköisimmät seuraavat epäilyt: (1) itse RTMP/YouTube-ingest-pää (tätä testiä ei koskaan " +
      "pushattu RTMP:llä, ks. DESIGN.md:n testaamaton riski '-c:v copy keyframe-välistä'), (2) kertymäefekti " +
      "todellisen ~15 min / kymmenien respawnien flappauksen yli (tässä vain 5 sykliä), tai (3) jokin oikean " +
      "CommentaryLoop/PiperTts-ketjun käyttäytyminen jota tämä testi ei kata (se kutsuu enqueueNarrationia suoraan)."
      ;
  } else if (shortPostRespawnIndices.every((i) => sessionHasClips(i) && !sessionDetected(i)) && longSessionIndex >= 0 && sessionDetected(longSessionIndex)) {
    verdict =
      "Hypoteesi (c) VAHVISTETTU: selostus katoaa lyhyillä (~33s) respawnin-jälkeisillä sessioilla mutta palaa pidemmällä " +
      "(90s) sessiolla — amix pudottaa narraatioinputin kun sessio on liian lyhyt sen bufferoinnille ennen lähteen EOF:ää.";
  } else if (shortPostRespawnIndices.every((i) => sessionHasClips(i) && !sessionDetected(i)) && longSessionIndex >= 0 && !sessionDetected(longSessionIndex)) {
    verdict =
      "Selostus katoaa KAIKISSA respawnin jälkeisissä sessioissa sessiopituudesta riippumatta (myös 90s-sessiossa) — " +
      "tämä sulkee pois hypoteesin (c) ja tukee hypoteesia (a) tai (b): FIFO/amix ei kytkeydy uudelleen respawnin " +
      "jälkeen, tai putken latenssi jättää selostuksen systemaattisesti auttamattoman myöhäiseksi. Jatkotutkinta " +
      "(esim. ffmpegin -loglevel debug amix/FIFO-lokeista respawnin ympäriltä) tarvitaan erottamaan a ja b toisistaan.";
  } else {
    verdict =
      "Sekava/epäjohdonmukainen kuvio — osa respawnin jälkeisistä sessioista sai selostuksen läpi, osa ei ilman selkeää " +
      "pituusriippuvuutta. Ei suoraa a/b/c-vahvistusta tästä ajosta; tarkista clips-taulukko käsin.";
  }

  const report = {
    sessionDurationsPlannedSec: SESSION_DURATIONS_SEC,
    sessions,
    respawnGapsSec,
    backoffGrewTowardCap: respawnGapsSec.length >= 3 && respawnGapsSec.slice(-1)[0] >= respawnGapsSec[0] * 4,
    clips: clipResults,
    verdict,
  };

  const reportPath = `${outDir}flap-test-report.json`;
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");

  log("=== YHTEENVETO ===");
  log(`Respawn-välit (s): ${respawnGapsSec.map((s) => s.toFixed(1)).join(", ")}`);
  log(`Raportti: ${reportPath}`);
  log(`Nauhoitteet: ${sessions.map((s) => indexedRecordPath(recordFileBase, s.index)).join(", ")}`);
  log(verdict);
  log("Muista poistaa relay/run/flap-test/ kun tulos on käsitelty — nauhoitteet vievät tilaa.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
