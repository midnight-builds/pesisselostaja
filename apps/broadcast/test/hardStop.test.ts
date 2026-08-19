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

  /** Parikuvio (#121) EI ole testattavissa sijaisprosesseilla, ja sen
   *  yrittäminen teki testistä häilyvän (#273).
   *
   *  Sääntö vertaa kahden peräkkäisen session MITATTUA kestoa toisiinsa
   *  (±20 %). Sijaisprosessilla kesto on seinäkelloa: `sleep 0.3` plus
   *  prosessin käynnistys, FIFO-kädenpuristus ja vuorontajan armo. Mitattuna
   *  (16 taustaprosessia / 4 ydintä) sessioparin hajonta oli 3,4–9,0 %, kun
   *  tyhjällä koneella se on 0,0–0,3 % — eli kuorma syö marginaalia 20 %:n
   *  rajaa vasten, ja riittävän kuormaisella koneella pari jää muodostumatta.
   *  Silloin `unproductive`-laskuri laukeaa ensin ja `/code=0/` jää osumatta.
   *
   *  Kestojen nostaminen olisi piilottanut häilynnän hitaammaksi, ei
   *  poistanut sitä. Sääntö itsessään on puhdasta logiikkaa, joten se
   *  testataan suoraan tarkoilla kestoilla — deterministisesti ja ilman
   *  prosesseja. Sijaisprosessipolku (spawn → sessio → luovutus) on yhä
   *  katettuna yllä olevassa unproductive-testissä; vain oireen VALINTA
   *  todennetaan täällä. */
  describe("code=0-parikuvio (#121), deterministisesti ilman prosesseja", () => {
    interface FakeSession {
      ranMs: number;
      failureSide: null;
      weakTarget: boolean;
      refreshKill: boolean;
      exitCode: number | null;
    }
    interface MixerInternals {
      noteSessionEnd(session: FakeSession): void;
    }

    function shortSession(ranMs: number, exitCode: number | null = 0): FakeSession {
      return { ranMs, failureSide: null, weakTarget: false, refreshKill: false, exitCode };
    }

    /** Mixeri hard stopin ehdoilla 1 ja 2 valmiiksi täytettyinä, jotta vain
     *  oire (ehto 3) ratkaisee. Kestot annetaan suoraan, joten seinäkellolla
     *  ei ole osuutta asiaan.
     *
     *  `minProductiveRunMs` on tässä TUOTANNON oletus (60 s) eikä muiden
     *  testien 10 s: siellä se on lyhennetty vain jotta sijaisprosessit
     *  ehtivät kuolla nopeasti, mutta täällä kestot ovat keksittyjä ja
     *  ilmaisia — ja #121:n oikea kuvio oli 34 s / 34 s, joka 10 s:n rajalla
     *  laskettaisiin tuottavaksi sessioksi eikä oireeksi lainkaan. */
    function mixer(overrides: Partial<HardStopMixerOpts> = {}): MixerInternals {
      return hardStopMixer({
        fifoPath: "/tmp/pesis-test-hard-stop-e.pcm",
        lifetimesMs: [300],
        finished: true,
        lastEventAgeMs: 10 * 60 * 1000,
        hardStopQuietMs: 180_000,
        minProductiveRunMs: 60_000,
        ...overrides,
      }) as unknown as MixerInternals;
    }

    it("laukeaa kahdesta lähes samanmittaisesta lyhyestä code=0-sessiosta", () => {
      const m = mixer();
      // 145900:n 34 s / 34 s -kuvio. Ensimmäinen sessio ei vielä riitä: parin
      // muodostumiseen tarvitaan edellinen kesto vertailukohdaksi.
      expect(() => m.noteSessionEnd(shortSession(34_000))).not.toThrow();
      try {
        m.noteSessionEnd(shortSession(34_000));
        expect.unreachable("toisen session olisi pitänyt laukaista hard stop");
      } catch (err) {
        expect(err).toBeInstanceOf(SourceExhaustedError);
        const e = err as SourceExhaustedError;
        expect(e.reason).toBe("hard_stop");
        expect(e.message).toMatch(/code=0/);
        expect(e.message).toMatch(/34 s ja 34 s/);
      }
    });

    it("hyväksyy tasan 20 %:n eron, muttei sen ylittävää", () => {
      // 20 % isommasta kestosta: |400−500| = 100 = 0,2 × 500 → pari muodostuu.
      // Oire tarkistetaan nimeltä eikä pelkkänä heittona: unproductive-laskuri
      // on tässä vaiheessa myös 2, joten "heittää jotain" menisi läpi vaikka
      // parisääntö olisi kokonaan rikki.
      const atLimit = mixer();
      atLimit.noteSessionEnd(shortSession(400));
      try {
        atLimit.noteSessionEnd(shortSession(500));
        expect.unreachable("tasan rajalla olevan parin olisi pitänyt laueta");
      } catch (err) {
        expect(err).toBeInstanceOf(SourceExhaustedError);
        expect((err as SourceExhaustedError).message).toMatch(/code=0/);
      }

      // Yksi millisekunti yli rajan → ei paria. Hard stop ei kuitenkaan jää
      // tulematta, vaan tulee unproductive-oireesta (laskuri on jo 2) — juuri
      // tämä sekaannus teki vanhasta testistä häilyvän, joten oire tarkistetaan
      // nimeltä.
      const overLimit = mixer();
      overLimit.noteSessionEnd(shortSession(399));
      try {
        overLimit.noteSessionEnd(shortSession(500));
        expect.unreachable("hard stopin olisi pitänyt laueta unproductive-oireesta");
      } catch (err) {
        expect((err as SourceExhaustedError).message).toMatch(/unproductive/);
        expect((err as SourceExhaustedError).message).not.toMatch(/code=0/);
      }
    });

    it("nollaa parin kun sessio päättyy muuhun kuin code=0:aan", () => {
      const m = mixer();
      m.noteSessionEnd(shortSession(300));
      // Virhekoodi katkaisee kuvion: kyse ei ole enää samasta puhtaasti
      // luetusta hännästä. Laukeaa silti unproductive-oireesta, ei parista.
      try {
        m.noteSessionEnd(shortSession(300, 1));
        expect.unreachable("unproductive-laskurin olisi pitänyt laueta");
      } catch (err) {
        expect((err as SourceExhaustedError).message).not.toMatch(/code=0-sessiota/);
      }
    });

    it("ei laukea parista kesken ottelun, vaikka kestot olisivat identtiset", () => {
      const m = mixer({ finished: false });
      m.noteSessionEnd(shortSession(300));
      expect(() => m.noteSessionEnd(shortSession(300))).not.toThrow();
    });
  });

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

  it("hardStopQuietMs=0 tarkoittaa POIS PÄÄLTÄ, ei 'laukea heti'", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mixer = hardStopMixer({
      fifoPath: "/tmp/pesis-test-hard-stop-g.pcm",
      lifetimesMs: [300], // parikuvio + unproductive-oireet päällä
      finished: true,
      lastEventAgeMs: 10 * 60 * 1000,
      hardStopQuietMs: 0,
      finishedFailureWindowMs: 100,
    });
    const outcome = await outcomeOf(mixer, 15_000);
    expect(outcome.kind).toBe("gave-up");
    if (outcome.kind === "gave-up") {
      // Luovutus tuli tavallisesta finished-ikkunasta, ei hard stopista.
      expect(outcome.err.reason).toBe("exhausted");
    }
  }, 20_000);
});
