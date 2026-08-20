import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock ONLY the network call, like commentaryLoopDelta.test.ts does.
vi.mock("@pesisselostaja/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pesisselostaja/core")>();
  return { ...actual, fetchLiveEvents: vi.fn() };
});

import { fetchLiveEvents } from "@pesisselostaja/core";
import type { LiveEvent, LiveEventsResult } from "@pesisselostaja/core";
import { CommentaryLoop, formatFetchDurations } from "../src/commentaryLoop.js";
import type { RelayConfig } from "../src/config.js";

const fetchMock = vi.mocked(fetchLiveEvents);

/** Issue #156: onnistuneen haun kestoa ei mitattu lainkaan, vain
 *  epäonnistuneen. Aikakatkaisuja viritettiin siksi kahdesti (#47, #81)
 *  pelkän jakauman hännän perusteella, ja kolmannella kerralla se johti
 *  väärään päätelmään. Nämä testit lukitsevat sen, että mittari mittaa
 *  oikeaa asiaa — ei sitä, mikä luku aikakatkaisu sattuu olemaan. */

function makeConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    matchId: 900001,
    youtubeUrl: "https://example.invalid/live",
    rtmpUrl: "", streamKey: "",
    voice: "harri-medium", piperBin: "piper",
    pollInterval: 3000, narrationGain: 1.3, narrationDelayMs: 0, maxQueuedNarrationMs: 0, firstSpeechDelayMs: 0,
    urlRefreshMs: 900000, ytdlpExtractorArgs: "", maxFailureWindowMs: 720000, finishedFailureWindowMs: 120000, hardStopQuietMs: 180000,
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
    controlFile: "/tmp/pesis-test-nonexistent-control.json",
    elevenLabsVoiceId: "x", elevenLabsModelId: "y",
    ...overrides,
  };
}

interface LoopInternals {
  fetchFullEvents(): Promise<LiveEventsResult>;
  fetchEventsForPoll(): Promise<LiveEventsResult | null>;
  maybeLogPollWindow(): void;
  lastPollSummaryAtMs: number;
  lastServerDateMs: number | null;
  lastFullFetchAt: number;
  history: { size: number };
  pollWindow: { fetchMs: { delta: number[]; meta: number[]; full: number[] }; failures: number };
  apiTimeoutMs(size: "delta" | "meta" | "full"): number;
  pollIntervalMs: number;
}

function makeLoop(overrides: Partial<RelayConfig> = {}): LoopInternals {
  return new CommentaryLoop(makeConfig(overrides), async () => {}) as unknown as LoopInternals;
}

// Fictional data only (public repo).
function ev(id: number): LiveEvent {
  return {
    id, groupType: "x", period: 0, inning: 0, batTurn: 0, team: 100, hTeam: 100,
    batter: null, pairIndex: null, hitNumber: null, hit: null,
    events: [], timestamp: 10, updated: null,
  };
}

function result(events: LiveEvent[] = []): LiveEventsResult {
  return { events, notModified: false, etag: null, serverDateMs: Date.parse("2026-07-31T10:00:00Z") };
}

beforeEach(() => fetchMock.mockReset());

describe("formatFetchDurations (#156)", () => {
  it("sanoo suoraan kun otos on tyhjä eikä esitä nollaa kestona", () => {
    // Tyhjä ikkuna on oikeasti mahdollinen: pelkkiä epäonnistumisia, tai
    // yhteenveto heti käynnistyksen jälkeen. "mediaani 0 ms" olisi valhe.
    expect(formatFetchDurations([])).toBe("ei onnistuneita hakuja");
  });

  it("raportoi MEDIAANIN eikä keskiarvoa, jottei yksi jumittunut haku piilota normaalitasoa", () => {
    // Tämä on koko mittarin pointti. 31.7.2026 ottelussa 145918 jakauma oli
    // kaksihuippuinen: ~100 ms tai yli 4000 ms. Keskiarvo tästä otoksesta
    // olisi 1075 ms — luku jota ei esiintynyt kertaakaan, ja joka olisi
    // saanut 4 s aikakatkaisun näyttämään perustellulta.
    const bimodal = [100, 100, 100, 4000];
    const formatted = formatFetchDurations(bimodal);
    expect(formatted).toContain("mediaani 100 ms");
    expect(formatted).toContain("max 4000 ms");
    expect(formatted).not.toContain("1075");
  });

  it("kertoo otoskoon, jotta lukua osaa painottaa", () => {
    expect(formatFetchDurations([5, 5, 5])).toContain("n=3");
  });

  it("ei riipu syötteen järjestyksestä eikä muuta sitä", () => {
    const samples = [300, 50, 200];
    const before = [...samples];
    expect(formatFetchDurations(samples)).toBe(formatFetchDurations([50, 200, 300]));
    expect(samples).toEqual(before);
  });
});

describe("pollWindow.fetchMs (#156)", () => {
  it("kirjaa onnistuneen haun keston", async () => {
    const loop = makeLoop();
    fetchMock.mockResolvedValueOnce(result());
    await loop.fetchFullEvents();
    expect(loop.pollWindow.fetchMs.full).toHaveLength(1);
    expect(loop.pollWindow.fetchMs.full[0]).toBeGreaterThanOrEqual(0);
    // Täyshaku EI saa päätyä delta- eikä meta-otokseen: eri raja kummallakin.
    expect(loop.pollWindow.fetchMs.delta).toEqual([]);
    expect(loop.pollWindow.fetchMs.meta).toEqual([]);
  });

  it("EI kirjaa epäonnistunutta hakua otokseen", async () => {
    // Regressio siitä, että ajanotto siirrettäisiin `finally`-lohkoon. Silloin
    // jokainen aikakatkaisu työntäisi otokseen tasan aikakatkaisun mittaisen
    // arvon, ja mittari alkaisi perustella itse sitä rajaa jota sen on
    // tarkoitus arvioida — sama kehäpäätelmä joka #156:n synnytti.
    const loop = makeLoop();
    fetchMock.mockRejectedValueOnce(new Error("This operation was aborted"));
    await expect(loop.fetchFullEvents()).rejects.toThrow("aborted");
    expect(loop.pollWindow.fetchMs.full).toEqual([]);
    expect(loop.pollWindow.fetchMs.delta).toEqual([]);
  });

  it("kerää useamman haun samaan ikkunaan", async () => {
    const loop = makeLoop();
    fetchMock.mockResolvedValue(result());
    await loop.fetchFullEvents();
    await loop.fetchFullEvents();
    await loop.fetchFullEvents();
    expect(loop.pollWindow.fetchMs.full).toHaveLength(3);
  });

  it("mittaa DELTA-haun ja kirjaa sen delta-otokseen", async () => {
    // Adversariaalinen katselmus 31.7.2026 huomautti, että alkuperäiset testit
    // ajoivat vain fetchFullEventsia: timedFetchin olisi voinut poistaa
    // delta-kutsusta ja sarja olisi pysynyt vihreänä — vaikka lähes kaikki
    // näytteet tulevat juuri sieltä (tyypillinen ikkuna: 304 5, delta 2,
    // täyshaku 0).
    const loop = makeLoop();
    // Delta vaatii palvelimen Date-leiman JA epätyhjän historian; ilman niitä
    // fetchEventsForPoll putoaa täyshakuun (ks. sen oma ehto). Historia
    // täytetään oikealla täyshaulla, koska `size` on vain getter.
    fetchMock.mockResolvedValueOnce(result([ev(1)]));
    await loop.fetchFullEvents();
    expect(loop.history.size).toBe(1);
    loop.lastFullFetchAt = Date.now();
    const fullBefore = loop.pollWindow.fetchMs.full.length;

    fetchMock.mockResolvedValueOnce({ ...result(), notModified: true });
    await loop.fetchEventsForPoll();

    expect(loop.pollWindow.fetchMs.delta).toHaveLength(1);
    expect(loop.pollWindow.fetchMs.full).toHaveLength(fullBefore);
    expect(loop.pollWindow.fetchMs.meta).toEqual([]);
  });

  it("nollaa otoksen kun ikkuna raportoidaan, jottei se kasva ottelun mitassa", async () => {
    // Ajetaan fetchEventsForPollin kautta: maybeLogPollWindow palaa heti jos
    // `polls === 0`, ja laskuri kasvaa vain siellä. Suoraan fetchFullEventsia
    // kutsumalla nollausta ei testattaisi lainkaan.
    const loop = makeLoop();
    fetchMock.mockResolvedValue(result([ev(1)]));
    await loop.fetchEventsForPoll();
    await loop.fetchEventsForPoll();
    expect(loop.pollWindow.fetchMs.full.length + loop.pollWindow.fetchMs.delta.length).toBeGreaterThan(0);

    // Pakota yhteenveto erääntymään.
    loop.lastPollSummaryAtMs = Date.now() - 60_000;
    loop.maybeLogPollWindow();

    expect(loop.pollWindow.fetchMs.full).toEqual([]);
    expect(loop.pollWindow.fetchMs.delta).toEqual([]);
    expect(loop.pollWindow.fetchMs.meta).toEqual([]);
  });
});

describe("apiTimeoutMs (#156:n viritys)", () => {
  it("delta-haku EI ole sidottu pollausväliin", () => {
    // Tämä on se rivi, joka olisi nollannut koko virityksen hiljaa. Ennen
    // #156:tta efektiivinen raja oli `max(base, pollIntervalMs)`, joten
    // vakion laskeminen 4000 → 1000 olisi tuottanut 3000 ms eikä 1000 ms —
    // eikä mikään lokissa olisi kertonut sitä. Perustelu (#89) sekoitti
    // kadenssin vasteaikaan: pollausväli kertoo kuinka usein kysytään, ei
    // kuinka kauan vastaus saa kestää.
    expect(makeLoop().apiTimeoutMs("delta")).toBe(1000);
    expect(makeLoop({ pollInterval: 8000 }).apiTimeoutMs("delta")).toBe(1000);
  });

  it("kokoonpanohaku pitää oman, väljemmän rajansa deltan virityksestä huolimatta", () => {
    // Delta ja meta jakoivat rajan #156:een asti. Mitattu jakauma (mediaani
    // 72–83 ms) on käytännössä pelkkiä deltoja, joten sillä ei saa virittää
    // metahakua: se palauttaa molemmat kokoonpanot, sitä haetaan kourallinen
    // kertoja otteluun, ja liian tiukka raja epäonnistuu HILJAA —
    // `maybeRefreshRoster` nielaisee virheen ja pitää vanhat nimet, jolloin
    // relay puhuu väärillä pelinumeroilla koko ottelun.
    expect(makeLoop().apiTimeoutMs("meta")).toBe(4000);
    expect(makeLoop({ pollInterval: 8000 }).apiTimeoutMs("meta")).toBe(4000);
  });

  it("täyshaku pitää pollausvälilattian, koska sen vastaus kasvaa ottelun mitassa", () => {
    // #47:n hyväksymiskriteeri, joka pätee yhä juuri täyshaulle: operaattori
    // voi nostaa pollausvälin ohjaustiedostosta yli 10 s:n, eikä raja saa
    // silloin katkaista hakua jonka hitautta itse kadenssi odottaa.
    expect(makeLoop().apiTimeoutMs("full")).toBe(10000);
    expect(makeLoop({ pollInterval: 15000 }).apiTimeoutMs("full")).toBe(15000);
  });
});

describe("delta-aikakatkaisun höllennys hakuvirhesarjassa (#156)", () => {
  interface FailureLoop extends LoopInternals {
    consecutiveFetchFailures: number;
    recordPollFailure(err: unknown, cycleStartedAt: number): void;
    recordPollSuccess(): void;
  }

  /** Silmukka, jonka virhe- ja onnistumiskirjaukset ajetaan oikeiden
   *  metodien läpi — venttiilin tila on niiden yhteispeliä, ei yhden kentän
   *  arvo, joten sitä ei saa testata kenttää käsin asettamalla. */
  function failingLoop(): FailureLoop {
    vi.spyOn(console, "log").mockImplementation(() => {});
    return makeLoop() as FailureLoop;
  }

  afterEach(() => vi.restoreAllMocks());

  it("antaa deltalle takaisin väljemmän rajan kolmannen peräkkäisen virheen jälkeen", () => {
    // 1 s riittää KUNNOSSA olevaa APIa vasten (mediaani ~80 ms). Jos API
    // joskus vastaa aidosti 1–4 s:ssä, kiinteä 1 s katkaisisi joka ikisen
    // deltan ja läpi menisi enää 60 s välein tehtävä täyshaku — selostus
    // laahaisi minuutin perässä. Sarja erottaa nämä kaksi tapausta:
    // jumittuneet yhteydet tulivat yksittäin (31/31 uusintaa onnistui
    // ensiyrittämällä), joten kolmas peräkkäinen virhe tarkoittaa että
    // oletus itsessään on väärä.
    const loop = makeLoop() as LoopInternals & { consecutiveFetchFailures: number };
    expect(loop.apiTimeoutMs("delta")).toBe(1000);

    loop.consecutiveFetchFailures = 2;
    expect(loop.apiTimeoutMs("delta")).toBe(1000);

    loop.consecutiveFetchFailures = 3;
    expect(loop.apiTimeoutMs("delta")).toBe(4000);
  });

  it("palaa tiukkaan rajaan kun API on vastannut riittävän monta pollia putkeen", () => {
    // Venttiili sulkeutuu — mutta vasta hystereesin (10 onnistunutta pollia)
    // jälkeen, ei ensimmäisestä onnistumisesta. Ks. seuraava testi siitä miksi.
    const loop = failingLoop();
    for (let i = 0; i < 3; i++) loop.recordPollFailure(new Error("This operation was aborted"), Date.now());
    expect(loop.apiTimeoutMs("delta")).toBe(4000);

    for (let i = 0; i < 9; i++) {
      loop.recordPollSuccess();
      expect(loop.apiTimeoutMs("delta"), `polli ${i + 1} onnistui, venttiilin pitää olla yhä auki`).toBe(4000);
    }
    loop.recordPollSuccess(); // 10.
    expect(loop.apiTimeoutMs("delta")).toBe(1000);
  });

  it("turvaventtiili pysyy auki eikä nollaudu ensimmäisestä onnistumisesta", () => {
    // Vika, joka löytyi PR #240:n katselmuksessa. `recordPollSuccess()`
    // nollasi `consecutiveFetchFailures`in, ja koska väljä raja luettiin
    // pelkästä laskurista, venttiili sulkeutui juuri sillä pollilla jonka se
    // päästi läpi. Aidosti 1–4 s:ssä vastaavaa APIa vasten syntyi nelivaiheinen
    // silmukka: 3 katkaisua 1 s:ssä → 4. polli saa 4 s ja onnistuu → laskuri
    // nollaantuu → seuraava polli on taas 1 s ja katkeaa. Kolme deltaa neljästä
    // hylättiin, tuoretta dataa tuli ~12 s välein 3 s sijaan, ja loki täyttyi
    // "HUOM, hakuvirhesarja" -riveistä, jotka ohjaamo näyttää operaattorille.
    const loop = failingLoop();

    // Vaihe 1–3: kolme katkaisua tiukalla rajalla.
    for (let i = 0; i < 3; i++) loop.recordPollFailure(new Error("This operation was aborted"), Date.now());
    expect(loop.apiTimeoutMs("delta"), "kolmas virhe avaa venttiilin").toBe(4000);

    // Vaihe 4: väljä raja päästää pollin läpi.
    loop.recordPollSuccess();

    // Tässä silmukka ennen katkesi: raja putosi takaisin 1 s:ään.
    expect(loop.apiTimeoutMs("delta"), "onnistuminen ei saa sulkea venttiiliä").toBe(4000);

    // Ja sama simuloituna kokonaisena ajona: API vastaa aidosti 2000 ms:ssä,
    // eli polli onnistuu täsmälleen silloin kun raja on väljä.
    const loop2 = failingLoop();
    const API_RESPONSE_MS = 2000;
    let ok = 0;
    for (let poll = 0; poll < 40; poll++) {
      if (loop2.apiTimeoutMs("delta") >= API_RESPONSE_MS) {
        ok++;
        loop2.recordPollSuccess();
      } else {
        loop2.recordPollFailure(new Error("This operation was aborted"), Date.now());
      }
    }
    // Ilman hystereesiä kuvio on 3 virhettä + 1 onnistuminen = 10/40 (25 %).
    // Hystereesin kanssa 3 virhettä + 10 onnistumista = 30/40 (75 %).
    expect(ok, "hystereesin kanssa valtaosa polleista menee läpi").toBeGreaterThan(25);
  });
});
