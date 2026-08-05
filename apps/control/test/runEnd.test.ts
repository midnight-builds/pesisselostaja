/** The relay shuts itself down when the source ends — nobody calls
 *  /api/relay/stop for a normal broadcast (uptime first: we never cut it). The
 *  live aggregator is the only always-on observer of that moment, so it is the
 *  one that has to let go of the broadcast slot (#101).
 *
 *  Everything the aggregator reads from the machine is mocked; the job store is
 *  injected through its options, the way the health tests already do. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, RelayProcess } from "../src/shared/types.js";

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
  // Lähteen tilan polleri (#104 vaihe 1) tuo nämä samasta moduulista. Mock on
  // koko moduulin korvaus, joten puuttuva export kaataa importin — vaikka tämä
  // testi ei pollaria käytäkään.
  readRunningMatchId: vi.fn(async () => null),
  readRunningStatus: vi.fn(async () => null),
  writeSourceIngest: vi.fn(async () => undefined),
  readSourceIngest: vi.fn(async () => null),
}));
// Työjono EI saa olla oikea täällä: CONFIG.stateDir osoittaa kehityskoneen
// omaan run/-hakemistoon, jossa on oikeita töitä, ja sovittelu sulkee töitä.
// Kaikki mitä aggregaattori tarvitsee injektoidaan optioina — jos jokin polku
// silti käyttää oletusta, se räjähtää tässä eikä koske oikeaan tilaan.
vi.mock("../src/server/jobs.js", () => {
  const forbidden = (name: string) => async () => {
    throw new Error(`jobs.js:n ${name} ei saa ajaa testissä — injektoi se optioissa`);
  };
  return {
    getActiveJob: vi.fn(forbidden("getActiveJob")),
    closeRunningJob: vi.fn(forbidden("closeRunningJob")),
    markRunStarted: vi.fn(forbidden("markRunStarted")),
    // Sovittelu ajetaan joka tikillä, joten oletus on vaaraton no-op; testit
    // jotka mittaavat sitä injektoivat oman.
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
// Telemetria mockataan, jottei tikki tee oikeaa levyluentaa: fake-timerit eivät
// odota oikeaa I/O:ta, ja kesken jäänyt tikki estää fastBusy-vahdin takia
// seuraavan — tämä on ollut tämän tiedoston ajoittaisen herkkyyden syy, ja
// #123:n laskevan reunan telemetrialuku teki siitä pysyvän. null = relay ei
// kerro lopetussyytä, joten hard stop -siivous ei laukea täällä.
vi.mock("../src/server/telemetry.js", () => ({
  readRelayStatus: vi.fn(async () => null),
  NarrationTimeline: class {
    async poll(): Promise<void> {}
    lines(): [] {
      return [];
    }
  },
}));
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
// The match poller must never reach the real pesistulokset API from a test.
vi.mock("../src/server/matches.js", () => ({
  getMatchState: vi.fn(async () => {
    throw new Error("ei pollata testissä");
  }),
}));

const { startLiveAggregator } = await import("../src/server/live.js");
const { readRelayStatus } = await import("../src/server/telemetry.js");

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    status: "live",
    createdAt: "2026-07-29T09:00:00.000Z",
    matchId: 144980,
    home: "Ketut",
    away: "Sudet",
    seriesName: null,
    stadium: null,
    startsAt: null,
    sourceUrl: "https://youtube.com/x",
    targetStreamKey: "key",
    targetRtmpUrl: "rtmp://a.rtmp.youtube.com/live2",
    targetVideoId: null,
    armedAt: null,
    startedAt: "2026-07-29T09:05:00.000Z",
    endedAt: null,
    cleanup: null,
    note: null,
    ...overrides,
  };
}

/** Relay ylös/alas. uptimeSec kulkee mukana, koska sidonta vertaa
 *  status-tiedoston mtimea unitin käynnistyshetkeen — ilman uptimea havainto
 *  ei kelpaa todisteeksi lainkaan. */
function relayUp(): void {
  relayState = { ...relayState, activeState: "active", active: true, uptimeSec: 120 };
}

function relayDown(): void {
  relayState = { ...relayState, activeState: "inactive", active: false, uptimeSec: null };
}

/** Relayn oma status-tiedosto: tämän ajon kirjoittama (mtime = nyt). */
function runStatus(matchId: number | null) {
  return matchId === null ? null : { matchId, mtimeMs: Date.now() };
}

/** One aggregator cycle: the poll interval plus the awaits inside it. */
async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5000);
}

async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await tick();
}

/** Relay alhaalla settle-ikkunan (30 s) yli — se on ajon päättymisen ehto
 *  (#200). Lyhyempi katko on uudelleenkäynnistys, ei lopetus. */
async function settle(): Promise<void> {
  await ticks(8); // 40 s
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("relay run starting", () => {
  it("stamps the armed job as running when the unit comes up", async () => {
    // Covers a hand-started relay too: the UI's start button and systemctl look
    // identical from here, and neither used to tell the job store anything.
    let active: Job = job({ status: "arming", startedAt: null });
    const markRunStarted = vi.fn(async () => {
      active = { ...active, status: "live", startedAt: "2026-07-29T09:05:00.000Z" };
      return active;
    });
    relayDown();

    const live = startLiveAggregator({
      getActiveJob: async () => active,
      markRunStarted,
      getRunningStatus: async () => runStatus(relayState.active ? active.matchId : null),
    });
    await tick();
    expect(markRunStarted).not.toHaveBeenCalled();

    relayUp();
    await tick();
    expect(markRunStarted).toHaveBeenCalledTimes(1);
    expect(markRunStarted).toHaveBeenCalledWith(144980);
    expect(live.current().job).toMatchObject({ status: "live" });

    // A steady relay is not a new start on every poll.
    await tick();
    expect(markRunStarted).toHaveBeenCalledTimes(1);
    live.stop();
  });

  // #118: the relay was started for match 145900 and the control app stamped the
  // previous evening's job (145895) as live. Everything downstream reads
  // job.matchId, so the operator's knobs went to a control file the running
  // relay never reads — and nothing on the screen said so.
  it("refuses to bind an armed job to a run of a different match", async () => {
    const markRunStarted = vi.fn(async () => null);
    const stale = job({ matchId: 145895, status: "arming", startedAt: null });
    relayUp();

    const live = startLiveAggregator({
      getActiveJob: async () => stale,
      markRunStarted,
      getRunningStatus: async () => runStatus(145900),
    });
    await tick();
    await tick();

    expect(markRunStarted, "väärä sidonta on huonompi kuin puuttuva").not.toHaveBeenCalled();
    expect(live.current().job).toMatchObject({ status: "arming" });
    // Ja ristiriita on näkyvissä, ei hiljainen.
    expect(live.current().health).toBe("fail");
    expect(live.current().headline).toContain("145900");
    expect(live.current().chain.find((r) => r.key === "relay")).toMatchObject({ health: "fail" });
    live.stop();
  });

  // The relay writes run/status-<matchId>.json a few seconds AFTER the unit goes
  // active. A one-shot rising edge would look for the evidence in exactly the
  // window where it does not exist yet, and the job would stay "arming" with no
  // startedAt for the whole broadcast.
  it("keeps trying until the relay says which match it is running", async () => {
    let active: Job = job({ status: "arming", startedAt: null });
    const markRunStarted = vi.fn(async () => {
      active = { ...active, status: "live", startedAt: "2026-07-29T09:05:00.000Z" };
      return active;
    });
    let evidence: number | null = null;
    relayUp();

    const live = startLiveAggregator({
      getActiveJob: async () => active,
      markRunStarted,
      getRunningStatus: async () => runStatus(evidence),
    });
    await tick();
    expect(markRunStarted, "ei näyttöä vielä — ei sidota").not.toHaveBeenCalled();

    evidence = 144980;
    await tick();
    expect(markRunStarted).toHaveBeenCalledWith(144980);
    live.stop();
  });

  /** Relay kirjoittaa status-tiedoston vielä sammuessaan, joten PÄÄTTYNEEN ajon
   *  tiedosto on `readRunningStatus`in tuoreusikkunassa (60 s) vielä minuutin
   *  sen jälkeen kun mitään ei aja. Se on tasan se ikkuna, jossa operaattori
   *  aktivoi seuraavan ottelun ja käynnistää relayn — ja jos edellisen ajon
   *  tiedosto kelpaisi todisteeksi, sovittelu perisi juuri aktivoidun työn
   *  ennen kuin lähetys ehti alkaa. */
  it("ei usko edellisen ajon status-tiedostoa tämän ajon todisteeksi", async () => {
    const markRunStarted = vi.fn(async () => null);
    const reconcileOpenJobs = vi.fn(async () => []);
    const armed = job({ matchId: 145900, status: "arming", startedAt: null });
    relayUp(); // uptimeSec 120 s — unit käynnistyi äsken
    const previousRunWroteAt = Date.now() - 200_000; // ennen unitin käynnistystä

    const live = startLiveAggregator({
      getActiveJob: async () => armed,
      markRunStarted,
      reconcileOpenJobs,
      getRunningStatus: async () => ({ matchId: 145895, mtimeMs: previousRunWroteAt }),
    });
    await tick();
    await tick();

    expect(reconcileOpenJobs, "ei perua juuri aktivoitua työtä").not.toHaveBeenCalled();
    expect(markRunStarted).not.toHaveBeenCalled();
    // Eikä väärää ristiriitavaroitusta: näyttöä tästä ajosta ei vielä ole.
    expect(live.current().health).not.toBe("fail");
    live.stop();
  });

  it("ei leimaa työtä käyntiin kun relay ei ole ajossa", async () => {
    // Sama tuore tiedosto, mutta unit on alhaalla: mikään ei aja, joten mitään
    // ei myöskään ole sidottavana.
    const markRunStarted = vi.fn(async () => null);
    const armed = job({ status: "arming", startedAt: null });
    relayDown();

    const live = startLiveAggregator({
      getActiveJob: async () => armed,
      markRunStarted,
      getRunningStatus: async () => runStatus(144980),
    });
    await tick();
    await tick();
    expect(markRunStarted).not.toHaveBeenCalled();
    live.stop();
  });

  it("ei julkaise toisen ottelun telemetriaa eikä selostuslistaa ristiriidassa", async () => {
    // Telemetria ja selostuslista luetaan työn ottelulla, joten ristiriidassa
    // molemmat kuvaavat väärää ottelua. Issue #118: eilisen ottelun rivit
    // renderöityivät nykyisenä lähetyksenä ilman mitään vanhentumismerkkiä.
    vi.mocked(readRelayStatus).mockResolvedValue({
      at: new Date().toISOString(),
      matchId: 145895,
      startedAt: new Date().toISOString(),
      uptimeSec: 60,
      readerAttached: true,
      pendingClips: 0,
      respawns: 0,
      source: { state: "live", detail: "ffmpeg käynnissä" },
      match: { finished: false, eventCount: 3, lastEventAt: new Date().toISOString() },
      narration: { detected: 3, spoken: 3, muted: 0, queued: 0 },
      tts: { engine: "piper", elevenLabsCharsUsed: 0 },
      lastProblem: null,
      endReason: null,
    });
    relayUp();

    const live = startLiveAggregator({
      getActiveJob: async () => job({ matchId: 145895, status: "live" }),
      markRunStarted: async () => null,
      closeRunningJob: async () => null,
      getRunningStatus: async () => runStatus(145900),
    });
    await tick();

    expect(live.current().telemetry).toBeNull();
    expect(live.current().narration).toEqual([]);
    live.stop();
    vi.mocked(readRelayStatus).mockResolvedValue(null);
  });
});

describe("relay run ending", () => {
  it("closes the job when the relay goes away on its own", async () => {
    // Suljettu työ jää näkyviin (`getActiveJob` palauttaa myös `finished`in),
    // eli fake käyttäytyy kuten oikea työjono — settlen jälkeiset tikit lukevat
    // sen yhä.
    let active: Job | null = job();
    const closeRunningJob = vi.fn(async () => {
      const closed: Job = { ...(active as Job), status: "finished" };
      active = closed;
      return closed;
    });

    relayUp();
    const live = startLiveAggregator({ getActiveJob: async () => active, closeRunningJob });
    await tick();
    expect(closeRunningJob, "ei suljeta mitään niin kauan kuin relay on ajossa").not.toHaveBeenCalled();

    // The relay self-shuts down: unit goes inactive without anyone asking.
    relayDown();
    await tick();
    expect(closeRunningJob, "yksi havainto ei ole lopetus (#200)").not.toHaveBeenCalled();

    await settle();
    expect(closeRunningJob).toHaveBeenCalledTimes(1);
    // Nimetty työ: poller sulkee sen ajon jota se seurasi (#118).
    expect(closeRunningJob).toHaveBeenCalledWith("job-1");
    // The closed job stays on screen — the operator still wants to see which
    // run just ended; it simply no longer holds the slot.
    expect(live.current().job).toMatchObject({ status: "finished" });

    // And only once: the following polls see a slot that is already free.
    await tick();
    await tick();
    expect(closeRunningJob).toHaveBeenCalledTimes(1);
    live.stop();
  });

  /** #200: laskeva reuna laukesi YHDESTÄ havainnosta. Relayn uudelleen-
   *  käynnistys kestää noin neljä sekuntia — vähemmän kuin tikin 5 s — ja
   *  operaattorilla on nimenomainen lupa tehdä se kesken ottelun. Työ meni
   *  `finished`iksi eikä palannut, joten ottelun oikeassa lopussa ei tehty
   *  hard stopin siivousta, kortti näytti EndedCardia kesken ottelun ja
   *  päättymispush lähti tyhjästä siivousmerkinnästä. */
  it("ei sulje työtä relayn uudelleenkäynnistyksen ajaksi", async () => {
    const active: Job = job();
    const closeRunningJob = vi.fn(async () => null);
    const recordJobCleanup = vi.fn(async () => null);
    relayUp();

    const live = startLiveAggregator({
      getActiveJob: async () => active,
      closeRunningJob,
      recordJobCleanup,
      getRunningStatus: async () => runStatus(relayState.active ? 144980 : null),
    });
    await tick();

    // systemctl restart: unit alhaalla yhden tikin verran, sitten takaisin.
    relayDown();
    await tick();
    relayUp();
    await tick();
    await tick();

    expect(closeRunningJob, "uudelleenkäynnistys ei ole ajon loppu").not.toHaveBeenCalled();
    expect(recordJobCleanup, "tyhjä siivousmerkintä estäisi oikean (#187)").not.toHaveBeenCalled();
    expect(live.current().job).toMatchObject({ status: "live" });

    // Ja ottelun OIKEA loppu sulkee työn yhä.
    relayDown();
    await settle();
    expect(closeRunningJob).toHaveBeenCalledWith("job-1");
    live.stop();
  });

  /** Settle-ikkunaa pidempi katko (kaatumissilmukka, käsin tehty korjaus)
   *  sulkee työn oikeutetusti — mutta jos relay palaa ajamaan SAMAA ottelua,
   *  ohjaamon on palattava sen mukana. `markRunStarted` vaatii
   *  `isBlocking`-tilan, joten `finished` oli yksisuuntainen ovi (#200). */
  it("palauttaa suljetun työn ajoon kun relay ajaa yhä samaa ottelua", async () => {
    let active: Job = job();
    const closeRunningJob = vi.fn(async () => {
      active = { ...active, status: "finished", endedAt: "2026-07-29T10:00:00.000Z" };
      return active;
    });
    const reopenRunningJob = vi.fn(async () => {
      active = { ...active, status: "live", endedAt: null, cleanup: null };
      return active;
    });
    relayUp();

    const live = startLiveAggregator({
      getActiveJob: async () => active,
      closeRunningJob,
      reopenRunningJob,
      markRunStarted: async () => null,
      getRunningStatus: async () => runStatus(relayState.active ? 144980 : null),
    });
    await tick();

    // Pitkä katko: työ suljetaan, ja se on tässä vaiheessa oikein.
    relayDown();
    await settle();
    expect(closeRunningJob).toHaveBeenCalledTimes(1);

    // Relay palaa samaan otteluun.
    relayUp();
    await tick();
    await tick();

    expect(reopenRunningJob).toHaveBeenCalledWith(144980);
    expect(live.current().job).toMatchObject({ status: "live", endedAt: null });
    live.stop();
  });

  it("EI palauta työtä ajoon kun relay ajaa eri ottelua", async () => {
    const active: Job = job({ status: "finished", endedAt: "2026-07-29T10:00:00.000Z" });
    const reopenRunningJob = vi.fn(async () => null);
    relayUp();

    const live = startLiveAggregator({
      getActiveJob: async () => active,
      closeRunningJob: async () => null,
      reopenRunningJob,
      markRunStarted: async () => null,
      getRunningStatus: async () => runStatus(145900),
    });
    await tick();
    await tick();

    expect(reopenRunningJob).not.toHaveBeenCalled();
    live.stop();
  });

  it("leaves an armed job alone before the relay has ever started", async () => {
    // The normal pre-broadcast state: .env.relay written, unit not started yet.
    // Closing here would cancel the next broadcast before it began.
    const closeRunningJob = vi.fn(async () => null);
    relayDown();

    const live = startLiveAggregator({
      getActiveJob: async () => job({ status: "arming", startedAt: null }),
      closeRunningJob,
    });
    await tick();
    await tick();
    expect(closeRunningJob).not.toHaveBeenCalled();
    live.stop();
  });

  it("does not close anything when the job is already finished", async () => {
    const closeRunningJob = vi.fn(async () => null);
    relayUp();

    const live = startLiveAggregator({
      getActiveJob: async () => job({ status: "finished" }),
      closeRunningJob,
    });
    await tick();
    relayDown();
    await tick();
    expect(closeRunningJob).not.toHaveBeenCalled();
    live.stop();
  });
});

/** The falling edge only fires if the control app was watching when the relay
 *  went down. A job left open across a control-app restart is invisible to it
 *  forever: that is how #118's job survived the night, and why #101's next
 *  activation kept failing. Reconciliation is the level-triggered cure. */
describe("reconciling the broadcast slot", () => {
  it("waits out a short relay restart before treating the slot as stale", async () => {
    const reconcileOpenJobs = vi.fn(async () => []);
    relayDown();

    const live = startLiveAggregator({
      getActiveJob: async () => null,
      reconcileOpenJobs,
      getRunningStatus: async () => null,
    });
    // A relay restart takes about four seconds; reconciling inside that window
    // would take the operator's controls away mid-broadcast.
    await ticks(4); // 20 s
    expect(reconcileOpenJobs).not.toHaveBeenCalled();

    await ticks(3); // yli 30 s
    expect(reconcileOpenJobs).toHaveBeenCalledWith(null, expect.any(Number));
    live.stop();
  });

  it("closes jobs for other matches as soon as it knows what the relay runs", async () => {
    const reconcileOpenJobs = vi.fn(async () => []);
    relayUp();

    const live = startLiveAggregator({
      getActiveJob: async () => null,
      reconcileOpenJobs,
      getRunningStatus: async () => runStatus(145900),
    });
    await tick();
    // No settling needed here: a running relay is positive evidence about which
    // job owns the slot, not an absence of evidence.
    expect(reconcileOpenJobs).toHaveBeenCalledWith(145900, expect.any(Number));
    live.stop();
  });

  it("never reconciles while the relay is up but silent about its match", async () => {
    const reconcileOpenJobs = vi.fn(async () => []);
    relayUp();

    const live = startLiveAggregator({
      getActiveJob: async () => null,
      reconcileOpenJobs,
      getRunningStatus: async () => null,
    });
    await ticks(8);
    expect(reconcileOpenJobs, "ilman näyttöä ei kosketa mihinkään").not.toHaveBeenCalled();
    live.stop();
  });
});

/** "Lopeta edellinen ja aktivoi tämä" (force) pysäyttää relayn ja vaihtaa
 *  slotin haltijan saman HTTP-pyynnön sisällä. Laskeva reuna näkee 5 s
 *  kuluttua relayn poissa ja slotissa JO SEURAAVAN ottelun työn — jos se
 *  sulkee sen, operaattori käynnistää relayn työhön joka on juuri peruttu:
 *  ei säätimiä, ei telemetriaa, ei hard stopin siivousta. */
describe("ottelusta toiseen vaihtaminen", () => {
  it("sulkee sen ajon jota seurattiin, ei slotin uutta haltijaa", async () => {
    const previous = job({ id: "job-a", matchId: 144980, status: "live" });
    const next = job({ id: "job-b", matchId: 145900, status: "arming", startedAt: null });
    let active: Job = previous;
    const closeRunningJob = vi.fn(async () => null);
    relayUp();

    const live = startLiveAggregator({
      getActiveJob: async () => active,
      closeRunningJob,
      markRunStarted: async () => null,
      getRunningStatus: async () => runStatus(relayState.active ? 144980 : null),
    });
    await tick();

    // Force-aktivointi: relay pysäytetään ja slotti vaihtaa haltijaa.
    relayDown();
    active = next;
    await settle();

    expect(closeRunningJob).toHaveBeenCalledWith("job-a");
    expect(closeRunningJob).not.toHaveBeenCalledWith("job-b");
    live.stop();
  });
});
