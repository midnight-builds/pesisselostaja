import { describe, it, expect, vi, afterEach } from "vitest";
import { writeFileSync, rmSync, readFileSync } from "node:fs";
import { FfmpegMixer } from "../src/ffmpegMixer.js";
import { CommentaryLoop } from "../src/commentaryLoop.js";
import type { RelayConfig } from "../src/config.js";

/** Selostuksen gainin ajonaikainen säätö (#244).
 *
 *  Ottelussa 136770 (16.8.2026) kentän äänet olivat liian hiljaa suhteessa
 *  selostukseen, eikä suhdetta voinut säätää ilman `.env.relay`-muokkausta ja
 *  relayn restarttia — eli katkoa selostettuun lähetykseen kesken ottelun.
 *  Nyt arvo tulee control-tiedostosta ja mikseri skaalaa klipin PCM:n, joten
 *  ffmpegin graafiin (ja siten lähetykseen) ei kosketa. */

function pcm(...samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

function samplesOf(buf: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < buf.length; i += 2) out.push(buf.readInt16LE(i));
  return out;
}

interface MixerInternals {
  fifo: { enqueue(pcm: Buffer): void };
}

/** Mikseri, jonka FIFO on korvattu keräimellä — mitään ei kirjoiteta levylle. */
function mixerWithGain(baked: number, now?: () => number): { enqueued: Buffer[]; mixer: FfmpegMixer } {
  const mixer = new FfmpegMixer({
    youtubeUrl: "https://example.invalid/live",
    rtmpUrl: "",
    streamKey: "",
    narrationGain: baked,
    maxQueuedNarrationMs: 0,
    fifoPath: "/tmp/pesis-test-gain-unused.pcm",
    narrationGainNow: now,
  });
  const enqueued: Buffer[] = [];
  (mixer as unknown as MixerInternals).fifo = { enqueue: (b: Buffer) => void enqueued.push(b) };
  return { enqueued, mixer };
}

describe("mikseri skaalaa klipin gainiin (#244)", () => {
  it("ei koske puskuriin kun haluttu arvo on sama kuin ffmpegiin leivottu", () => {
    const { enqueued, mixer } = mixerWithGain(1.3, () => 1.3);
    const clip = pcm(1000, -1000);
    mixer.enqueueNarration(clip);
    // Identiteetti: säätämättömässä ajossa käytös on bitilleen entinen.
    expect(enqueued[0]).toBe(clip);
  });

  it("skaalaa erotuksella haluttu/leivottu, jotta ffmpegin läpi tulee haluttu", () => {
    // Leivottu 1.3, haluttu 0.65 → PCM puolitetaan; ffmpegin volume=1.3 nostaa
    // sen takaisin, ja lopputulos vastaa gainia 0.65.
    const { enqueued, mixer } = mixerWithGain(1.3, () => 0.65);
    mixer.enqueueNarration(pcm(1000, -2000));
    expect(samplesOf(enqueued[0]!)).toEqual([500, -1000]);
  });

  it("lukee arvon JOKA klipille, ei kerran käynnistyksessä", () => {
    let wanted = 1.3;
    const { enqueued, mixer } = mixerWithGain(1.3, () => wanted);
    mixer.enqueueNarration(pcm(1000));
    wanted = 0.65; // operaattori säätää kesken lähetyksen
    mixer.enqueueNarration(pcm(1000));
    expect(samplesOf(enqueued[0]!)).toEqual([1000]);
    expect(samplesOf(enqueued[1]!)).toEqual([500]);
  });

  it("ilman ajonaikaista säätöä (simulate, testit) puskuri menee läpi sellaisenaan", () => {
    const { enqueued, mixer } = mixerWithGain(1.3);
    const clip = pcm(1000);
    mixer.enqueueNarration(clip);
    expect(enqueued[0]).toBe(clip);
  });

  it("varoittaa leikkauksesta kerran klippiä kohti, ei kerran näytettä kohti", () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(String(a[0]));
    });
    try {
      const { mixer } = mixerWithGain(1, () => 4);
      mixer.enqueueNarration(pcm(30000, -30000, 20000, 100));
      const warnings = lines.filter((l) => l.includes("leikkasi"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/3 näytettä/);
    } finally {
      spy.mockRestore();
    }
  });

  it("ei jaa nollalla kun leivottu gain on 0", () => {
    const { enqueued, mixer } = mixerWithGain(0, () => 1.3);
    const clip = pcm(1000);
    expect(() => mixer.enqueueNarration(clip)).not.toThrow();
    // ffmpeg vaimentaa selostuksen nollaan joka tapauksessa; PCM:llä ei ole
    // asiaan mitään sanottavaa, joten se menee läpi koskemattomana.
    expect(enqueued[0]).toBe(clip);
  });
});

const controlFile = "/tmp/pesis-test-control-gain.json";

function makeConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    matchId: 900001,
    youtubeUrl: "https://example.invalid/live",
    rtmpUrl: "", streamKey: "",
    voice: "harri-medium", piperBin: "piper",
    pollInterval: 3000, narrationGain: 1.3, narrationDelayMs: 0, maxQueuedNarrationMs: 0, firstSpeechDelayMs: 0,
    urlRefreshMs: 900000, ytdlpExtractorArgs: "", maxFailureWindowMs: 720000,
    finishedFailureWindowMs: 120000, hardStopQuietMs: 180000,
    noSignalSlate: false, noSignalSlateAfterMs: 8000,
    noSignalSlateWidth: 1920, noSignalSlateHeight: 1080,
    deltaFetch: true,
    pollTrace: false, announceBatterChanges: true, dryRun: false,
    apiKey: "test", apiBase: "https://example.invalid/api",
    stateFile: "/tmp/pesis-test-nonexistent-state.json",
    runDir: "/tmp/",
    runRetentionDays: 0,
    ttsCacheMaxBytes: 0,
    pronunciationsFile: "/tmp/pesis-test-nonexistent-pron.json",
    controlFile,
    elevenLabsVoiceId: "x", elevenLabsModelId: "y",
    ...overrides,
  };
}

interface LoopInternals {
  refreshRuntimeControls(): Promise<void>;
  writeControlFile(): void;
  narrationGain: number;
}

function makeLoop(overrides: Partial<RelayConfig> = {}): LoopInternals {
  return new CommentaryLoop(makeConfig(overrides), async () => {}) as unknown as LoopInternals;
}

describe("loop lukee gainin control-tiedostosta (#244)", () => {
  afterEach(() => rmSync(controlFile, { force: true }));

  it("alustaa configista ja vaihtaa arvon ajon aikana", async () => {
    const loop = makeLoop();
    expect(loop.narrationGain).toBe(1.3);

    writeFileSync(controlFile, JSON.stringify({ narrationGain: 0.9 }));
    await loop.refreshRuntimeControls();
    expect(loop.narrationGain).toBe(0.9);
  });

  it("kirjoittaa voimassa olevan arvon tiedostoon, jotta ohjaamo näkee sen", () => {
    const loop = makeLoop({ narrationGain: 0.9 });
    loop.writeControlFile();
    expect(JSON.parse(readFileSync(controlFile, "utf8")).narrationGain).toBe(0.9);
  });

  it("säilyttää operaattorin säädön käynnistyksessä (#206)", () => {
    writeFileSync(controlFile, JSON.stringify({ narrationGain: 0.75 }));
    const loop = makeLoop({ narrationGain: 1.3 });
    loop.writeControlFile();
    // Kesken ottelun korvakuulolta haettu tasapaino on tuoreinta tietoa, ei
    // jäänne — restart ei saa palauttaa oletusta hiljaisesti.
    expect(loop.narrationGain).toBe(0.75);
    expect(JSON.parse(readFileSync(controlFile, "utf8")).narrationGain).toBe(0.75);
  });

  it("kiinnittää arvon välille [0, 4] eikä hyväksy roskaa", async () => {
    const loop = makeLoop();

    writeFileSync(controlFile, JSON.stringify({ narrationGain: 13 })); // 1.3 väärin näpättynä
    await loop.refreshRuntimeControls();
    expect(loop.narrationGain).toBe(4);

    writeFileSync(controlFile, JSON.stringify({ narrationGain: -2 }));
    await loop.refreshRuntimeControls();
    expect(loop.narrationGain).toBe(0);

    writeFileSync(controlFile, JSON.stringify({ narrationGain: "kovaa" }));
    await loop.refreshRuntimeControls();
    expect(loop.narrationGain).toBe(0); // epäkelpo arvo jätetään huomiotta
  });
});
