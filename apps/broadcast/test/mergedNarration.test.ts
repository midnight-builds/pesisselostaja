/** Jonoutuneiden selostusten yhdistäminen jononpurussa (#246).
 *
 *  Core-puolen sääntö on testattu erikseen (packages/core/test/
 *  mergeQueuedNarration.test.ts); tämä tiedosto koettelee KYTKENNÄN: että
 *  processEventsLive todella kerää kierroksen selostukset jonoksi, ajaa ne
 *  säännön läpi ja puhuu tuloksen — eikä pudota matkalla mitään.
 *
 *  Keksityt joukkueet ja pelaajat (julkinen repo, otteluissa alaikäisiä). */

import { describe, it, expect } from "vitest";
import { CommentaryLoop, type NarrationStatus, type SpeechSink } from "../src/commentaryLoop.js";
import type { RelayConfig } from "../src/config.js";
import { buildPlayerLookup } from "@pesisselostaja/core";
import type { LiveEvent, MatchMetadata, PlayerLookup, SubEvent } from "@pesisselostaja/core";

const META: MatchMetadata = {
  id: 900002,
  date: "2026-09-19",
  home: {
    id: 1,
    name: "Testilä Tähdet",
    shorthand: "TTä",
    players: [
      { id: 11, number: 1, name: "Milla Mäyrä", first_name: "Milla", last_name: "Mäyrä" },
      { id: 12, number: 2, name: "Aino Ilves", first_name: "Aino", last_name: "Ilves" },
    ],
    all_players: [11, 12],
  },
  away: { id: 2, name: "Esimerkki Eagles", shorthand: "EEa", players: [], all_players: [] },
  series: { name: "Testisarja" },
  stadium: { name: "Testikenttä" },
  live: true,
  started: true,
};

function makeConfig(): RelayConfig {
  return {
    matchId: 900002,
    youtubeUrl: "https://example.invalid/live",
    rtmpUrl: "",
    streamKey: "",
    voice: "harri-medium",
    piperBin: "piper",
    pollInterval: 4000,
    narrationGain: 1.3,
    narrationDelayMs: 0,
    maxQueuedNarrationMs: 0,
    firstSpeechDelayMs: 0,
    urlRefreshMs: 900000,
    ytdlpExtractorArgs: "",
    noSignalSlate: false,
    noSignalSlateAfterMs: 8000,
    noSignalSlateWidth: 1920,
    noSignalSlateHeight: 1080,
    maxFailureWindowMs: 720000,
    finishedFailureWindowMs: 120000,
    hardStopQuietMs: 180000,
    drainMaxMs: 0,
    deltaFetch: true,
    pollTrace: false,
    announceBatterChanges: true,
    dryRun: false,
    apiKey: "test",
    apiBase: "https://example.invalid/api",
    stateFile: "/tmp/pesis-test-nonexistent-state.json",
    runDir: "/tmp/",
    runRetentionDays: 0,
    ttsCacheMaxBytes: 0,
    pronunciationsFile: "/tmp/pesis-test-nonexistent-pron.json",
    controlFile: "/tmp/pesis-test-nonexistent-control.json",
    elevenLabsVoiceId: "x",
    elevenLabsModelId: "y",
  };
}

interface Inner {
  processEventsLive(events: LiveEvent[], meta: MatchMetadata, lookup: PlayerLookup): Promise<void>;
  maybeLatchNarrationReady(meta: MatchMetadata): void;
  synthQueue: Promise<void>;
}

/** Latched-and-attached loop, so speak() actually reaches the sink. The latch
 *  itself can emit one recap clip; tests read only the clips that follow. */
function readyLoop(): { inner: Inner; spoken: string[] } {
  const spoken: string[] = [];
  const sink = (async (_s: string, readable: string) => {
    spoken.push(readable);
  }) as SpeechSink;
  const port: NarrationStatus = {
    isReaderAttached: () => true,
    pendingClips: () => 0,
    firstAttachAt: () => 0,
  } as unknown as NarrationStatus;
  const loop = new CommentaryLoop(makeConfig(), sink, port) as unknown as Inner;
  loop.maybeLatchNarrationReady(META);
  spoken.length = 0;
  return { inner: loop, spoken };
}

const paloSub: SubEvent = { texts: [{ type: "event", text: "Palo", base: null }, { type: "stat", out: 1 }] };
function batterSub(playerId: number): SubEvent {
  return { texts: ["Lyöntivuorossa", { type: "player", id: playerId, team: 1 }] as SubEvent["texts"] };
}
const runSub: SubEvent = {
  texts: [{ type: "player", id: 11, team: 1 }, { type: "event", text: "löi juoksun", base: null }, { type: "stat", score: 1 }] as SubEvent["texts"],
};

function ev(id: number, subs: SubEvent[], overrides: Partial<LiveEvent> = {}): LiveEvent {
  return {
    id, groupType: "x", period: 0, inning: 0, batTurn: 0, team: 1, hTeam: 1,
    batter: null, pairIndex: null, hitNumber: null, hit: null,
    events: subs, timestamp: 100, updated: null,
    ...overrides,
  };
}

describe("jononpurun yhdistely (#246)", () => {
  it("kaksi peräkkäistä paloa samassa kierroksessa puhutaan yhtenä lauseena, joka mainitsee molemmat", async () => {
    const { inner, spoken } = readyLoop();
    await inner.processEventsLive([ev(1, [paloSub, paloSub])], META, buildPlayerLookup(META));
    await inner.synthQueue;
    const palot = spoken.filter((t) => t.toLowerCase().includes("palo"));
    expect(palot).toHaveLength(1);
    expect(palot[0].toLowerCase()).toContain("ensimmäinen");
    expect(palot[0].toLowerCase()).toContain("toinen");
  });

  it("ei yhdistä kun palojen välissä on juoksu", async () => {
    const { inner, spoken } = readyLoop();
    await inner.processEventsLive([ev(1, [paloSub, runSub, paloSub])], META, buildPlayerLookup(META));
    await inner.synthQueue;
    // Kaksi erillistä palolausetta. Yhdistetty lause tunnistuu monikosta
    // ("kaksi paloa" / "paloja tuli"), jota yksittäinen palo ei koskaan sano.
    expect(spoken.filter((t) => /palo/i.test(t))).toHaveLength(2);
    expect(spoken.some((t) => /paloa|paloja/i.test(t))).toBe(false);
    expect(spoken.some((t) => t.includes("löi juoksun"))).toBe(true);
  });

  it("ei yhdistä vuoronvaihdon yli — palot nollautuvat", async () => {
    const { inner, spoken } = readyLoop();
    await inner.processEventsLive(
      [ev(1, [paloSub]), ev(2, [paloSub], { team: 2, batTurn: 1 })],
      META,
      buildPlayerLookup(META)
    );
    await inner.synthQueue;
    // Kaksi erillistä palolausetta, ei yhtään yhdistettyä ("paloa peräkkäin").
    expect(spoken.filter((t) => /palo/i.test(t))).toHaveLength(2);
    expect(spoken.some((t) => /paloa|paloja/i.test(t))).toBe(false);
  });

  it("yksittäinen palo selostetaan ennallaan", async () => {
    const { inner, spoken } = readyLoop();
    await inner.processEventsLive([ev(1, [paloSub])], META, buildPlayerLookup(META));
    await inner.synthQueue;
    const palot = spoken.filter((t) => t.toLowerCase().includes("palo"));
    expect(palot).toHaveLength(1);
    expect(palot[0].toLowerCase()).toContain("ensimmäinen palo");
  });

  it("kaksi peräkkäistä lyöjänvaihtoa yhdistyy ja mainitsee molemmat pelaajat", async () => {
    const { inner, spoken } = readyLoop();
    await inner.processEventsLive([ev(1, [batterSub(11), batterSub(12)])], META, buildPlayerLookup(META));
    await inner.synthQueue;
    const lines = spoken.filter((t) => t.includes("Mäyrä") || t.includes("Ilves"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Mäyrä");
    expect(lines[0]).toContain("Ilves");
  });
});
