/** Hard stopin siivous (#123, vaihe 2).
 *
 *  Kun relay sammuttaa itsensä takarajan takia, kukaan ei enää lopeta
 *  YouTube-lähetyksiä — juuri se jätti ottelussa 145900 lähetyksen työntämään
 *  roskaa (#121). Laskeva reuna live.ts:ssä on ainoa aina päällä oleva
 *  havainnoija, joten siivous tehdään siellä.
 *
 *  Kaksi rajaa, jotka nämä testit vartioivat:
 *   - siivous tehdään VAIN kun relay kertoo `endReason === "hard_stop"`;
 *   - LÄHDElähetykseen kosketaan vain kun CONTROL_HARD_STOP_SOURCE on päällä.
 *
 *  Erillään runEnd.test.ts:stä tarkoituksella: se on tunnetusti herkkä
 *  ajastinkilpailulle, eikä sen mockeja haluta sotkea tähän.
 *  Joukkueiden nimet ovat keksittyjä (julkinen repo). */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, JobCleanup, RelayProcess, RelayTelemetry } from "../src/shared/types.js";
import type { TransitionResult } from "../src/server/youtube.js";

let relayState: RelayProcess = {
  activeState: "inactive",
  active: false,
  uptimeSec: null,
  deployedCommit: null,
  nRestarts: 0,
};

vi.mock("../src/server/relay.js", () => ({
  getRelayProcess: vi.fn(async () => relayState),
  readKnobs: vi.fn(async () => ({
    announceBatterChanges: true,
    narrationDelayMs: 4000,
    deltaFetch: true,
    pollIntervalMs: 3000,
  })),
  readRunningMatchId: vi.fn(async () => null),
  readRunningStatus: vi.fn(async () => null),
  writeSourceIngest: vi.fn(async () => undefined),
  readSourceIngest: vi.fn(async () => null),
}));
// Sama vartija kuin runEnd.test.ts:ssä: oikea työjono osoittaa kehityskoneen
// run/-hakemistoon, ja sovittelu sulkee töitä. Kaikki injektoidaan optioina.
vi.mock("../src/server/jobs.js", () => {
  const forbidden = (name: string) => async () => {
    throw new Error(`jobs.js:n ${name} ei saa ajaa testissä — injektoi se optioissa`);
  };
  return {
    getActiveJob: vi.fn(forbidden("getActiveJob")),
    closeRunningJob: vi.fn(forbidden("closeRunningJob")),
    markRunStarted: vi.fn(forbidden("markRunStarted")),
    reconcileOpenJobs: vi.fn(async () => []),
    // Siivouksen kirjaus (#187) ajetaan joka sulkemisella; mock korvaa koko
    // moduulin, joten puuttuva export kaataisi importin. Vaaraton no-op —
    // testi joka mittaa kirjausta injektoi oman.
    recordJobCleanup: vi.fn(async () => null),
    // Suljetun työn palautus ajoon (#200). Vaaraton oletus: ei palauta mitään.
    reopenRunningJob: vi.fn(async () => null),
  };
});
vi.mock("../src/server/journal.js", () => ({ readLog: vi.fn(async () => []) }));
vi.mock("../src/server/system.js", () => ({
  getSystemState: vi.fn(async () => ({
    diskFreeBytes: 10 * 1024 ** 3,
    diskTotalBytes: 30 * 1024 ** 3,
    diskCritical: false,
    memFreeBytes: 1024 ** 3,
    memTotalBytes: 4 * 1024 ** 3,
    load1: 0.5,
    cpuCount: 4,
  })),
}));
vi.mock("../src/server/matches.js", () => ({
  getMatchState: vi.fn(async () => {
    throw new Error("ei pollata testissä");
  }),
}));
// Ei koskaan oikeaa YouTube-API:a testistä: aggregaattori saa siivoajan
// injektiona, mutta moduuli ladataan silti importissa.
const forbidden = (name: string) =>
  vi.fn(async () => {
    throw new Error(`oikeaa YouTube-kutsua (${name}) ei saa tehdä testissä`);
  });
vi.mock("../src/server/youtube.js", () => ({
  transitionBroadcast: forbidden("transitionBroadcast"),
  // sourceIngest.ts nostaa nämä samasta moduulista; mock korvaa koko moduulin,
  // joten puuttuva export kaataisi importin.
  listBroadcasts: forbidden("listBroadcasts"),
  getStreamStatus: forbidden("getStreamStatus"),
}));

// Telemetria mockataan moduulitasolla, jottei aggregaattorin tikki tee YHTÄÄN
// oikeaa levyluentaa: fake-timerit eivät odota oikeaa I/O:ta, ja kesken jäävä
// tikki estää `fastBusy`-vahdin takia seuraavan — juuri se tekee
// runEnd.test.ts:stä ajoittain herkän. Siivouksen oma telemetrian luku
// injektoidaan erikseen (readTelemetry-optio).
vi.mock("../src/server/telemetry.js", () => ({
  readRelayStatus: vi.fn(async () => null),
  NarrationTimeline: class {
    async poll(): Promise<void> {}
    lines(): [] {
      return [];
    }
  },
}));

const { startLiveAggregator } = await import("../src/server/live.js");
const { readRelayStatus } = await import("../src/server/telemetry.js");

const SOURCE_VIDEO_ID = "srcVIDEO123";
const TARGET_VIDEO_ID = "tgtVIDEO456";

/** Aikaleimat rakennetaan suhteessa NYKYHETKEEN, ei kiinteinä merkkijonoina:
 *  siivouksen tuoreusvartija (#123) hylkää statuksen joka on yli
 *  TELEMETRY_STALE_MS vanha, joten kiinteä päivämäärä tekisi jokaisesta
 *  testistä "vanhentuneen ajon" heti kun kello käy eteenpäin. */
function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    status: "live",
    createdAt: "2026-07-30T05:00:00.000Z",
    matchId: 145900,
    home: "Ketut",
    away: "Sudet",
    seriesName: null,
    stadium: null,
    startsAt: null,
    sourceUrl: `https://www.youtube.com/watch?v=${SOURCE_VIDEO_ID}`,
    targetStreamKey: "key",
    targetRtmpUrl: "rtmp://a.rtmp.youtube.com/live2",
    targetVideoId: TARGET_VIDEO_ID,
    armedAt: null,
    startedAt: isoAgo(60 * 60 * 1000),
    endedAt: null,
    cleanup: null,
    note: null,
    ...overrides,
  };
}

function telemetry(
  endReason: RelayTelemetry["endReason"],
  overrides: Partial<RelayTelemetry> = {}
): RelayTelemetry {
  return {
    at: isoAgo(0),
    matchId: 145900,
    startedAt: isoAgo(60 * 60 * 1000),
    uptimeSec: 3522,
    readerAttached: false,
    pendingClips: 0,
    respawns: 3,
    source: { state: "no_signal", detail: "ffmpeg poistui heti" },
    match: { finished: true, eventCount: 412, lastEventAt: isoAgo(3 * 60 * 1000) },
    narration: { detected: 90, spoken: 90, muted: 0, queued: 0 },
    tts: { engine: "piper", elevenLabsCharsUsed: 0 },
    lastProblem: null,
    endReason,
    ...overrides,
  };
}

function ok(videoId: string): TransitionResult {
  return { videoId, ok: true, skipped: false, reason: "lopetettu (live -> complete)", lifeCycleStatus: "live" };
}

async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5000);
}

/** Ajaa yhden laskevan reunan: relay ajossa -> relay poissa. */
async function runFallingEdge(options: {
  endReason: RelayTelemetry["endReason"];
  hardStopSource?: boolean;
  transition?: (videoId: string) => Promise<TransitionResult>;
  telemetryOverrides?: Partial<RelayTelemetry>;
  jobOverrides?: Partial<Job>;
}): Promise<{
  transition: ReturnType<typeof vi.fn>;
  closeRunningJob: ReturnType<typeof vi.fn>;
  /** Se mitä työhön kirjattiin ajon päätyttyä (#187), tai null jos ei mitään. */
  cleanup: JobCleanup | null;
}> {
  let active: Job | null = job(options.jobOverrides);
  const closeRunningJob = vi.fn(async () => {
    const closed: Job = { ...(active as Job), status: "finished" };
    active = null;
    return closed;
  });
  let cleanup: JobCleanup | null = null;
  const recordJobCleanup = vi.fn(async (_id: string, record: JobCleanup) => {
    cleanup = record;
    return null;
  });
  const transition = vi.fn(options.transition ?? (async (videoId: string) => ok(videoId)));

  relayState = { ...relayState, activeState: "active", active: true };
  const live = startLiveAggregator({
    getActiveJob: async () => active,
    closeRunningJob,
    // Nouseva reuna leimaisi arming-työn käyntiin oikean job-varaston kautta;
    // testissä työn tila pysyy sinä miksi se on asetettu.
    markRunStarted: async () => null,
    transitionBroadcast: transition,
    readTelemetry: async () => telemetry(options.endReason, options.telemetryOverrides),
    hardStopSource: options.hardStopSource ?? false,
    recordJobCleanup,
  });
  await tick();
  relayState = { ...relayState, activeState: "inactive", active: false };
  // Settle-ikkuna (#200): ajon päättyminen vaatii relayn pysyvän alhaalla yli
  // 30 s. Yksi havainto on uudelleenkäynnistys, ei lopetus.
  for (let i = 0; i < 8; i += 1) await tick();
  live.stop();
  return { transition, closeRunningJob, cleanup };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("hard stop -siivous laskevalla reunalla", () => {
  it("lippu pois: kohde sammutetaan, lähteeseen EI kosketa", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { transition, closeRunningJob } = await runFallingEdge({
      endReason: "hard_stop",
      hardStopSource: false,
    });

    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledWith(TARGET_VIDEO_ID);
    expect(closeRunningJob).toHaveBeenCalledTimes(1);
    // Operaattorin on nähtävä lokista MIKSI lähteeseen ei koskettu.
    const skipLine = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(skipLine).toContain(SOURCE_VIDEO_ID);
    expect(skipLine).toContain("CONTROL_HARD_STOP_SOURCE");
  });

  it("lippu päällä: sekä kohde että lähde sammutetaan", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { transition } = await runFallingEdge({ endReason: "hard_stop", hardStopSource: true });

    expect(transition.mock.calls.map((c) => c[0])).toEqual([TARGET_VIDEO_ID, SOURCE_VIDEO_ID]);
  });

  it("normaali lopetus: ei transitiota lainkaan (enableAutoStop hoitaa kohteen)", async () => {
    const { transition, closeRunningJob } = await runFallingEdge({
      endReason: "ended",
      hardStopSource: true,
    });
    expect(transition).not.toHaveBeenCalled();
    expect(closeRunningJob).toHaveBeenCalledTimes(1);
  });

  it("vanha deploy joka ei kerro lopetussyytä: ei transitiota", async () => {
    const { transition } = await runFallingEdge({ endReason: null, hardStopSource: true });
    expect(transition).not.toHaveBeenCalled();
  });

  it("lähde ei ole omalla kanavalla: kohde sammuu ja lähteestä jää selkeä syy lokiin", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { transition, closeRunningJob } = await runFallingEdge({
      endReason: "hard_stop",
      hardStopSource: true,
      // Tyhjä id-haku = video ei ole omalla kanavalla. Siisti tulos, ei heitto.
      transition: async (videoId: string) =>
        videoId === SOURCE_VIDEO_ID
          ? {
              videoId,
              ok: false,
              skipped: true,
              reason: "lähetys ei ole tämän kanavan omistama (id-haku palautti tyhjän) — ei oikeutta lopettaa",
              lifeCycleStatus: null,
            }
          : ok(videoId),
    });

    expect(transition).toHaveBeenCalledTimes(2);
    expect(closeRunningJob).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("ei ole tämän kanavan omistama");
  });

  it("transitio kaatuu: työ suljetaan silti", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { transition, closeRunningJob } = await runFallingEdge({
      endReason: "hard_stop",
      hardStopSource: true,
      transition: async () => {
        throw new Error("YouTube API liveBroadcasts/transition -> HTTP 403");
      },
    });

    // Molemmat yritettiin, kumpikaan ei onnistunut — eikä työ jäänyt auki.
    expect(transition).toHaveBeenCalledTimes(2);
    expect(closeRunningJob).toHaveBeenCalledTimes(1);
  });
});

/** Tuoreusvartija. Nämä ovat siivouksen tärkeimmät testit: ilman vartijaa
 *  ohjaamo sammuttaa lähetyksiä levylle jääneen VANHAN ajon syyn perusteella,
 *  ja pahimmassa tapauksessa katkaisee toisen ihmisen lähdelähetyksen ennen
 *  kuin ottelu on edes alkanut. */
describe("hard stop -siivous: status-tiedoston on kuuluttava tähän ajoon", () => {
  it("EI siivoa arming-tilaista työtä — relay ei koskaan päässyt käyntiin", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    // Skenaario: edellinen ajo teki hard stopin ja jätti syyn levylle. Sama
    // ottelu aktivoidaan uudelleen, mutta relay kaatuu käynnistyksessä (unit
    // nousee ja putoaa) ehtimättä kirjoittaa statusta. Lähde on jo livenä.
    const { transition, closeRunningJob } = await runFallingEdge({
      endReason: "hard_stop",
      hardStopSource: true,
      jobOverrides: { status: "arming", startedAt: null },
    });

    expect(transition).not.toHaveBeenCalled();
    expect(closeRunningJob).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("EI siivoa vanhentuneen statuksen perusteella", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { transition, closeRunningJob } = await runFallingEdge({
      endReason: "hard_stop",
      hardStopSource: true,
      telemetryOverrides: { at: isoAgo(10 * 60 * 1000) }, // 10 min vanha kirjoitus
    });

    expect(transition).not.toHaveBeenCalled();
    expect(closeRunningJob).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(/ohitettu.*vanha/i);
  });

  it("EI siivoa kun status on työtä vanhemmasta ajosta", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { transition } = await runFallingEdge({
      endReason: "hard_stop",
      hardStopSource: true,
      // Status on tuore, mutta relayn ajo alkoi ennen tätä työtä.
      telemetryOverrides: { startedAt: isoAgo(3 * 60 * 60 * 1000) },
      jobOverrides: { startedAt: isoAgo(10 * 60 * 1000) },
    });

    expect(transition).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(/vanhemmasta ajosta/);
  });

  it("EI siivoa kun status kertoo eri ottelusta", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { transition } = await runFallingEdge({
      endReason: "hard_stop",
      hardStopSource: true,
      telemetryOverrides: { matchId: 999999 },
    });

    expect(transition).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("999999");
  });
});

/** Oletuspolku. Kaikki yllä oleva injektoi `readTelemetry`n, joten mikään ei
 *  vielä varmistanut että siivous OIKEASTI lukee `status-<matchId>.json`:n
 *  oikealla ottelutunnuksella. Väärä argumentti menisi läpi kaikista muista
 *  testeistä ja jättäisi siivouksen hiljaa tekemättä tuotannossa. */
describe("hard stop -siivous: oletuspolku lukee statuksen työn ottelutunnuksella", () => {
  it("kutsuu readRelayStatusia jobin matchId:llä kun readTelemetryä ei injektoida", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const readRelayStatusMock = vi.mocked(readRelayStatus);
    readRelayStatusMock.mockClear();

    let active: Job | null = job();
    const closeRunningJob = vi.fn(async () => {
      const closed: Job = { ...(active as Job), status: "finished" };
      active = null;
      return closed;
    });
    const transition = vi.fn(async (videoId: string) => ok(videoId));

    relayState = { ...relayState, activeState: "active", active: true };
    const live = startLiveAggregator({
      getActiveJob: async () => active,
      closeRunningJob,
      markRunStarted: async () => null,
      transitionBroadcast: transition,
      // readTelemetry TARKOITUKSELLA injektoimatta.
    });
    await tick();
    relayState = { ...relayState, activeState: "inactive", active: false };
    for (let i = 0; i < 8; i += 1) await tick(); // settle-ikkuna (#200)
    live.stop();

    expect(readRelayStatusMock).toHaveBeenCalledWith(145900);
    // Mock palauttaa null (ei syytä) → ei siivota, mutta työ suljetaan.
    expect(transition).not.toHaveBeenCalled();
    expect(closeRunningJob).toHaveBeenCalledTimes(1);
  });
});

/** Laskeva reuna vaatii että ohjaamo oli katsomassa kun relay sammui. Jos
 *  ohjaamo käynnistetään uudelleen sen jälkeen (deploy, kaatuminen), reunaa ei
 *  koskaan tule ja ilman tätä polkua kohde- JA lähdelähetys jäisivät päälle —
 *  siis tasan se vika jonka #123 poisti, palautettuna toista reittiä (#118). */
describe("hard stop -siivous sovittelun polulla", () => {
  it("siivoaa myös kun laskevaa reunaa ei koskaan nähty", async () => {
    const closed: Job = { ...job(), status: "finished", endedAt: isoAgo(0) };
    const transition = vi.fn(async (videoId: string) => ok(videoId));
    relayState = { ...relayState, activeState: "inactive", active: false, uptimeSec: null };

    const live = startLiveAggregator({
      getActiveJob: async () => job(),
      closeRunningJob: async () => null,
      markRunStarted: async () => null,
      // Sovittelu sulkee työn: ohjaamo herää maailmaan jossa relay on jo poissa.
      reconcileOpenJobs: async () => [closed],
      transitionBroadcast: transition,
      readTelemetry: async () => telemetry("hard_stop"),
      hardStopSource: true,
    });
    // Sovittelu odottaa 30 s ennen kuin alhaalla oleva relay tulkitaan
    // päättyneeksi ajoksi (relayn oma restart kestää sekunteja).
    for (let i = 0; i < 8; i += 1) await tick();

    expect(transition).toHaveBeenCalledWith(TARGET_VIDEO_ID);
    expect(transition).toHaveBeenCalledWith(SOURCE_VIDEO_ID);
    live.stop();
  });

  it("ei siivoa työtä joka ei koskaan päässyt käyntiin", async () => {
    // startedAt tyhjä = relay ei liikahtanut, joten levyn "hard_stop" on
    // väistämättä EDELLISEN ajon syy.
    const closed: Job = { ...job(), status: "cancelled", startedAt: null, endedAt: isoAgo(0) };
    const transition = vi.fn(async (videoId: string) => ok(videoId));
    relayState = { ...relayState, activeState: "inactive", active: false, uptimeSec: null };

    const live = startLiveAggregator({
      getActiveJob: async () => null,
      closeRunningJob: async () => null,
      markRunStarted: async () => null,
      reconcileOpenJobs: async () => [closed],
      transitionBroadcast: transition,
      readTelemetry: async () => telemetry("hard_stop"),
      hardStopSource: true,
    });
    for (let i = 0; i < 8; i += 1) await tick();

    expect(transition).not.toHaveBeenCalled();
    live.stop();
  });
});

/** Siivouksen kirjaus (#187).
 *
 *  Siivous, jota ei kirjata, on siivous jota kukaan ei näe: tilakortti näyttää
 *  tämän kentän sisällön sellaisenaan, ja päättymispush odottaa nimenomaan sen
 *  ilmestymistä (#174). Siksi kirjauksen on tapahduttava JOKA lopetuksessa —
 *  myös silloin kun tehtävää ei ollut — ja sen on kerrottava sekä teot että se,
 *  mistä lopetus pääteltiin. */
describe("siivouksen kirjaus työhön (#187)", () => {
  it("kirjaa myös normaalin lopetuksen: tyhjä tekolista ei ole puuttuva siivous", async () => {
    const { cleanup, transition } = await runFallingEdge({ endReason: "ended" });

    expect(transition).not.toHaveBeenCalled();
    expect(cleanup).not.toBeNull();
    expect(cleanup?.actions).toEqual([]);
    // Kaksi riippumatonta indikaattoria: relayn oma lopetussyy ja
    // tulospalvelun kirjaus (#171).
    expect(cleanup?.indicators).toContain("Raakalähetys päättyi.");
    expect(cleanup?.indicators).toContain("Tulospalvelu kirjasi ottelun päättyneeksi.");
  });

  it("kirjaa hard stopissa sen mitä oikeasti tehtiin ja mihin ei koskettu", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { cleanup } = await runFallingEdge({ endReason: "hard_stop", hardStopSource: false });

    expect(cleanup?.actions.map((a) => [a.what, a.ok])).toEqual([
      ["Selostettu lähetys suljettiin.", true],
      ["Raakalähetys jätettiin koskematta.", true],
    ]);
  });

  it("auki jäänyt lähetys kirjataan käskynä, koska sen sulkee vain ihminen", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { cleanup, closeRunningJob } = await runFallingEdge({
      endReason: "hard_stop",
      hardStopSource: false,
      transition: async () => {
        throw new Error("YouTube API liveBroadcasts/transition -> HTTP 403");
      },
    });

    const failed = cleanup?.actions.filter((a) => !a.ok) ?? [];
    expect(failed).toHaveLength(1);
    expect(failed[0].detail).toBe("Sulje selostettu lähetys YouTubessa itse.");
    // YouTuben oma virheteksti EI päädy operaattorin riville (#176).
    expect(JSON.stringify(cleanup)).not.toContain("HTTP 403");
    // Ja työ suljetaan silti: yksi YouTube-virhe ei saa lukita seuraavaa ottelua.
    expect(closeRunningJob).toHaveBeenCalledTimes(1);
  });

  it("ei väitä lopetussyytä vanhentuneesta status-tiedostosta", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // Sama vartija kuin siivouksella: toisen ottelun status ei kerro tästä
    // ajosta mitään, joten sen lopetussyy ei saa päätyä kortille perusteeksi.
    const { cleanup, transition } = await runFallingEdge({
      endReason: "hard_stop",
      hardStopSource: true,
      telemetryOverrides: { matchId: 999999 },
    });

    expect(transition).not.toHaveBeenCalled();
    expect(cleanup?.actions).toEqual([]);
    expect(cleanup?.indicators).not.toContain("Raakalähetys päättyi.");
  });
});
