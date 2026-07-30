import { describe, it, expect, vi, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { unlink } from "node:fs/promises";
import { FfmpegMixer, SourceExhaustedError } from "../src/ffmpegMixer.js";

/** Hard stop -takaraja (#123): relay sammuttaa itsensä kun ottelu on
 *  päättynyt, tulospalvelu on ollut hiljaa yli rajan JA lähde oireilee
 *  (#121:n 34s/34s-häntäkuvio tai toistuva ffmpeg.unproductive).
 *
 *  Fake-spawn-tyyli kuten ffmpegMixerShortSession.test.ts: sijaisprosessi
 *  avaa FIFOn lukijana (= kädenpuristus onnistuu), elää lifetimeMs ja
 *  poistuu annetulla koodilla. Kaikki nimet/urlit fiktiivisiä. */
function fakeFfmpeg(fifoPath: string, lifetimeMs: number, exitCode = 0): ChildProcess {
  const script =
    `cat "$1" > /dev/null & reader=$!; ` +
    `trap 'kill $reader 2>/dev/null; exit 0' TERM; ` +
    `sleep ${lifetimeMs / 1000} & sleeper=$!; wait $sleeper; ` +
    `kill $reader 2>/dev/null; exit ${exitCode}`;
  return spawn("sh", ["-c", script, "sh", fifoPath], {
    stdio: ["ignore", "ignore", "ignore"],
  });
}

interface HardStopMixerOpts {
  fifoPath: string;
  /** n:nnen fake-session kesto ms; viimeinen arvo toistuu. */
  lifetimesMs: number[];
  /** n:nnen fake-session poistumiskoodi; viimeinen arvo toistuu. Oletus 0. */
  exitCodes?: number[];
  finished: boolean;
  /** Viimeisimmän tapahtuman ikä ms, tai null = ei tietoa. */
  lastEventAgeMs: number | null;
  hardStopQuietMs: number;
  minProductiveRunMs?: number;
  finishedFailureWindowMs?: number;
  maxFailureWindowMs?: number;
}

function hardStopMixer(o: HardStopMixerOpts): FfmpegMixer {
  let index = 0;
  const pick = <T>(arr: T[] | undefined, fallback: T): T =>
    arr && arr.length > 0 ? arr[Math.min(index, arr.length - 1)]! : fallback;
  return new FfmpegMixer({
    youtubeUrl: "https://example.invalid/live",
    rtmpUrl: "",
    streamKey: "",
    narrationGain: 1.3,
    fifoPath: o.fifoPath,
    isMatchFinished: () => o.finished,
    lastEventAt: () =>
      o.lastEventAgeMs === null ? null : new Date(Date.now() - o.lastEventAgeMs).toISOString(),
    hardStopQuietMs: o.hardStopQuietMs,
    minProductiveRunMs: o.minProductiveRunMs ?? 10_000,
    // Suuret luovutusikkunat oletuksena, jotta testit erottavat hard stopin
    // tavallisesta ikkunaluovutuksesta; yksittäinen testi kiristää tarpeen
    // mukaan.
    finishedFailureWindowMs: o.finishedFailureWindowMs ?? 10 * 60 * 1000,
    maxFailureWindowMs: o.maxFailureWindowMs ?? 10 * 60 * 1000,
    urlRefreshMs: 15 * 60 * 1000,
    resolveTestSource: () => "/dev/null",
    spawnMixerProcess: () => {
      const lifetime = pick(o.lifetimesMs, 200);
      const code = pick(o.exitCodes, 0);
      index++;
      return fakeFfmpeg(o.fifoPath, lifetime, code);
    },
  });
}

/** Ajaa mixerin loppuun ja palauttaa lopputuloksen luokiteltuna. */
async function outcomeOf(
  mixer: FfmpegMixer,
  timeoutMs: number
): Promise<{ kind: "still-running" | "resolved" } | { kind: "gave-up"; err: SourceExhaustedError }> {
  const result = await Promise.race([
    mixer
      .start()
      .then(() => ({ kind: "resolved" as const }))
      .catch((err) => {
        if (err instanceof SourceExhaustedError) return { kind: "gave-up" as const, err };
        throw err;
      }),
    new Promise<{ kind: "still-running" }>((r) =>
      setTimeout(() => r({ kind: "still-running" }), timeoutMs)
    ),
  ]);
  mixer.stop();
  return result;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of ["a", "b", "c", "d", "e", "f"]) {
    await unlink(`/tmp/pesis-test-hard-stop-${p}.pcm`).catch(() => undefined);
  }
});

describe("hard stop -takaraja (#123)", () => {
  it("EI laukea kesken ottelun, vaikka hiljaisuus ja oireet täyttyisivät (ehto 1)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mixer = hardStopMixer({
      fifoPath: "/tmp/pesis-test-hard-stop-a.pcm",
      lifetimesMs: [200], // identtiset lyhyet code=0-sessiot = oireet päällä
      finished: false, // ottelu KESKEN — ehdoton portti
      lastEventAgeMs: 10 * 60 * 1000, // 10 min hiljaisuutta
      hardStopQuietMs: 50,
      maxFailureWindowMs: 100, // tavallinen ikkuna umpeutuu nopeasti
    });
    const outcome = await outcomeOf(mixer, 15_000);
    expect(outcome.kind).toBe("gave-up");
    if (outcome.kind === "gave-up") {
      // Luovutus tuli tavallisesta ikkunasta, EI hard stopista.
      expect(outcome.err.reason).toBe("exhausted");
    }
  }, 20_000);

  it("EI laukea kun sessiot ovat terveitä ja pitkiä (ehto 3)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const mixer = hardStopMixer({
      fifoPath: "/tmp/pesis-test-hard-stop-b.pcm",
      lifetimesMs: [500],
      minProductiveRunMs: 100, // 500 ms on tässä "oikeaa lähetystä"
      finished: true,
      lastEventAgeMs: 10 * 60 * 1000,
      hardStopQuietMs: 50,
      // Naurettavan lyhyet ikkunat: tuottava ajo ei saa kerryttää mitään.
      finishedFailureWindowMs: 50,
      maxFailureWindowMs: 50,
    });
    const outcome = await outcomeOf(mixer, 2500);
    expect(outcome.kind).toBe("still-running");
  }, 20_000);

  it("EI laukea kun hiljaisuus on alle rajan (ehto 2)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mixer = hardStopMixer({
      fifoPath: "/tmp/pesis-test-hard-stop-c.pcm",
      lifetimesMs: [200], // oireet päällä
      finished: true,
      lastEventAgeMs: 0, // tapahtuma juuri äsken — hiljaisuusehto EI täyty
      hardStopQuietMs: 60 * 60 * 1000,
      finishedFailureWindowMs: 100,
    });
    const outcome = await outcomeOf(mixer, 15_000);
    expect(outcome.kind).toBe("gave-up");
    if (outcome.kind === "gave-up") {
      expect(outcome.err.reason).toBe("exhausted");
    }
  }, 20_000);

  it("laukeaa: ottelu päättynyt + hiljaisuus + 2× ffmpeg.unproductive", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mixer = hardStopMixer({
      fifoPath: "/tmp/pesis-test-hard-stop-d.pcm",
      // Kestot EIVÄT ole ±20 % toisistaan, joten parikuvio ei laukea —
      // laukaisijaksi jää nimenomaan unproductive-laskuri (oire b).
      lifetimesMs: [200, 600],
      finished: true,
      lastEventAgeMs: 3 * 60 * 1000,
      hardStopQuietMs: 180_000,
    });
    const outcome = await outcomeOf(mixer, 15_000);
    expect(outcome.kind).toBe("gave-up");
    if (outcome.kind === "gave-up") {
      expect(outcome.err.reason).toBe("hard_stop");
      expect(outcome.err.message).toMatch(/unproductive/);
    }
  }, 20_000);

  it("laukeaa parikuviosta: kaksi lähes samanmittaista lyhyttä code=0-sessiota (#121)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mixer = hardStopMixer({
      fifoPath: "/tmp/pesis-test-hard-stop-e.pcm",
      lifetimesMs: [300], // sama kesto joka kerta — 145900:n 34s/34s-kuvio
      finished: true,
      lastEventAgeMs: 10 * 60 * 1000,
      hardStopQuietMs: 180_000,
    });
    const outcome = await outcomeOf(mixer, 15_000);
    expect(outcome.kind).toBe("gave-up");
    if (outcome.kind === "gave-up") {
      expect(outcome.err.reason).toBe("hard_stop");
      expect(outcome.err.message).toMatch(/code=0/);
    }
  }, 20_000);

  it("EI laukea kun lastEventAt on null — ei tietoa ei ole hiljaisuutta", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mixer = hardStopMixer({
      fifoPath: "/tmp/pesis-test-hard-stop-f.pcm",
      lifetimesMs: [200], // oireet päällä
      finished: true,
      lastEventAgeMs: null,
      hardStopQuietMs: 50,
      finishedFailureWindowMs: 100,
    });
    const outcome = await outcomeOf(mixer, 15_000);
    expect(outcome.kind).toBe("gave-up");
    if (outcome.kind === "gave-up") {
      expect(outcome.err.reason).toBe("exhausted");
    }
  }, 20_000);
});
