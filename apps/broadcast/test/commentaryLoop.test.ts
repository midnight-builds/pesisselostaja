import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rmSync, writeFileSync } from "node:fs";

// Only the two network calls are replaced; everything else in core stays real,
// so the tests that use buildPlayerLookup/format* below are untouched. Needed
// by the #52 cadence tests at the bottom, which drive the real poll loop.
vi.mock("@pesisselostaja/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pesisselostaja/core")>();
  return { ...actual, fetchMatchMetadata: vi.fn(), fetchLiveEvents: vi.fn() };
});

import { CommentaryLoop, type NarrationStatus, type SpeechSink } from "../src/commentaryLoop.js";
import type { RelayConfig } from "../src/config.js";
import { buildPlayerLookup, fetchLiveEvents, fetchMatchMetadata } from "@pesisselostaja/core";
import type { LiveEvent, MatchMetadata, PlayerLookup, SubEvent } from "@pesisselostaja/core";
import { setLogSink } from "../src/log.js";

// Fictional teams only — public repo (see feedback-fixtures-fictional-names).
const META: MatchMetadata = {
  id: 900001,
  date: "2026-07-16",
  home: { id: 1, name: "Testilä Tähdet", shorthand: "TTä", players: [], all_players: [] },
  away: { id: 2, name: "Esimerkki Eagles", shorthand: "EEa", players: [], all_players: [] },
  series: { name: "Testisarja" },
  stadium: { name: "Testikenttä" },
  live: true,
  started: false,
};

function makeConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    matchId: 900001,
    youtubeUrl: "https://example.invalid/live",
    rtmpUrl: "",
    streamKey: "",
    voice: "harri-medium",
    piperBin: "piper",
    pollInterval: 4000,
    narrationGain: 1.3,
    narrationDelayMs: 0,
    firstSpeechDelayMs: 0, // most tests exercise gating/latching without the start-up grace
    urlRefreshMs: 900000,
    ytdlpExtractorArgs: "",
    noSignalSlate: false,
    noSignalSlateAfterMs: 8000,
    noSignalSlateWidth: 1920,
    noSignalSlateHeight: 1080,
    maxFailureWindowMs: 720000,
    finishedFailureWindowMs: 120000,
    hardStopQuietMs: 180000,
    deltaFetch: true,
    pollTrace: false,
    announceBatterChanges: true,
    dryRun: false,
    apiKey: "test",
    apiBase: "https://example.invalid/api",
    // Nonexistent paths → loaders fall back to defaults (see loadState /
    // loadPronunciations), so no fixtures on disk are needed.
    stateFile: "/tmp/pesis-test-nonexistent-state.json",
    runDir: "/tmp/",
    runRetentionDays: 0,
    ttsCacheMaxBytes: 0,
    pronunciationsFile: "/tmp/pesis-test-nonexistent-pron.json",
    controlFile: "/tmp/pesis-test-nonexistent-control.json",
    elevenLabsVoiceId: "x",
    elevenLabsModelId: "y",
    ...overrides,
  };
}

/** Records each sink call with the wall-clock instant it fired, so tests can
 *  assert both order and timing of narration handoff. */
function recordingSink(): SpeechSink & { calls: { text: string; at: number }[] } {
  const calls: { text: string; at: number }[] = [];
  const sink = (async (_spoken: string, readable: string) => {
    calls.push({ text: readable, at: Date.now() });
  }) as SpeechSink & { calls: typeof calls };
  sink.calls = calls;
  return sink;
}

/** Mutable stand-in for FfmpegMixer's attach/queue state, so a test can flip
 *  attachment mid-test the way a real ffmpeg connect/exit would. firstAt
 *  defaults to 0 (= "first attach long ago"), so tests not about the
 *  first-speech grace never trip it. */
function mutableStatus(attached = false, pending = 0, firstAt: number | null = 0) {
  const s = { attached, pending, firstAt };
  const port: NarrationStatus = {
    isReaderAttached: () => s.attached,
    pendingClips: () => s.pending,
    firstAttachedAt: () => s.firstAt,
  };
  return { s, port };
}

/** The behaviors under test (filler gating, first-attach latch, delayed
 *  handoff) live on private members; this typed view exposes just what the
 *  tests touch, so no `any` casts are needed. */
interface LoopInternals {
  narrationReadyForFiller(): boolean;
  maybeLatchNarrationReady(meta: MatchMetadata): void;
  maybeAnnounceSummary(meta: MatchMetadata): Promise<void>;
  speak(text: string, countAnnouncement?: boolean, dedupeKey?: string): void;
  synthQueue: Promise<void>;
  state: {
    announcementCount: number;
    finished: boolean;
    // Hiljaisuusfillerin sisältö luetaan näistä (buildContext) — ks. #60.
    currentPeriod: number;
    currentOuts: number;
    currentBatTeamId: number | null;
    periodRuns: Record<number, { home: number; away: number }>;
    lastSummaryTime: number;
  };
  matchStarted: boolean;
  lastSpeech: string | null;
  lastSpeechAt: number;
  lastSummaryCount: number;
  lastIntroPeriod: number | null;
  narrationEverReady: boolean;
}

function internals(loop: CommentaryLoop): LoopInternals {
  return loop as unknown as LoopInternals;
}

/** A loop whose first-attach latch has already fired, mirroring the poll
 *  loop's per-cycle maybeLatchNarrationReady call — the state most gating
 *  tests want as their baseline. */
function latchedLoop(sink: SpeechSink, s: { attached: boolean; pending: number }, port: NarrationStatus, config = makeConfig()) {
  const wasAttached = s.attached;
  s.attached = true;
  const loop = internals(new CommentaryLoop(config, sink, port));
  loop.maybeLatchNarrationReady(META);
  s.attached = wasAttached;
  return loop;
}

describe("CommentaryLoop pre-game filler gating", () => {
  it("is not ready while ffmpeg is unattached, unlatched, or while clips are still queued", () => {
    const a = mutableStatus(false, 0);
    expect(internals(new CommentaryLoop(makeConfig(), recordingSink(), a.port)).narrationReadyForFiller()).toBe(false);

    const b = mutableStatus(true, 2);
    const busy = internals(new CommentaryLoop(makeConfig(), recordingSink(), b.port));
    busy.maybeLatchNarrationReady(META);
    expect(busy.narrationReadyForFiller()).toBe(false);

    const c = mutableStatus(true, 0);
    const fresh = internals(new CommentaryLoop(makeConfig(), recordingSink(), c.port));
    // Before the latch even an attached, idle pipeline is not "ready" — a
    // filler would only be suppressed while burning its bookkeeping.
    expect(fresh.narrationReadyForFiller()).toBe(false);
    fresh.maybeLatchNarrationReady(META);
    expect(fresh.narrationReadyForFiller()).toBe(true);
  });

  it("treats narration as always ready when no status port is supplied (dry-run/tests)", () => {
    const loop = internals(new CommentaryLoop(makeConfig(), recordingSink()));
    expect(loop.narrationReadyForFiller()).toBe(true);
    expect(loop.narrationEverReady).toBe(true);
  });

  it("skips synthesizing the pre-game welcome filler until ffmpeg is attached and the queue empty", async () => {
    const sink = recordingSink();
    const { port } = mutableStatus(false, 0);
    const loop = internals(new CommentaryLoop(makeConfig(), sink, port));

    // Pre-game (matchStarted defaults false), silence long enough that only the
    // readiness gate can block the filler.
    await loop.maybeAnnounceSummary(META);
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(0);
  });

  it("synthesizes the pre-game welcome filler once ffmpeg is attached and the queue empty", async () => {
    const sink = recordingSink();
    const { s, port } = mutableStatus(true, 0);
    const loop = latchedLoop(sink, s, port);

    await loop.maybeAnnounceSummary(META);
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(1);
  });
});

describe("CommentaryLoop in-game filler gating", () => {
  function inGameLoop(sink: SpeechSink, s: { attached: boolean; pending: number }, port: NarrationStatus) {
    const loop = latchedLoop(sink, s, port);
    loop.matchStarted = true;
    loop.state.announcementCount = 1; // countDue stays false; idleDue drives the filler
    // The self-introduction (#247) is already given for this period, so these
    // tests keep measuring what they claim to measure: the recap/idle gating.
    loop.lastIntroPeriod = loop.state.currentPeriod;
    // lastSpeechAt stays 0 → far past IDLE_FILLER_MS, so idleDue is true.
    return loop;
  }

  it("skips the recap/idle filler while ffmpeg is detached, WITHOUT advancing the summary bookkeeping", async () => {
    const sink = recordingSink();
    const { s, port } = mutableStatus(false, 0);
    const loop = inGameLoop(sink, s, port);

    await loop.maybeAnnounceSummary(META);
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(0);
    // Bookkeeping untouched → the first ready poll still sees the filler as due.
    expect(loop.lastSummaryCount).toBe(0);
    expect(loop.lastSpeechAt).toBe(0);
  });

  it("skips the filler while queued clips are still draining (attached but busy)", async () => {
    const sink = recordingSink();
    const { s, port } = mutableStatus(true, 3);
    const loop = inGameLoop(sink, s, port);

    await loop.maybeAnnounceSummary(META);
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(0);
    expect(loop.lastSpeechAt).toBe(0);
  });

  it("speaks a fresh filler on the first ready poll after a skipped round", async () => {
    const sink = recordingSink();
    const { s, port } = mutableStatus(false, 0);
    const loop = inGameLoop(sink, s, port);

    await loop.maybeAnnounceSummary(META); // skipped: detached
    s.attached = true;
    await loop.maybeAnnounceSummary(META); // gate open → speaks now
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(1);
    expect(loop.lastSpeechAt).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------ issue #247
// Selostajan esittely: ottelun alussa ja jaksojen välissä, vain kun jono on
// tyhjä. Nämä testit ajavat sen putken läpi (decideFiller + kutsupaikan
// kirjanpito), koska juuri kirjanpidon kuittaus väärään aikaan on se virhe,
// joka joko toistaisi esittelyn tai hukkaisi sen kokonaan.
describe("CommentaryLoop selostajan esittely (#247)", () => {
  const INTRO = /puheeni on tuotettu keinotekoisesti|Luen ääneen pesistulokset\.fi/;

  /** Käynnissä oleva ottelu, ffmpeg kiinni ja jono tyhjä: mikään muu portti ei
   *  ole esittelyn tiellä. lastSpeechAt = 0 ⇒ myös hiljaisuustäyte erääntyy,
   *  joten testit näyttävät samalla kumpi voittaa. */
  function startedMatch(sink: SpeechSink, pending = 0) {
    const { s, port } = mutableStatus(true, pending);
    const loop = latchedLoop(sink, s, port);
    loop.matchStarted = true;
    loop.state.announcementCount = 1;
    loop.state.currentPeriod = 0;
    return { loop, s };
  }

  it("esittelee itsensä ottelun alussa", async () => {
    const sink = recordingSink();
    const { loop } = startedMatch(sink);

    await loop.maybeAnnounceSummary(META);
    await loop.synthQueue;

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0].text).toMatch(INTRO);
  });

  it("ei toista esittelyä samassa jaksossa — seuraava kierros on tavallista täytettä", async () => {
    const sink = recordingSink();
    const { loop } = startedMatch(sink);

    await loop.maybeAnnounceSummary(META);
    loop.lastSpeechAt = 0; // hiljaisuustäyte erääntyy taas
    await loop.maybeAnnounceSummary(META);
    await loop.synthQueue;

    expect(sink.calls).toHaveLength(2);
    expect(sink.calls[1].text).not.toMatch(INTRO);
  });

  it("esittelee itsensä uudelleen jaksojen välissä", async () => {
    const sink = recordingSink();
    const { loop } = startedMatch(sink);

    await loop.maybeAnnounceSummary(META); // 1. jakso
    loop.state.currentPeriod = 1;
    loop.lastSpeechAt = 0;
    await loop.maybeAnnounceSummary(META); // 2. jakso alkoi
    await loop.synthQueue;

    expect(sink.calls).toHaveLength(2);
    expect(sink.calls[1].text).toMatch(INTRO);
  });

  it("ei puhu kesken tapahtumaryöpyn, eikä kuittaa esittelyä annetuksi", async () => {
    const sink = recordingSink();
    const { loop, s } = startedMatch(sink, 3); // klippejä yhä jonossa

    await loop.maybeAnnounceSummary(META);
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(0);
    expect(loop.lastIntroPeriod).toBeNull();

    // Ryöppy ohi → esittely on yhä velkaa ja tulee nyt.
    s.pending = 0;
    await loop.maybeAnnounceSummary(META);
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0].text).toMatch(INTRO);
    expect(loop.lastIntroPeriod).toBe(0);
  });

  // Kutsupaikan johdotus: `formatIntroFiller(firstOfMatch)` saa oikean lipun
  // vain kun `lastIntroPeriod` luetaan ENNEN kuittausta. Jos lippu jäisi aina
  // falseksi, arpa voisi antaa lähetyksen ensimmäiseksi lauseeksi
  // "Muistutan että…" — muistutus asiasta, jota ei ole vielä kerrottu.
  it("ottelun ensimmäinen esittely ei viittaa aiempaan kertaan", async () => {
    const realRandom = Math.random;
    try {
      const draws = 20;
      for (let i = 0; i < draws; i++) {
        Math.random = () => i / draws;
        const sink = recordingSink();
        const { loop } = startedMatch(sink);

        await loop.maybeAnnounceSummary(META);
        await loop.synthQueue;

        expect(sink.calls).toHaveLength(1);
        expect(sink.calls[0].text).toMatch(INTRO);
        expect(sink.calls[0].text).not.toMatch(/^Muistutan/);
      }
    } finally {
      Math.random = realRandom;
    }
  });

  it("ei esittele itseään ennen ottelun alkua", async () => {
    const sink = recordingSink();
    const { loop } = startedMatch(sink);
    loop.matchStarted = false;

    await loop.maybeAnnounceSummary(META);
    await loop.synthQueue;

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0].text).not.toMatch(INTRO);
  });
});

// ------------------------------------------------------------------- issue #60
// 90 sekunnin hiljaisuusfilleri ei ollut lauennut kertaakaan kolmessa
// live-ajossa, eikä yksikään testi koetellut sen rajaa tai sisältöä: yllä
// olevat gating-testit asettavat lastSpeechAt = 0, jolloin "hiljaisuutta" on
// aina takana ikuisuus ja itse 90 s ehto jää kokonaan koettelematta. Nämä
// testit ajavat kellon valeajastimella rajan yli ja lukevat mitä filleri puhuu.
describe("CommentaryLoop 90 s hiljaisuusfilleri (#60)", () => {
  const T0 = 1_000_000; // mikä tahansa "nyt": filleri mittaa eroa, ei absoluuttia
  const IDLE_MS = 90_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  /** Käynnissä oleva, tapahtumaton ottelu: ffmpeg kiinni ja jono tyhjä, joten
   *  ainoa fillerin ja mikserin välissä oleva portti on kello. Tilanne
   *  (4–1 kotijoukkueelle, vieras sisävuorossa) on sisältötestiä varten. */
  function quietGame(sink: SpeechSink) {
    const { s, port } = mutableStatus(true, 0);
    const loop = latchedLoop(sink, s, port);
    loop.matchStarted = true;
    // > 0 (muuten filleri ei koskaan laukea), mutta alle SUMMARY_EVERY_N:n:
    // countDue pysyy epätotena, joten laukaisu voi tulla vain idleDue-ehdosta.
    loop.state.announcementCount = 3;
    loop.state.currentPeriod = 0;
    loop.state.currentOuts = 2;
    loop.state.currentBatTeamId = META.away.id;
    loop.state.periodRuns[0] = { home: 4, away: 1 };
    // Esittely (#247) on jo annettu tälle jaksolle — muuten se olisi ainoa
    // asia, jota nämä testit mittaisivat.
    loop.lastIntroPeriod = loop.state.currentPeriod;
    loop.lastSpeechAt = T0; // hiljaisuus alkaa nyt, ei "joskus ennen aikojen alkua"
    return { loop, s };
  }

  it("pysyy hiljaa kun hiljaisuutta on kertynyt alle 90 sekuntia", async () => {
    const sink = recordingSink();
    const { loop } = quietGame(sink);

    vi.setSystemTime(T0 + 89_000);
    await loop.maybeAnnounceSummary(META);
    await loop.synthQueue;

    expect(sink.calls).toHaveLength(0);
    // Kirjanpito ei kulunut: seuraava kysely näkee saman hiljaisuuden jatkuvan.
    expect(loop.lastSpeechAt).toBe(T0);
    expect(loop.state.lastSummaryTime).toBe(0);
  });

  it("laukeaa vasta kun 90 sekuntia on täyttynyt, ja nollaa kellon itselleen", async () => {
    const sink = recordingSink();
    const { loop } = quietGame(sink);

    // Tasan rajalla ei vielä puhuta: ehto on ehdoton > eikä >=.
    vi.setSystemTime(T0 + IDLE_MS);
    await loop.maybeAnnounceSummary(META);
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(0);

    vi.setSystemTime(T0 + IDLE_MS + 1);
    await loop.maybeAnnounceSummary(META);
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(1);

    // Kello lähtee fillerin hetkestä, joten seuraava filleri on 90 s päässä.
    expect(loop.lastSpeechAt).toBe(T0 + IDLE_MS + 1);
    vi.setSystemTime(T0 + IDLE_MS + 1 + IDLE_MS);
    await loop.maybeAnnounceSummary(META);
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(1);
  });

  it("puhuu hiljaisuusfillerin sisällön: käynnissä olevan jakson tilanne, johtaja ja sisävuoro", async () => {
    const sink = recordingSink();
    const { loop } = quietGame(sink);

    vi.setSystemTime(T0 + IDLE_MS + 1);
    await loop.maybeAnnounceSummary(META);
    await loop.synthQueue;

    expect(sink.calls).toHaveLength(1);
    const text = sink.calls[0].text;
    // formatIdleSummary arpoo sanamuodon (pickVariant), joten testi hyväksyy
    // varianttijoukon mutta vaatii jokaiselta variantilta saman sisällön.
    expect(text).toMatch(
      /^(Tilanne on edelleen|Tilanne edelleen|Ottelu jatkuu|Tulospalvelun mukaan tilanne|Tilasto kertoo)/
    );
    expect(text).toContain("4, 1"); // kuluvan jakson lukema, koti ensin
    expect(text).toContain(META.home.shorthand); // johtava joukkue nimetään
    expect(text).toContain("reilusti"); // 3 juoksun ero → ei "niukasti"
    // Sisävuorossa oleva joukkue on se, mitä kuulija hiljaisuuden jälkeen
    // eniten kaipaa (#100) — se ei saa pudota fillerista pois.
    expect(text).toContain(`sisävuorossa on ${META.away.shorthand}`);
    // Hiljaisuusfilleri, ei laskuripohjainen tilannekooste ("Menossa 1. jakso…").
    expect(text).not.toMatch(/menossa/i);
    // Filleriä ei lasketa selostukseksi, joten se ei siirrä koosteen laskuria.
    expect(loop.state.announcementCount).toBe(3);
  });

  it("ei laukea kun ottelu on jo päättynyt, vaikka hiljaisuutta olisi tunteja", async () => {
    const sink = recordingSink();
    const { loop } = quietGame(sink);
    loop.state.finished = true;

    vi.setSystemTime(T0 + 60 * 60 * 1000);
    await loop.maybeAnnounceSummary(META);
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(0);
  });

  it("laskee hiljaisuuden viimeisestä puheesta, ei fillerin edellisestä vuorosta", async () => {
    const sink = recordingSink();
    const { loop } = quietGame(sink);

    // Tapahtuma 80 s kohdalla: hiljaisuus alkaa alusta siitä hetkestä.
    vi.setSystemTime(T0 + 80_000);
    loop.speak("Palo! Toinen palo.");
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(1);

    // T0:sta on jo yli 90 s, mutta puheesta vasta 11 s → ei filleriä.
    vi.setSystemTime(T0 + 91_000);
    await loop.maybeAnnounceSummary(META);
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(1);

    // 90 s tapahtumasta täyteen → filleri.
    vi.setSystemTime(T0 + 80_000 + IDLE_MS + 1);
    await loop.maybeAnnounceSummary(META);
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(2);
  });
});

describe("CommentaryLoop pre-first-attach suppression + connect recap", () => {
  it("suppresses event narration before the first attach while bookkeeping still advances", async () => {
    const sink = recordingSink();
    const { port } = mutableStatus(false, 0);
    const loop = internals(new CommentaryLoop(makeConfig(), sink, port));

    loop.speak("Juoksun löi Aino Aaltonen.");
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(0); // nothing synthesized or queued
    expect(loop.state.announcementCount).toBe(1); // ...but counted
    expect(loop.lastSpeech).toBe("Juoksun löi Aino Aaltonen.");

    // Dedupe still operates on suppressed speech: the double-marking is dropped.
    loop.speak("Juoksun löi Aino Aaltonen.");
    expect(loop.state.announcementCount).toBe(1);
  });

  it("speaks exactly one fresh situation recap at the first attach when mid-game speech was suppressed", async () => {
    const sink = recordingSink();
    const { s, port } = mutableStatus(false, 0);
    const loop = internals(new CommentaryLoop(makeConfig(), sink, port));
    loop.matchStarted = true;

    loop.speak("Juoksun löi Aino Aaltonen.");
    loop.speak("Palo! Ensimmäinen palo.");
    s.attached = true;
    loop.maybeLatchNarrationReady(META);
    loop.maybeLatchNarrationReady(META); // idempotent: latch is one-way
    await loop.synthQueue;

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0].text).toMatch(/menossa/i); // formatSituationSummary variants
  });

  it("speaks the closing line instead of a mid-game recap if the match finished during suppression", async () => {
    const sink = recordingSink();
    const { s, port } = mutableStatus(false, 0);
    const loop = internals(new CommentaryLoop(makeConfig(), sink, port));
    loop.matchStarted = true;

    loop.speak("Ottelu päättyi!");
    loop.state.finished = true;
    s.attached = true;
    loop.maybeLatchNarrationReady(META);
    await loop.synthQueue;

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0].text).toMatch(/^Ottelu päättyi!/);
  });

  it("speaks no extra recap at the first attach when nothing was suppressed", async () => {
    const sink = recordingSink();
    const { port } = mutableStatus(true, 0);
    const loop = internals(new CommentaryLoop(makeConfig(), sink, port));
    loop.matchStarted = true;

    loop.maybeLatchNarrationReady(META);
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(0);
  });

  it("keeps queueing event narration through post-latch ffmpeg drops (flap case unchanged)", async () => {
    const sink = recordingSink();
    const { s, port } = mutableStatus(true, 0);
    const loop = latchedLoop(sink, s, port);
    loop.matchStarted = true;

    s.attached = false; // mid-game flap: ffmpeg exited after the first attach
    loop.speak("Palo! Toinen palo.");
    await loop.synthQueue;
    expect(sink.calls.map((c) => c.text)).toEqual(["Palo! Toinen palo."]);
  });

  it("without a status port everything reaches the sink immediately (old behavior)", async () => {
    const sink = recordingSink();
    const loop = internals(new CommentaryLoop(makeConfig(), sink));

    loop.speak("Palo! Ensimmäinen palo.");
    await loop.synthQueue;
    expect(sink.calls.map((c) => c.text)).toEqual(["Palo! Ensimmäinen palo."]);
  });
});

describe("CommentaryLoop first-speech grace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it("holds the latch until ffmpeg has been attached for the configured grace", () => {
    const { s, port } = mutableStatus(true, 0, 0); // first attach at t=0
    const loop = internals(new CommentaryLoop(makeConfig({ firstSpeechDelayMs: 20000 }), recordingSink(), port));
    expect(s.attached).toBe(true);

    loop.maybeLatchNarrationReady(META);
    expect(loop.narrationEverReady).toBe(false); // attached, but grace still running

    vi.setSystemTime(19999);
    loop.maybeLatchNarrationReady(META);
    expect(loop.narrationEverReady).toBe(false);

    vi.setSystemTime(20000);
    loop.maybeLatchNarrationReady(META);
    expect(loop.narrationEverReady).toBe(true);
  });

  it("measures the grace from the FIRST attach ever, so a respawn after the grace latches immediately", () => {
    const { s, port } = mutableStatus(false, 0, 0); // first attach happened at t=0, then ffmpeg died
    const loop = internals(new CommentaryLoop(makeConfig({ firstSpeechDelayMs: 20000 }), recordingSink(), port));

    vi.setSystemTime(25000);
    loop.maybeLatchNarrationReady(META);
    expect(loop.narrationEverReady).toBe(false); // detached: no latch regardless of elapsed time

    s.attached = true; // respawn re-attaches at t=25s — grace (from t=0) already elapsed
    loop.maybeLatchNarrationReady(META);
    expect(loop.narrationEverReady).toBe(true);
  });

  it("keeps the pre-game welcome filler quiet through the grace without burning its cadence", async () => {
    const sink = recordingSink();
    const { port } = mutableStatus(true, 0, 0);
    const loop = internals(new CommentaryLoop(makeConfig({ firstSpeechDelayMs: 20000 }), sink, port));

    vi.setSystemTime(10000); // attached, grace running, silence > WELCOME cadence? (lastSpeechAt=0)
    await loop.maybeAnnounceSummary(META);
    await loop.synthQueue;
    expect(sink.calls).toHaveLength(0);
    expect(loop.lastSpeechAt).toBe(0); // cadence untouched — fires fresh once ready
  });

  it("applies no grace when firstSpeechDelayMs is 0 (default off in tests)", () => {
    const { port } = mutableStatus(true, 0, null); // attached but mixer never reported a first-attach time
    const loop = internals(new CommentaryLoop(makeConfig({ firstSpeechDelayMs: 0 }), recordingSink(), port));
    loop.maybeLatchNarrationReady(META);
    expect(loop.narrationEverReady).toBe(true);
  });
});

describe("CommentaryLoop narration delay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0); // pin the fake clock so `at` timings are relative to 0
  });
  afterEach(() => vi.useRealTimers());

  it("delays the sink handoff by the configured amount without blocking the caller", async () => {
    const sink = recordingSink();
    const loop = internals(new CommentaryLoop(makeConfig({ narrationDelayMs: 4000 }), sink));

    loop.speak("Juoksu!");
    // Let the queued microtask arm the timer.
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(3999);
    expect(sink.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0].at).toBe(4000);
  });

  it("does the dedupe/state bookkeeping synchronously, before any delay elapses", () => {
    const sink = recordingSink();
    const loop = internals(new CommentaryLoop(makeConfig({ narrationDelayMs: 5000 }), sink));

    expect(loop.state.announcementCount).toBe(0);
    loop.speak("Juoksu!"); // counts as an announcement
    // No timers advanced yet: sink hasn't fired, but bookkeeping already has.
    expect(sink.calls).toHaveLength(0);
    expect(loop.state.announcementCount).toBe(1);
    expect(loop.lastSpeech).toBe("Juoksu!");
  });

  it("measures the delay from each clip's decision time (a floor, not a per-clip cumulative wait) and preserves order", async () => {
    const sink = recordingSink();
    const loop = internals(new CommentaryLoop(makeConfig({ narrationDelayMs: 1000 }), sink));

    // Two clips decided in the same instant.
    loop.speak("Ensimmäinen");
    loop.speak("Toinen");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);

    // Both land at t=1000 in decision order — the second is NOT pushed to 2000,
    // which is what a cumulative per-clip delay would do.
    expect(sink.calls.map((c) => c.text)).toEqual(["Ensimmäinen", "Toinen"]);
    expect(sink.calls.map((c) => c.at)).toEqual([1000, 1000]);
  });

  it("applies no wait when the delay is 0 (default behavior unchanged)", async () => {
    const sink = recordingSink();
    const loop = internals(new CommentaryLoop(makeConfig({ narrationDelayMs: 0 }), sink));

    loop.speak("Heti");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0].at).toBe(0);
  });
});

/** Katvekuvan tekstirivit ja ohjaamon havainnon välitys (issue #104 vaihe 2).
 *  Loop on ainoa joka tietää pisteet ja pelitilanteen, ja ainoa joka lukee
 *  control-tiedostoa — mikseri saa molemmat valmiina eikä joudu tuntemaan
 *  pesäpallon sääntöjä. */
interface SlateInternals {
  meta: MatchMetadata | null;
  matchStarted: boolean;
  state: { currentPeriod: number; currentOuts: number; periodRuns: Record<string, unknown> };
  sourceIngestValue: unknown;
  refreshRuntimeControls(): Promise<void>;
}

function slateInternals(loop: CommentaryLoop): SlateInternals {
  return loop as unknown as SlateInternals;
}

describe("CommentaryLoop slate rows (issue #104)", () => {
  function loopWithSituation(period: number, outs: number, runs?: { home: number; away: number }) {
    const loop = new CommentaryLoop(makeConfig(), recordingSink());
    const inner = slateInternals(loop);
    inner.meta = META;
    inner.matchStarted = true;
    inner.state.currentPeriod = period;
    inner.state.currentOuts = outs;
    if (runs) inner.state.periodRuns[period] = { ...runs };
    return loop;
  }

  it("is empty before the match has produced any event — plain EI SIGNAALIA is a valid result", () => {
    const loop = new CommentaryLoop(makeConfig(), recordingSink());
    expect(loop.slateSituation).toEqual({ score: "", situation: "" });
  });

  it("stays empty while metadata has not been fetched yet", () => {
    const loop = new CommentaryLoop(makeConfig(), recordingSink());
    slateInternals(loop).matchStarted = true;
    expect(loop.slateSituation).toEqual({ score: "", situation: "" });
  });

  it("formats a display-style score row and situation row", () => {
    const s = loopWithSituation(0, 2).slateSituation;
    expect(s.score).toBe("Testilä Tähdet 0 – Esimerkki Eagles 0");
    // Näyttömuoto, ei puhemuoto: kuvassa "1. jakso", ei "ensimmäinen jakso".
    expect(s.situation).toBe("1. jakso, 2 paloa");
  });

  it("keeps each score NEXT TO its own team — 'koti 12 - 1 vieras' luetaan väärin", () => {
    // Epäsymmetrinen lukema on ainoa joka erottaa parimuodon siitä muodosta
    // jossa vieraan luku on nimien välissä: siinä "1 Esimerkki Eagles" luettiin
    // joukkueen nimeksi. Tämä testi on olemassa juuri sen takia.
    const s = loopWithSituation(0, 2, { home: 12, away: 1 }).slateSituation;
    expect(s.score).toBe("Testilä Tähdet 12 – Esimerkki Eagles 1");
  });

  it("shows the CURRENT PERIOD's runs, not the match total", () => {
    // Pesäpallossa jaksot pisteytetään erikseen; tilannerivi kertoo minkä
    // jakson lukema kuvassa on (CLAUDE.md, "Scoring").
    const loop = loopWithSituation(1, 0, { home: 4, away: 2 });
    slateInternals(loop).state.periodRuns[0] = { home: 9, away: 9 };
    expect(loop.slateSituation.score).toBe("Testilä Tähdet 4 – Esimerkki Eagles 2");
    expect(loop.slateSituation.situation).toContain("2. jakso");
  });

  it("inflects a single palo correctly", () => {
    expect(loopWithSituation(1, 1).slateSituation.situation).toBe("2. jakso, 1 palo");
    expect(loopWithSituation(1, 0).slateSituation.situation).toBe("2. jakso, 0 paloa");
  });

  it("names supervuoro and kotiutuslyöntikilpailu, not 'jakso 3'", () => {
    expect(loopWithSituation(2, 0).slateSituation.situation).toContain("supervuoro");
    expect(loopWithSituation(3, 0).slateSituation.situation).toContain("kotiutuslyöntikilpailu");
  });
});

describe("CommentaryLoop sourceIngest passthrough (#104 vaihe 1 -> 2)", () => {
  const controlFile = "/tmp/pesis-test-control-slate.json";

  function loopReadingControl(contents: unknown) {
    writeFileSync(controlFile, JSON.stringify(contents));
    return new CommentaryLoop(makeConfig({ controlFile }), recordingSink());
  }

  afterEach(() => {
    rmSync(controlFile, { force: true });
  });

  it("is null until the control app publishes an observation", async () => {
    const loop = loopReadingControl({ announceBatterChanges: true });
    await slateInternals(loop).refreshRuntimeControls();
    expect(loop.sourceIngest).toBeNull();
  });

  it("passes a complete observation through verbatim — the mixer decides, not the loop", async () => {
    const observedAt = new Date().toISOString();
    const loop = loopReadingControl({
      sourceIngest: {
        observedAt,
        videoId: "abc123",
        lifeCycleStatus: "live",
        streamStatus: "inactive",
        healthStatus: "noData",
        error: null,
      },
    });
    await slateInternals(loop).refreshRuntimeControls();
    expect(loop.sourceIngest).toEqual({
      observedAt,
      videoId: "abc123",
      lifeCycleStatus: "live",
      streamStatus: "inactive",
      healthStatus: "noData",
      error: null,
    });
  });

  /** Rikkinäinen havainto on "ei tietoa", ei "lähde poikki" — lähetyksen
   *  käytös ei saa riippua ohjaamon Google-yhteydestä. */
  it("treats a malformed observation as no information at all", async () => {
    for (const bad of [null, 42, "live", { videoId: "x" }, { observedAt: "eilen", videoId: "x" }]) {
      const loop = loopReadingControl({ sourceIngest: bad });
      await slateInternals(loop).refreshRuntimeControls();
      expect(loop.sourceIngest).toBeNull();
    }
  });
});

// ------------------------------------------------------------------ issue #119
// lastEventAt on terveyssignaali ("kirjaako toimitsija yhä tuloksia"). Se oli
// vahingossa saman vartijan sisällä kuin timestamp-riippuvainen viivemittaus,
// ja koska tämän syötteen event.timestamp on käytännössä aina null, kenttä jäi
// ikuisesti nulliksi ja ohjaamon "aika viime tapahtumasta" tyhjäksi.
describe("CommentaryLoop lastEventAt (#119)", () => {
  interface ProcessInternals {
    processEventsLive(
      events: LiveEvent[],
      meta: MatchMetadata,
      lookup: PlayerLookup
    ): Promise<void>;
    synthQueue: Promise<void>;
  }

  const paloSub: SubEvent = {
    texts: [
      { type: "event", text: "Palo", base: null },
      { type: "stat", out: 1 },
    ],
  };

  // Fiktiivinen data (julkinen repo): timestamp null, kuten oikeassa syötteessä.
  function nullTimestampEvent(): LiveEvent {
    return {
      id: 1, groupType: "x", period: 0, inning: 0, batTurn: 0, team: 1, hTeam: 1,
      batter: null, pairIndex: null, hitNumber: null, hit: null,
      events: [paloSub], timestamp: null, updated: null,
    };
  }

  it("stamps our observation instant for a new event whose timestamp is null", async () => {
    const loop = new CommentaryLoop(makeConfig(), recordingSink());
    const inner = loop as unknown as ProcessInternals;
    expect(loop.lastEventAt).toBeNull();

    await inner.processEventsLive([nullTimestampEvent()], META, buildPlayerLookup(META));
    await inner.synthQueue;

    expect(loop.lastEventAt).not.toBeNull();
    expect(Number.isFinite(Date.parse(loop.lastEventAt as string))).toBe(true);
  });

  it("does not move when the replayed history holds nothing new", async () => {
    const loop = new CommentaryLoop(makeConfig(), recordingSink());
    const inner = loop as unknown as ProcessInternals;
    await inner.processEventsLive([nullTimestampEvent()], META, buildPlayerLookup(META));
    await inner.synthQueue;
    const first = loop.lastEventAt;

    await new Promise((r) => setTimeout(r, 5));
    await inner.processEventsLive([nullTimestampEvent()], META, buildPlayerLookup(META));
    await inner.synthQueue;

    expect(loop.lastEventAt).toBe(first);
  });
});

// Issue #52, kohta 2. Ottelussa 146210 hakuvirheryöppy vaati operaattorin
// väliintulon kesken liven: relay ei hidastanut pollausta itse, vaan jauhoi
// samaa 3 sekunnin tahtia kaatuvaa API:a vasten kunnes joku kävi kääntämässä
// välin 6 sekuntiin käsin.
//
// Tämän vahdin PAHIN lopputulos ei kuitenkaan ole hidas pollaus vaan se, että
// tahti EI palaudu: selostus laahaisi ottelusta jäljessä lopun matkaa vaikka
// API vastaisi taas moitteetta. Siksi painopiste on palautumisessa — yksi
// onnistunut haku riittää, ja väli on ylhäältä katkaistu myös sarjan aikana.
describe("CommentaryLoop pollausvälin jousto hakuvirhesarjassa (#52 kohta 2)", () => {
  const metaMock = vi.mocked(fetchMatchMetadata);
  const eventsMock = vi.mocked(fetchLiveEvents);
  const codes: string[] = [];
  const tempFiles: string[] = [];
  // Otettu talteen ennen kuin vi.useFakeTimers korvaa globaalin: tällä
  // päästetään oikea tapahtumasilmukka (ja sen levy-IO) läpi valekellosta
  // huolimatta.
  const realSetImmediate = setImmediate;

  interface RunInternals {
    run(): Promise<void>;
    stop(): void;
    consecutiveFetchFailures: number;
    effectivePollIntervalMs(): number;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    metaMock.mockReset();
    eventsMock.mockReset();
    metaMock.mockResolvedValue(META);
    codes.length = 0;
    setLogSink((entry) => {
      if (entry.code) codes.push(entry.code);
    });
  });

  afterEach(() => {
    setLogSink(null);
    vi.useRealTimers();
    for (const f of tempFiles.splice(0)) rmSync(f, { force: true });
  });

  /** Ajaa OIKEAN poll-silmukan valekellolla ja palauttaa peräkkäisten pollien
   *  välit millisekunteina. `succeeds(n)` kertoo onnistuuko n. polli (n alkaa
   *  1:stä); käynnistyksen historiahaku onnistuu aina eikä näy väleissä.
   *
   *  Kelloa siirretään AINA seuraavaan ajastimeen, ei kiinteällä ikkunalla, ja
   *  joka siirron välissä päästetään OIKEA tapahtumasilmukka läpi. Kumpikin osa
   *  on pakollinen, ja molemmat opittiin tätä kirjoittaessa:
   *
   *  - `advanceTimersByTime(60_000)` kelasi koko ikkunan kerralla silloin kun
   *    silmukka oli kesken syklin eikä yhtään ajastinta ollut jonossa. Kello oli
   *    minuutin edellä ennen kuin ensimmäistäkään pollia ehti tapahtua, ja
   *    mitatut välit olivat puhdasta roskaa.
   *  - Sykli odottaa välissä oikeaa levy-IO:ta (tilatiedoston tallennus), jota
   *    valekellon kelaus ei valmistele: ilman oikeaa `setImmediate`-käyntiä
   *    silmukka jäi odottamaan IO:ta, kierrosbudjetti paloi tyhjään ja pollien
   *    määrä vaihteli ajokerroittain. */
  async function pollGaps(
    succeeds: (poll: number) => boolean,
    wantedPolls: number,
    pollInterval = 3000
  ): Promise<number[]> {
    const instants: number[] = [];
    let call = 0;
    eventsMock.mockImplementation(async () => {
      const poll = call++;
      // Poll 0 = run():n käynnistyshaku, ei osa pollaustahtia.
      if (poll === 0) return { events: [], team: null, period: null } as never;
      instants.push(Date.now());
      if (!succeeds(poll)) throw new Error("API ei vastaa");
      return { events: [], team: null, period: null } as never;
    });

    // Omat tiedostopolut per ajo. Jaettu /tmp-polku ei ole makuasia: toinen
    // testi tässä samassa tiedostossa kirjoittaa control-tiedoston, ja silloin
    // refreshRuntimeControls ylikirjoittaa juuri sen pollausvälin, jota tässä
    // mitataan (havaittu: 20 s:n tahti muuttui ajossa 3 s:ksi).
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const stateFile = `/tmp/pesis-52-state-${tag}.json`;
    tempFiles.push(stateFile);

    const loop = new CommentaryLoop(
      makeConfig({
        pollInterval,
        dryRun: true,
        stateFile,
        controlFile: `/tmp/pesis-52-control-${tag}.json`,
      }),
      async () => {}
    ) as unknown as RunInternals;
    const run = loop.run().catch(() => {});
    // Kierrosbudjetti on reilu tarkoituksella: yksi polli vaatii useita
    // kierroksia (ajastin kerrallaan + oikean IO:n läpipäästö), ja liian tiukka
    // budjetti näkyi juuri niin kuin oikea vika näkyisi — polleja tuli liian
    // vähän. Siksi alla oleva tarkistus vaatii pyydetyn määrän erikseen.
    for (let i = 0; i < 500 * wantedPolls + 2000 && instants.length < wantedPolls; i++) {
      await vi.advanceTimersToNextTimerAsync();
      await new Promise((resolve) => realSetImmediate(resolve));
    }
    loop.stop();
    await vi.runAllTimersAsync();
    await run;

    expect(instants.length).toBeGreaterThanOrEqual(wantedPolls);
    return instants.slice(1).map((t, i) => t - (instants[i] as number));
  }

  it("venyttää pollausväliä vasta virhesarjassa, ei yksittäisestä virheestä", async () => {
    const gaps = await pollGaps(() => false, 5);

    // Kaksi ensimmäistä virhettä ovat rutiinikohinaa (FETCH_FAILURE_ALARM_STREAK),
    // eivätkä saa vaikuttaa tahtiin lainkaan.
    expect(gaps.slice(0, 2)).toEqual([3000, 3000]);
    // Kolmannesta peräkkäisestä virheestä alkaen väli tuplaantuu.
    expect(gaps[2]).toBe(6000);
    expect(gaps[3]).toBe(12000);
  });

  it("ei venytä väliä yli katon, jottei selostus jää jälkeen ottelusta", async () => {
    const gaps = await pollGaps(() => false, 7);

    // MAX_POLL_INTERVAL_MS. Ilman kattoa tuplaantuminen veisi välin minuutteihin
    // ja API:n palatessa selostus olisi vastaavasti myöhässä.
    expect(Math.max(...gaps)).toBe(15_000);
    expect(gaps.at(-1)).toBe(15_000);
  });

  // TÄMÄ on se testi, jonka takia koko jousto on turvallinen kirjoittaa.
  it("palauttaa normaalin tahdin YHDESTÄ onnistuneesta hausta", async () => {
    // Kuusi virhettä peräkkäin vie välin kattoon asti; 7. polli onnistuu.
    const gaps = await pollGaps((poll) => poll >= 7, 12);

    // Sarjan aikana väli oli venynyt kattoon: 6. ja 7. pollin väli on 15 s.
    expect(gaps[5]).toBe(15_000);
    // Ja tässä on koko jutun ydin: 7. polli onnistui, joten SEURAAVA väli on jo
    // operaattorin tahti — ei vielä yhtä 15 sekunnin odotusta, jonka verran
    // selostus olisi turhaan myöhässä juuri kun API taas vastaa.
    expect(gaps[6]).toBe(3000);
    // …eikä tahti myöskään ryömi takaisin ylös onnistumisten jatkuessa.
    expect(gaps.slice(6)).toEqual([3000, 3000, 3000, 3000, 3000]);
    expect(codes).toContain("api.fetch_recovered");
  });

  it("ei pollaa nopeammin kuin operaattori pyysi, vaikka katto olisi lyhyempi", async () => {
    // 20 s > MAX_POLL_INTERVAL_MS: katto ei saa "hidastaa" tahtia 15 sekuntiin.
    const gaps = await pollGaps(() => false, 5, 20_000);

    expect(gaps.length).toBeGreaterThan(2);
    expect(gaps.every((g) => g === 20_000)).toBe(true);
  });

  it("ei tuota MIN_POLL_INTERVAL_MS:ää lyhyempää väliä", () => {
    const loop = new CommentaryLoop(
      makeConfig({ pollInterval: 500 }),
      async () => {}
    ) as unknown as RunInternals;

    loop.consecutiveFetchFailures = 3;
    expect(loop.effectivePollIntervalMs()).toBeGreaterThanOrEqual(2000);
  });
});
