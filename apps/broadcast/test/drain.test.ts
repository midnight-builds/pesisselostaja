/** Issue #301: kun lähde päättyy, FIFO-jonossa oleva ja vielä syntetisoimaton
 *  selostus ajetaan loppuun katvekuvan päälle ennen relayn sammutusta.
 *
 *  Livenä 6.9.2026 (ottelu 135689): raakalähetys suljettiin puhelimesta, relay
 *  sammui heti ja puskuriin jäänyt häntä (201 s) katosi julkaisematta —
 *  loppuselostuksia ei ehditty puhua lainkaan. Ennen drainAfterEndiä tämän
 *  tiedoston skenaariot päättyivät välittömään sammutukseen: jono jäi
 *  puhumatta, eli jokainen "ajetaan loppuun" -väite kaatui nykykoodia vasten. */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FfmpegMixer } from "../src/ffmpegMixer.js";
import { FIFO_FRAME_BYTES } from "../src/narrationFifo.js";
import { NoSignalSlate, type SlateLayout } from "../src/noSignalSlate.js";

const LAYOUT: SlateLayout = {
  width: 1920,
  height: 1080,
  barsHeight: 626,
  fontBold: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  fontRegular: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  score: { y: 812, size: 58, color: "white", maxWidth: 1690 },
  status: { y: 892, size: 42, color: "0xB0B0B0", maxWidth: 1690 },
};

/** Sama ffmpeg-sijainen kuin katvetesteissä: avaa FIFOn lukijaksi (kättely
 *  valmistuu) ja elää kunnes tapetaan. */
function fakeFfmpeg(fifoPath: string, lifetimeMs = 600_000): ChildProcess {
  const script =
    `cat "$1" > /dev/null & reader=$!; ` +
    `trap 'kill $reader 2>/dev/null; exit 0' TERM; ` +
    `sleep ${lifetimeMs / 1000} & sleeper=$!; wait $sleeper; ` +
    `kill $reader 2>/dev/null; exit 0`;
  return spawn("sh", ["-c", script, "sh", fifoPath], { stdio: ["ignore", "ignore", "ignore"] });
}

let runDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), "pesis-drain-"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(runDir, { recursive: true, force: true });
});

async function preparedSlate(): Promise<NoSignalSlate> {
  const slate = new NoSignalSlate({
    matchId: 1,
    runDir,
    runGenerator: async (args) => {
      writeFileSync(args[args.indexOf("--out") + 1], Buffer.alloc(512));
      return `${JSON.stringify(LAYOUT)}\n`;
    },
  });
  await slate.prepare();
  return slate;
}

interface Opts {
  slate: NoSignalSlate | null;
  isMatchFinished?: () => boolean;
  spawns: string[][];
}

function harness(o: Opts): FfmpegMixer {
  return new FfmpegMixer({
    youtubeUrl: "https://example.invalid/live",
    rtmpUrl: "rtmp://example.invalid/live",
    streamKey: "avain",
    narrationGain: 1,
    fifoPath: join(runDir, "drain.pcm"),
    isMatchFinished: o.isMatchFinished ?? (() => true),
    slate: o.slate,
    spawnMixerProcess: (args) => {
      o.spawns.push(args);
      return fakeFfmpeg(join(runDir, "drain.pcm"));
    },
  });
}

/** ~sekunti puhetta: 50 kehystä à 20 ms. */
function oneSecondPcm(): Buffer {
  return Buffer.alloc(FIFO_FRAME_BYTES * 50);
}

describe("drainAfterEnd (#301)", () => {
  it("plays the queued narration to the end over the slate, then shuts down", async () => {
    const spawns: string[][] = [];
    const mixer = harness({ slate: await preparedSlate(), spawns });
    mixer.enqueueNarration(oneSecondPcm());
    expect(mixer.pendingClips).toBe(1);

    await mixer.drainAfterEnd({ maxMs: 30_000, waitForMatchEnd: true, pendingSynth: () => 0 });

    // Katvesessio spawnattiin (still-kuva + FIFO) ja jono ehti tyhjentyä
    // ENNEN sammutusta — nykykoodissa (ennen drainia) jono jäi täyteen.
    expect(spawns.length).toBe(1);
    expect(spawns[0].join(" ")).toContain("-loop 1");
    expect(mixer.pendingClips).toBe(0);
    expect(mixer.draining).toBe(false);
  }, 30_000);

  it("waits for the still-unsynthesized narration (pendingSynth) too", async () => {
    const spawns: string[][] = [];
    const mixer = harness({ slate: await preparedSlate(), spawns });
    // FIFO on tyhjä, mutta synthQueuessa on vielä klippi kesken — täsmälleen
    // se tila, jossa pelkkä FIFO-tarkistus lopettaisi puheen alta.
    let pendingSynth = 1;
    const enqueueLater = setTimeout(() => {
      mixer.enqueueNarration(oneSecondPcm());
      pendingSynth = 0;
    }, 1200);
    const started = Date.now();
    await mixer.drainAfterEnd({ maxMs: 30_000, waitForMatchEnd: true, pendingSynth: () => pendingSynth });
    clearTimeout(enqueueLater);
    // Drain odotti synteesin valmistumisen JA sen tuottaman klipin loppuun.
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
    expect(mixer.pendingClips).toBe(0);
  }, 30_000);

  it("holds until the match is recorded finished when waitForMatchEnd is set", async () => {
    const spawns: string[][] = [];
    let finished = false;
    const mixer = harness({ slate: await preparedSlate(), spawns, isMatchFinished: () => finished });
    setTimeout(() => {
      finished = true;
    }, 1500);
    const started = Date.now();
    await mixer.drainAfterEnd({ maxMs: 30_000, waitForMatchEnd: true, pendingSynth: () => 0 });
    // Ei lopetettu ennen kuin tulospalvelu kirjasi ottelun päättyneeksi.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    expect(spawns.length).toBe(1);
  }, 30_000);

  it("gives up at the hard cap when the finish never arrives", async () => {
    const spawns: string[][] = [];
    const mixer = harness({ slate: await preparedSlate(), spawns, isMatchFinished: () => false });
    const started = Date.now();
    await mixer.drainAfterEnd({ maxMs: 2000, waitForMatchEnd: true, pendingSynth: () => 0 });
    const elapsed = Date.now() - started;
    // Katto piti: ei jääty pyörittämään tyhjää slatea, mutta ei myöskään
    // lopetettu heti.
    expect(elapsed).toBeGreaterThanOrEqual(2000);
    expect(elapsed).toBeLessThan(15_000);
  }, 30_000);

  it("does nothing when there is nothing to play and the match is over", async () => {
    const spawns: string[][] = [];
    const mixer = harness({ slate: await preparedSlate(), spawns });
    await mixer.drainAfterEnd({ maxMs: 30_000, waitForMatchEnd: true, pendingSynth: () => 0 });
    // Normaalitapaus: lopetus on jo puhuttu ennen raakalähetyksen loppua —
    // ei katvekuvaa, ei viivettä.
    expect(spawns.length).toBe(0);
  }, 10_000);

  it("is a no-op when the cap is zero (drain disabled)", async () => {
    const spawns: string[][] = [];
    const mixer = harness({ slate: await preparedSlate(), spawns });
    mixer.enqueueNarration(oneSecondPcm());
    await mixer.drainAfterEnd({ maxMs: 0, waitForMatchEnd: true, pendingSynth: () => 0 });
    expect(spawns.length).toBe(0);
    expect(mixer.pendingClips).toBe(1);
  }, 10_000);

  it("skips (with the old immediate-shutdown behaviour) when no slate is available", async () => {
    const spawns: string[][] = [];
    const mixer = harness({ slate: null, spawns });
    mixer.enqueueNarration(oneSecondPcm());
    await mixer.drainAfterEnd({ maxMs: 30_000, waitForMatchEnd: true, pendingSynth: () => 0 });
    expect(spawns.length).toBe(0);
  }, 10_000);
});
