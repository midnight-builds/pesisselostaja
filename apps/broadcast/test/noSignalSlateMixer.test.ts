import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FfmpegMixer,
  SourceExhaustedError,
  buildSlateFfmpegArgs,
  buildSlateMixFilterComplex,
  buildSlateVideoFilter,
  escapeFilterPath,
  SLATE_REASON_LOST,
  SLATE_REASON_WAITING,
  type SourceIngestObservation,
} from "../src/ffmpegMixer.js";
import { NoSignalSlate, type SlateLayout } from "../src/noSignalSlate.js";

const LAYOUT: SlateLayout = {
  width: 1920,
  height: 1080,
  barsHeight: 626,
  fontBold: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  fontRegular: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  score: { y: 812, size: 58, color: "white" },
  status: { y: 892, size: 42, color: "0xB0B0B0" },
};

/** Sama ffmpeg-sijainen kuin ffmpegMixerShortSession.test.ts:ssä (ks.
 *  docs/adr/0002): avaa FIFOn lukijaksi — se on mikä viimeistelee kättelyn —
 *  ja elää kunnes se tapetaan. Katvesession pitää käyttäytyä juuri näin:
 *  se elää kunnes lähde palaa tai relay luovuttaa. */
function fakeFfmpeg(fifoPath: string, lifetimeMs = 600_000): ChildProcess {
  const script =
    `cat "$1" > /dev/null & reader=$!; ` +
    `trap 'kill $reader 2>/dev/null; exit 0' TERM; ` +
    `sleep ${lifetimeMs / 1000} & sleeper=$!; wait $sleeper; ` +
    `kill $reader 2>/dev/null; exit 0`;
  return spawn("sh", ["-c", script, "sh", fifoPath], { stdio: ["ignore", "ignore", "ignore"] });
}

/** Prosessi joka kuolee heti — katvetilassa se on "ffmpeg kaatui". */
function deadFfmpeg(): ChildProcess {
  return spawn("sh", ["-c", "exit 1"], { stdio: ["ignore", "ignore", "ignore"] });
}

function isSlateSpawn(args: string[]): boolean {
  return args.includes("-loop");
}

describe("FfmpegMixer no-signal slate (issue #104)", () => {
  let runDir: string;
  let fifoPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), "pesis-slate-mixer-"));
    fifoPath = join(runDir, "relay-1.pcm");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    rmSync(runDir, { recursive: true, force: true });
  });

  function logged(): string {
    return logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
  }

  /** Katvekuva ilman generaattoria: kirjoittaa kuvan ja tulostaa sovitun
   *  layout-JSONin, joten koko katveketju on testattavissa ilman python3:a,
   *  PIL:iä tai ffmpeg-binääriä. */
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

  interface HarnessOpts {
    slate: NoSignalSlate | null;
    slateAfterMs?: number;
    /** Lähdeosoitteen ratkaisu; heittää kun lähdettä ei ole. */
    resolveTestSource: () => Promise<string> | string;
    maxFailureWindowMs?: number;
    isMatchFinished?: () => boolean;
    sourceIngest?: () => SourceIngestObservation | null;
    spawns: string[][];
    /** Mitä spawnataan; oletuksena pitkäikäinen sijainen. */
    spawnFor?: (args: string[]) => ChildProcess;
  }

  function harness(o: HarnessOpts): FfmpegMixer {
    return new FfmpegMixer({
      youtubeUrl: "https://example.invalid/live",
      rtmpUrl: "rtmp://example.invalid/live",
      streamKey: "avain",
      narrationGain: 1.3,
      fifoPath,
      // Anteliaat oletukset: näissä testeissä luovuttaminen on poikkeus, ei
      // odotettu lopputulos (paitsi siinä testissä joka nimenomaan mittaa sen).
      maxFailureWindowMs: o.maxFailureWindowMs ?? 10 * 60 * 1000,
      finishedFailureWindowMs: 10 * 60 * 1000,
      minProductiveRunMs: 60_000,
      isMatchFinished: o.isMatchFinished,
      resolveTestSource: o.resolveTestSource,
      slate: o.slate,
      slateAfterMs: o.slateAfterMs,
      sourceIngest: o.sourceIngest,
      spawnMixerProcess: (args) => {
        o.spawns.push(args);
        return (o.spawnFor ?? (() => fakeFfmpeg(fifoPath)))(args);
      },
    });
  }

  /** Ajaa valvojaa kunnes ehto täyttyy tai aika loppuu, ja pysäyttää sen. */
  async function runUntil(
    mixer: FfmpegMixer,
    condition: () => boolean,
    timeoutMs: number
  ): Promise<"condition" | "gave-up" | "timeout"> {
    const outcome = await Promise.race([
      mixer.start().then(
        () => "gave-up" as const,
        (e) => (e instanceof SourceExhaustedError ? ("gave-up" as const) : Promise.reject(e))
      ),
      (async () => {
        const until = Date.now() + timeoutMs;
        while (Date.now() < until) {
          if (condition()) return "condition" as const;
          await new Promise((r) => setTimeout(r, 50));
        }
        return "timeout" as const;
      })(),
    ]);
    mixer.stop();
    await new Promise((r) => setTimeout(r, 100));
    return outcome;
  }

  const noSource = (): never => {
    throw new Error("ei lähdettä (testin tarkoituksella)");
  };

  it("does NOT show the slate for a blip shorter than the threshold", async () => {
    const spawns: string[][] = [];
    const mixer = harness({
      slate: await preparedSlate(),
      slateAfterMs: 60_000, // kynnys kaukana tulevaisuudessa
      resolveTestSource: noSource,
      spawns,
    });
    const outcome = await runUntil(mixer, () => spawns.some(isSlateSpawn), 2500);
    expect(outcome).toBe("timeout");
    expect(spawns).toHaveLength(0); // sekunnin blippi ei vilkuta kuvaa
  }, 20000);

  it("starts the slate once the threshold passes, with the right ffmpeg args", async () => {
    const slate = await preparedSlate();
    const spawns: string[][] = [];
    const mixer = harness({ slate, slateAfterMs: 0, resolveTestSource: noSource, spawns });

    const outcome = await runUntil(mixer, () => spawns.some(isSlateSpawn), 6000);
    expect(outcome).toBe("condition");

    const args = spawns.find(isSlateSpawn)!;
    // Still-kuva reaaliaikaisella tahdilla, ei niin nopeasti kuin ffmpeg ehtii.
    expect(args.join(" ")).toContain("-loop 1 -framerate 10 -re -i " + slate.imagePath);
    // Sama selostus-FIFO kuin lähdeversiossa.
    expect(args).toContain(fifoPath);
    // Still-kuvaa EI voi kopioida läpi.
    expect(args).toContain("libx264");
    expect(args).not.toContain("copy");
    // Molemmat tekstirivit tulevat tiedostosta ja päivittyvät ilman respawnia.
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain(escapeFilterPath(slate.scoreTextPath));
    expect(filter).toContain(escapeFilterPath(slate.statusTextPath));
    expect(filter.match(/reload=1/g)).toHaveLength(2);
    // Sama RTMP-kohde kuin lähdeversiolla.
    expect(args.slice(-2)).toEqual(["flv", "rtmp://example.invalid/live/avain"]);
    expect(logged()).toContain("ffmpeg.slate_start");
  }, 25000);

  it("ends the slate and starts a source session the moment the source returns", async () => {
    const spawns: string[][] = [];
    let attempts = 0;
    const mixer = harness({
      slate: await preparedSlate(),
      slateAfterMs: 0,
      resolveTestSource: () => {
        attempts++;
        if (attempts <= 1) throw new Error("ei vielä lähdettä");
        return "/dev/null";
      },
      spawns,
    });

    const outcome = await runUntil(mixer, () => spawns.some((a) => !isSlateSpawn(a)), 12000);
    expect(outcome).toBe("condition");
    // Ensin katve, sitten lähde — tässä järjestyksessä.
    expect(isSlateSpawn(spawns[0])).toBe(true);
    expect(isSlateSpawn(spawns[spawns.length - 1])).toBe(false);
    expect(logged()).toContain("Katvekuva pois: lähde palasi");
  }, 25000);

  /** Kaksi ffmpegiä samaan RTMP-avaimeen katkaisee lähetyksen YouTuben päässä.
   *  Lähdepolku ei voi joutua tähän (spawnOnce odottaa childDonea), mutta
   *  katvepolku lopettaa sessionsa itse valitsemallaan hetkellä — ennen
   *  eskalointia purku palasi 5 s kuluttua riippumatta siitä kuoliko prosessi. */
  it("never spawns the source session while the slate ffmpeg is still alive", async () => {
    const spawns: string[][] = [];
    let slateChild: ChildProcess | null = null;
    let aliveAtSourceSpawn: boolean | null = null;
    let attempts = 0;

    const mixer = harness({
      slate: await preparedSlate(),
      slateAfterMs: 0,
      resolveTestSource: () => {
        attempts++;
        if (attempts <= 1) throw new Error("ei vielä lähdettä");
        return "/dev/null";
      },
      spawns,
      spawnFor: (args) => {
        if (isSlateSpawn(args)) {
          // Katveprosessi joka EI kuole SIGTERMistä — vain SIGKILL tehoaa.
          // Pitää FIFOn auki, jotta kättely valmistuu kuten oikealla ffmpegillä.
          slateChild = spawn(
            "sh",
            ["-c", `cat "$1" > /dev/null & trap '' TERM; sleep 30 & wait`, "sh", fifoPath],
            { stdio: ["ignore", "ignore", "ignore"] }
          );
          return slateChild;
        }
        // Lähdesession spawn-hetkellä katveprosessin ON oltava jo kuollut.
        aliveAtSourceSpawn = slateChild !== null && slateChild.exitCode === null && slateChild.signalCode === null;
        return fakeFfmpeg(fifoPath);
      },
    });

    const outcome = await runUntil(mixer, () => spawns.some((a) => !isSlateSpawn(a)), 20000);
    expect(outcome).toBe("condition");
    expect(aliveAtSourceSpawn).toBe(false);
    expect(slateChild!.signalCode).toBe("SIGKILL");
    expect(logged()).toContain("SIGKILL");
  }, 40000);

  /** TÄRKEIN TESTI. Katvekuvan työntäminen ei saa nollata luovutusikkunaa
   *  eikä laskea tuottavaksi ajoksi — muuten relay jäisi työntämään
   *  väripalkkeja tyhjään lähetykseen ikuisesti. */
  it("still gives up on the normal schedule while the slate is running", async () => {
    const spawns: string[][] = [];
    const mixer = harness({
      slate: await preparedSlate(),
      slateAfterMs: 0,
      maxFailureWindowMs: 50, // ensimmäinen katvetilan koetin ylittää tämän
      resolveTestSource: noSource,
      spawns,
    });

    await expect(mixer.start()).rejects.toThrow(SourceExhaustedError);

    // …ja katve todella oli päällä, eli luovutus tapahtui SEN AIKANA.
    expect(spawns.some(isSlateSpawn)).toBe(true);
    expect(logged()).toContain("ffmpeg.slate_end");
    mixer.stop();
  }, 25000);

  it("never starts the slate once the match has finished", async () => {
    const spawns: string[][] = [];
    const mixer = harness({
      slate: await preparedSlate(),
      slateAfterMs: 0,
      isMatchFinished: () => true,
      resolveTestSource: noSource,
      spawns,
    });
    const outcome = await runUntil(mixer, () => spawns.some(isSlateSpawn), 2500);
    expect(outcome).toBe("timeout");
    expect(spawns).toHaveLength(0);
  }, 20000);

  it("skips the slate entirely when the generator failed — behaviour is unchanged", async () => {
    const spawns: string[][] = [];
    const broken = new NoSignalSlate({
      matchId: 1,
      runDir,
      runGenerator: async () => {
        throw new Error("spawn python3 ENOENT");
      },
    });
    await expect(broken.prepare()).resolves.toBe(false);

    const mixer = harness({ slate: broken, slateAfterMs: 0, resolveTestSource: noSource, spawns });
    const outcome = await runUntil(mixer, () => spawns.length > 0, 2500);
    expect(outcome).toBe("timeout");
    expect(spawns).toHaveLength(0);
  }, 20000);

  it("spawns no slate at all when the feature is off (RELAY_NO_SIGNAL_SLATE=false)", async () => {
    const spawns: string[][] = [];
    // index.ts välittää null kun asetus on pois — sama polku kuin oletuksena.
    const mixer = harness({ slate: null, slateAfterMs: 0, resolveTestSource: noSource, spawns });
    const outcome = await runUntil(mixer, () => spawns.length > 0, 2500);
    expect(outcome).toBe("timeout");
    expect(spawns).toHaveLength(0);
  }, 20000);

  it("disables the slate for the rest of the run — once — if its ffmpeg dies mid-session", async () => {
    const spawns: string[][] = [];
    const mixer = harness({
      slate: await preparedSlate(),
      slateAfterMs: 0,
      resolveTestSource: noSource,
      spawns,
      // Kättely onnistuu, mutta prosessi kuolee alta sekunnin päästä.
      spawnFor: (args) => fakeFfmpeg(fifoPath, isSlateSpawn(args) ? 700 : 600_000),
    });
    const outcome = await runUntil(mixer, () => spawns.filter(isSlateSpawn).length > 1, 8000);
    expect(outcome).toBe("timeout");
    expect(spawns.filter(isSlateSpawn)).toHaveLength(1);
    expect(logged()).toContain("kuoli kesken session");
  }, 25000);

  it("disables the slate for the rest of the run — once — if its ffmpeg dies", async () => {
    const spawns: string[][] = [];
    const mixer = harness({
      slate: await preparedSlate(),
      slateAfterMs: 0,
      resolveTestSource: noSource,
      spawns,
      spawnFor: (args) => (isSlateSpawn(args) ? deadFfmpeg() : fakeFfmpeg(fifoPath)),
    });
    // Annetaan reilusti aikaa: ilman kertakytkintä katve yrittäisi joka
    // respawn-kierroksella uudelleen.
    const outcome = await runUntil(mixer, () => spawns.filter(isSlateSpawn).length > 1, 6000);
    expect(outcome).toBe("timeout");
    expect(spawns.filter(isSlateSpawn)).toHaveLength(1);
    expect(logged()).toContain("Katvekuva pois käytöstä tältä ajolta");
  }, 25000);

  /** Turvallisuusvaatimus 2 yleisessä muodossa: MIKÄ TAHANSA katveketjun vika
   *  johtaa nykyiseen käytökseen, ei valvojan kaatumiseen. Tässä spawn itse
   *  heittää (esim. rikkinäinen ffmpeg-polku). */
  it("never lets a throwing slate spawn take the supervisor down", async () => {
    const spawns: string[][] = [];
    const mixer = harness({
      slate: await preparedSlate(),
      slateAfterMs: 0,
      resolveTestSource: noSource,
      spawns,
      spawnFor: (args) => {
        if (isSlateSpawn(args)) throw new Error("spawn ffmpeg ENOENT");
        return fakeFfmpeg(fifoPath);
      },
    });
    // Ei heittoa ulos: silmukka jatkaa lähteen yrittämistä kuten ennenkin.
    const outcome = await runUntil(mixer, () => spawns.filter(isSlateSpawn).length > 1, 5000);
    expect(outcome).toBe("timeout");
    expect(spawns.filter(isSlateSpawn)).toHaveLength(1);
    expect(logged()).toContain("Katvekuva pois käytöstä tältä ajolta");
  }, 25000);

  describe("sourceIngest — ohjaamon havainto on vapaaehtoinen tulo", () => {
    const ingest = (over: Partial<SourceIngestObservation> = {}): SourceIngestObservation => ({
      observedAt: new Date().toISOString(),
      videoId: "abc123",
      lifeCycleStatus: "live",
      streamStatus: "inactive",
      healthStatus: "noData",
      error: null,
      ...over,
    });

    it("blocks the slate when a FRESH observation says the broadcast is complete", async () => {
      const spawns: string[][] = [];
      const mixer = harness({
        slate: await preparedSlate(),
        slateAfterMs: 0,
        resolveTestSource: noSource,
        sourceIngest: () => ingest({ lifeCycleStatus: "complete" }),
        spawns,
      });
      const outcome = await runUntil(mixer, () => spawns.some(isSlateSpawn), 2500);
      expect(outcome).toBe("timeout");
      expect(spawns).toHaveLength(0);
    }, 20000);

    it("ignores a STALE observation entirely — vanhentunut on 'ei tietoa', ei 'poikki'", async () => {
      const spawns: string[][] = [];
      const mixer = harness({
        slate: await preparedSlate(),
        slateAfterMs: 0,
        resolveTestSource: noSource,
        // Sama "complete", mutta 10 min vanha: ei saa vaikuttaa mihinkään.
        sourceIngest: () =>
          ingest({ lifeCycleStatus: "complete", observedAt: new Date(Date.now() - 600_000).toISOString() }),
        spawns,
      });
      const outcome = await runUntil(mixer, () => spawns.some(isSlateSpawn), 6000);
      expect(outcome).toBe("condition");
    }, 25000);

    it("ignores a missing or malformed observation", async () => {
      const spawns: string[][] = [];
      const mixer = harness({
        slate: await preparedSlate(),
        slateAfterMs: 0,
        resolveTestSource: noSource,
        sourceIngest: () => null,
        spawns,
      });
      const outcome = await runUntil(mixer, () => spawns.some(isSlateSpawn), 6000);
      expect(outcome).toBe("condition");
    }, 25000);
  });

  describe("tilannerivi", () => {
    it("says 'kuvayhteyttä odotetaan' before the source has ever been captured", async () => {
      const slate = await preparedSlate();
      const spawns: string[][] = [];
      const mixer = harness({ slate, slateAfterMs: 0, resolveTestSource: noSource, spawns });
      await runUntil(mixer, () => spawns.some(isSlateSpawn), 6000);
      expect(readFileSync(slate.statusTextPath, "utf8")).toBe(SLATE_REASON_WAITING);
      expect(readFileSync(slate.scoreTextPath, "utf8")).toBe("");
    }, 25000);

    it("says 'kuvayhteys katkesi' once a source session has existed, and shows the loop's rows", async () => {
      const slate = await preparedSlate();
      const spawns: string[][] = [];
      let attempts = 0;
      const mixer = harness({
        slate,
        slateAfterMs: 0,
        // Ensimmäinen yritys onnistuu (lyhyt sessio), sen jälkeen lähde on poissa.
        resolveTestSource: () => {
          attempts++;
          if (attempts === 1) return "/dev/null";
          throw new Error("lähde katkesi");
        },
        spawns,
        spawnFor: (args) => (isSlateSpawn(args) ? fakeFfmpeg(fifoPath) : fakeFfmpeg(fifoPath, 300)),
      });
      mixer.setSlateSituation({ score: "Testilä Tähdet 3 - 1 Esimerkki Eagles", situation: "1. jakso, 2 paloa" });

      await runUntil(mixer, () => spawns.some(isSlateSpawn), 10000);

      expect(readFileSync(slate.scoreTextPath, "utf8")).toBe("Testilä Tähdet 3 - 1 Esimerkki Eagles");
      expect(readFileSync(slate.statusTextPath, "utf8")).toBe(`1. jakso, 2 paloa — ${SLATE_REASON_LOST}`);
    }, 25000);

    it("keeps 'selostus jatkuu' in every wording — se on kuvan tärkein teksti", () => {
      expect(SLATE_REASON_LOST).toContain("selostus jatkuu");
      expect(SLATE_REASON_WAITING).toContain("selostus jatkuu");
    });
  });
});

describe("escapeFilterPath", () => {
  it("leaves an ordinary path untouched", () => {
    expect(escapeFilterPath("/home/kayttaja/run/slate-1.png")).toBe("/home/kayttaja/run/slate-1.png");
  });

  /** Todennettu kokeellisesti tämän koneen ffmpeg 6.1:llä: kaksoispiste vaatii
   *  KOLME kenoviivaa (yksi ei riitä), kenoviiva itse neljä. */
  it("escapes every character that means something inside a filtergraph", () => {
    expect(escapeFilterPath("/a:b/t.txt")).toBe("/a\\\\\\:b/t.txt");
    expect(escapeFilterPath("/a,b/t.txt")).toBe("/a\\\\\\,b/t.txt");
    expect(escapeFilterPath("/a;b/t.txt")).toBe("/a\\\\\\;b/t.txt");
    expect(escapeFilterPath("/a[b]c/t.txt")).toBe("/a\\\\\\[b\\\\\\]c/t.txt");
    expect(escapeFilterPath("/a'b/t.txt")).toBe("/a\\\\\\'b/t.txt");
    expect(escapeFilterPath("/a\\b/t.txt")).toBe("/a\\\\\\\\b/t.txt");
  });

  it("escapes the backslash before anything else, so escapes are not re-escaped", () => {
    // Lähtöpolussa on jo kenoviiva ja kaksoispiste peräkkäin.
    expect(escapeFilterPath("/a\\:b")).toBe("/a\\\\\\\\\\\\\\:b");
  });

  it("is applied to the fonts and the text files in the drawtext chain", () => {
    const filter = buildSlateVideoFilter(
      { ...LAYOUT, fontBold: "/f:onts/b.ttf" },
      "/run/s:core.txt",
      "/run/status.txt"
    );
    expect(filter).toContain("fontfile=/f\\\\\\:onts/b.ttf");
    expect(filter).toContain("textfile=/run/s\\\\\\:core.txt");
    expect(filter.startsWith("[0:v]")).toBe(true);
    expect(filter.endsWith("[vout]")).toBe(true);
  });
});

describe("buildSlateMixFilterComplex", () => {
  it("uses the same gain and the same limiter as the source mix, so levels do not jump", () => {
    expect(buildSlateMixFilterComplex(1.3)).toBe(
      "[1:a]volume=1.3,alimiter=limit=0.95:level=disabled[aout]"
    );
  });

  it("has no source audio input — there is none in katvetila", () => {
    expect(buildSlateMixFilterComplex(1.3)).not.toContain("[0:a]");
    expect(buildSlateMixFilterComplex(1.3)).not.toContain("amix");
  });
});

describe("buildSlateFfmpegArgs", () => {
  const inputs = {
    imagePath: "/run/slate-1.png",
    scoreTextPath: "/run/slate-score-1.txt",
    statusTextPath: "/run/slate-status-1.txt",
    layout: LAYOUT,
  };
  const opts = {
    youtubeUrl: "",
    rtmpUrl: "rtmp://a.invalid/live",
    streamKey: "k",
    narrationGain: 1.3,
    fifoPath: "/run/relay-1.pcm",
  };

  it("keyframes about every 2 s at the slate's frame rate", () => {
    const args = buildSlateFfmpegArgs(inputs, opts, undefined);
    expect(args[args.indexOf("-g") + 1]).toBe("20");
    expect(args[args.indexOf("-framerate") + 1]).toBe("10");
  });

  it("writes to the record file instead of RTMP when one is given", () => {
    const args = buildSlateFfmpegArgs(inputs, opts, "/run/out.session3.mp4");
    expect(args.slice(-2)).toEqual(["mp4", "/run/out.session3.mp4"]);
    expect(args).not.toContain("flv");
  });

  it("keeps the audio encoding identical to the source path", () => {
    const args = buildSlateFfmpegArgs(inputs, opts, undefined);
    expect(args.join(" ")).toContain("-c:a aac -b:a 160k -ar 48000");
  });
});
