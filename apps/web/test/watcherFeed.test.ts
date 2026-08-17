import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildPlayerLookup,
  emptyState,
  type LiveEvent,
  type MatchMetadata,
  type Player,
  type SubEvent,
  type Team,
  type WatcherState,
} from "@pesisselostaja/core";
import {
  BrowserWatcher,
  type FeedItem,
  type WatcherCallbacks,
  type WatcherConfig,
} from "../src/watcher.js";

/** Issue #86: `apps/web`in syötteen johdotus oli katettu vain coren kautta.
 *  Coren `subEventToFeedText` / `subEventFeedDetail` on testattu perusteellisesti,
 *  mutta se MISSÄ ja MILLOIN `watcher.ts` niitä kutsuu oli todennettu vain
 *  lukemalla — eli #74:n korjaus olisi voinut pudota pois ilman että mikään
 *  kaatuu.
 *
 *  Nämä testit kutsuvat `processEventsLive`ä suoraan injektoidulla `onFeed`-
 *  callbackilla. Konstruktori ei koske DOMiin, joten selainympäristöä ei
 *  tarvita — `window` stubataan tässä tiedostossa (jsdom/happy-dom ei ole
 *  asennettu eikä sitä lisätä tämän takia).
 *
 *  KAIKKI pelaaja- ja joukkuenimet ovat keksittyjä: repo on julkinen ja
 *  otteluissa on alaikäisiä. */

// ---------------------------------------------------------------- window stub

/** Selaimen puhesynteesin tilalle: kerää puhutut tekstit ja päättää lausuman
 *  heti, jotta `_drainQueue` etenee ilman oikeaa ääntä. */
let spoken: string[] = [];

interface FakeUtterance {
  text: string;
  onend: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
}

function installWindowStub(): void {
  spoken = [];
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = {
    speechSynthesis: {
      paused: false,
      speak(u: FakeUtterance) {
        spoken.push(u.text);
        u.onend?.();
      },
      cancel() {},
      resume() {},
    },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  };
  g.SpeechSynthesisUtterance = class {
    text: string;
    lang = "";
    voice: unknown = null;
    onend: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  };
}

function removeWindowStub(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.window;
  delete g.SpeechSynthesisUtterance;
}

/** Antaa puhejonon valua loppuun. Peräkkäisten kuulutusten välissä on
 *  NARRATION_GAP_MS (700 ms) oikeaa odotusta, joten useamman kuulutuksen
 *  jonolle on annettava sitä pidempi aika. */
const flushSpeech = (ms = 20): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ fikstuuri

function player(id: number, number: number, first: string, last: string): Player {
  return { id, number, name: `${first} ${last}`, first_name: first, last_name: last };
}
function team(id: number, name: string, shorthand: string, players: Player[]): Team {
  return { id, name, shorthand, players, all_players: players.map((p) => p.id) };
}

const HOME = 100;
const AWAY = 200;

const meta: MatchMetadata = {
  id: 999001,
  date: "2026-08-16",
  home: team(HOME, "Kuusiston Kipinä", "Kipinä", [
    player(11, 5, "Ilona", "Karpalo"),
    player(12, 8, "Sanni", "Vuokko"),
    player(13, 9, "Peppi", "Nokkonen"),
  ]),
  away: team(AWAY, "Lahdenperän Salama", "Salama", [player(21, 3, "Roosa", "Sammal")]),
  series: { name: "Testisarja" },
  stadium: { name: "Testikenttä" },
  live: true,
  started: true,
};
const lookup = buildPlayerLookup(meta);

function liveEvent(id: number, subs: SubEvent[], over: Partial<LiveEvent> = {}): LiveEvent {
  return {
    id,
    groupType: "x",
    period: 0,
    inning: 0,
    batTurn: 0,
    team: HOME,
    hTeam: HOME,
    batter: null,
    pairIndex: null,
    hitNumber: null,
    hit: null,
    events: subs,
    timestamp: id,
    updated: null,
    ...over,
  };
}

const runSub: SubEvent = {
  texts: [
    { type: "player", id: 11 },
    { type: "event", text: "löi juoksun, tuojana", base: null },
    { type: "player", id: 12 },
    { type: "stat", score: 1 },
  ],
};
const outSub: SubEvent = {
  texts: [{ type: "event", text: "Palo", base: null }, { type: "stat", out: 1 }],
};
const matchEndSub: SubEvent = {
  texts: [{ type: "event", text: "Ottelu päättyi", base: null }],
};
/** Kokoonpanomuutos: puhe pudottaa listan (#48), syötteen on säilytettävä se (#74). */
const lineupSub: SubEvent = {
  texts: [
    { type: "team", id: HOME },
    "muutti lyöntijärjestystä. Uusi lyöntijärjestys:",
    { type: "substitution", team: HOME, newLineUp: ["11", "12", "13"], pitcher: 13 },
  ],
};
/** Sama data ilman puhuttavaa lausetta — `soloSpeech` on null, syötteen ei silti. */
const lineupOnlySub: SubEvent = {
  texts: [
    "Uusi lyöntijärjestys:",
    { type: "substitution", team: HOME, newLineUp: ["11", "12"] },
  ],
};

// --------------------------------------------------------------------- harness

interface PrivateWatcher {
  processEventsLive(
    events: LiveEvent[],
    state: WatcherState,
    meta: MatchMetadata,
    lookup: ReturnType<typeof buildPlayerLookup>,
  ): void;
}

interface Harness {
  watcher: BrowserWatcher;
  state: WatcherState;
  feed: FeedItem[];
  logs: string[];
  errors: string[];
  process(events: LiveEvent[]): void;
}

function harness(over: Partial<WatcherConfig> = {}): Harness {
  const feed: FeedItem[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const config: WatcherConfig = {
    pollInterval: 10_000,
    announceBatterChanges: true,
    apiKey: "test",
    apiBase: "http://localhost/never-called",
    ...over,
  };
  const callbacks: WatcherCallbacks = {
    onLog: (m) => logs.push(m),
    onMatchInfo: () => {},
    onFinished: () => {},
    onError: (e) => errors.push(e),
    onFeed: (item) => feed.push(item),
  };
  const watcher = new BrowserWatcher(config, callbacks);
  const state = emptyState();
  return {
    watcher,
    state,
    feed,
    logs,
    errors,
    process: (events) =>
      (watcher as unknown as PrivateWatcher).processEventsLive(events, state, meta, lookup),
  };
}

const feedTexts = (h: Harness): string[] => h.feed.map((i) => i.text);

// ----------------------------------------------------------------------- tests

beforeEach(installWindowStub);
afterEach(removeWindowStub);

describe("BrowserWatcher.processEventsLive: syötteen johdotus (#86)", () => {
  it("emittoi syöterivin joka kirjauksesta ja luokittelee sen", async () => {
    const h = harness();
    // Kaksi pollia, kuten livenä: jälkimmäinen tuo koko historian uudelleen.
    h.process([liveEvent(1, [runSub])]);
    await flushSpeech();
    h.process([liveEvent(1, [runSub]), liveEvent(2, [outSub])]);
    await flushSpeech();

    expect(h.errors).toEqual([]);
    expect(h.feed.map((i) => i.type)).toEqual(["run", "out"]);
    expect(h.feed[0].text).toMatch(/juoksu/i); // sanamuoto arvotaan (pickVariant)
    expect(h.feed[0].text).toMatch(/Karpalo/);
    expect(h.feed[0].text).toMatch(/Vuokko/);
    expect(h.feed[1].text).toMatch(/[Pp]alo/);
    // Puhe kulkee samalla — syöte ei ole puheen sivutuote eikä päinvastoin.
    expect(spoken.length).toBe(2);
  });

  it("näyttää syötteessä sen minkä puhe jättää sanomatta (#74)", async () => {
    // Tämä on se johdotus, joka #74:ssä korjattiin ja joka oli tähän asti
    // todennettu vain lukemalla: jos `subEventToFeedText`-kutsu putoaa pois
    // rivin 647 tienoilta, syöte menettää lyöntijärjestyksen mutta puhe pysyy
    // ennallaan — mikään aiempi testi ei olisi kaatunut siitä.
    const h = harness();
    h.process([liveEvent(1, [lineupSub])]);
    await flushSpeech();

    expect(feedTexts(h)).toEqual([
      "Kipinä muutti lyöntijärjestystä. Uusi lyöntijärjestys: 5 Karpalo, 8 Vuokko, 9 Nokkonen. Lukkarina 9 Nokkonen.",
    ]);
    expect(spoken).toEqual(["Kipinä muutti lyöntijärjestystä."]);
    // 11 nimeä peräkkäin on kuuntelukelvotonta (#48) — puheessa ei nimiä.
    expect(spoken[0]).not.toMatch(/Karpalo|Vuokko|Nokkonen/);
  });

  it("emittoi syöterivin myös kun puhuttavaa ei jää lainkaan", async () => {
    // `soloSpeech === null` -haara: syöterivi rakentuu pelkästä detailista.
    const h = harness();
    h.process([liveEvent(1, [lineupOnlySub])]);
    await flushSpeech();

    expect(feedTexts(h)).toEqual(["Uusi lyöntijärjestys: 5 Karpalo, 8 Vuokko."]);
    expect(h.feed[0].type).toBe("info");
    expect(spoken).toEqual([]);
  });

  it("päättyneen ottelun portti vaientaa puheen mutta ei syötettä", async () => {
    const h = harness();
    h.process([liveEvent(1, [matchEndSub])]);
    await flushSpeech();

    expect(h.state.finished).toBe(true);
    expect(h.feed).toHaveLength(1);
    expect(h.feed[0].type).toBe("end");
    const spokenAfterEnd = spoken.length;
    expect(spokenAfterEnd).toBe(1); // päätöslause itse puhutaan

    // Kirjaaja jatkaa merkintöjä lopetuksen jälkeen: syötteen on yhä
    // peilattava lähdettä, puheen ei.
    h.process([liveEvent(2, [outSub])]);
    await flushSpeech();

    expect(h.feed).toHaveLength(2);
    expect(h.feed[1].type).toBe("out");
    expect(spoken.length).toBe(spokenAfterEnd);
  });

  it("mykistettynä syöte täyttyy normaalisti, puhetta ei synny", async () => {
    const h = harness();
    h.watcher.setMuted(true);
    expect(h.watcher.muted).toBe(true);

    h.process([liveEvent(1, [lineupSub]), liveEvent(2, [runSub])]);
    await flushSpeech();

    expect(h.feed).toHaveLength(2);
    expect(h.feed[0].text).toMatch(/Uusi lyöntijärjestys: 5 Karpalo, 8 Vuokko, 9 Nokkonen\./);
    expect(h.feed[1].type).toBe("run");
    expect(spoken).toEqual([]);
  });

  it("ei toista syöterivejä kun sama historia pollataan uudelleen", async () => {
    // `online/{id}/events` palauttaa aina koko historian, ja processEventsLive
    // ajaa sen läpi joka pollilla — ilman fingerprint-vartiointia syöte
    // kasvaisi joka kierroksella.
    const h = harness();
    const events = [liveEvent(1, [runSub]), liveEvent(2, [outSub])];
    h.process(events);
    await flushSpeech(900); // kaksi kuulutusta ⇒ yksi NARRATION_GAP_MS-tauko
    const afterFirstPoll = feedTexts(h);
    expect(spoken).toHaveLength(2);

    h.process(events);
    await flushSpeech();

    expect(feedTexts(h)).toEqual(afterFirstPoll);
  });
});
