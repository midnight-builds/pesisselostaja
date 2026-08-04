// jobs.ts enforces the single "one broadcast slot" invariant: only one job
// may be in "arming" or "live" at a time (DESIGN.md, "Yksi lähetys kerrallaan
// + jono"). jobs.ts creates its on-disk store (./store.js -> jobs.json) at
// MODULE LOAD time, bound to whatever CONFIG.stateDir was at that instant —
// so CONFIG.stateDir has to be redirected to a temp dir *before* jobs.ts is
// ever imported. Static imports execute before any of this file's own code
// regardless of where they're written, so this file uses dynamic `import()`
// (top-level await) to control the order: config first, then the override,
// then jobs.
//
// getMatch (matches.ts) is mocked so createJob never calls the real
// pesistulokset API.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatchOption } from "../src/shared/types.js";

/** An id the source has never heard of — the mock answers it the way the real
 *  getMatch does for a 404: null, not a throw and not a half-filled object. */
const UNKNOWN_MATCH_ID = 999_999_999;

vi.mock("../src/server/matches.js", () => ({
  getMatch: vi.fn(
    async (id: number): Promise<MatchOption | null> => (id === UNKNOWN_MATCH_ID ? null : {
      id,
      home: `Koti-${id}`,
      away: `Vieras-${id}`,
      homeShort: `K${id}`,
      awayShort: `V${id}`,
      startsAt: null,
      seriesName: null,
      stadium: null,
      live: false,
      status: "upcoming",
      resultString: null,
    })
  ),
}));

const { CONFIG } = await import("../src/server/config.js");
const tmpDir = mkdtempSync(join(tmpdir(), "pesis-control-jobs-"));
CONFIG.stateDir = tmpDir;
const jobsFile = join(tmpDir, "jobs.json");

const {
  activateJob,
  closeRunningJob,
  markRunStarted,
  markJobScheduled,
  reconcileOpenJobs,
  ARMING_STALE_MS,
  createJob,
  patchJob,
  getActiveJob,
  listJobs,
  setJobStatus,
  JobClashError,
  MatchNotFoundError,
} = await import("../src/server/jobs.js");

beforeEach(() => {
  writeFileSync(jobsFile, "[]", "utf8");
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// A match id reaches createJob straight from a hand-typed field or a pasted
// URL, so "no such match" is an ordinary mistake — not a crash, and not a 500
// carrying a raw English fetch error to a phone standing in a field.
describe("unknown match id", () => {
  it("rejects with a Finnish message naming the id, not a TypeError", async () => {
    await expect(createJob({ matchId: UNKNOWN_MATCH_ID })).rejects.toThrow(MatchNotFoundError);
    await expect(createJob({ matchId: UNKNOWN_MATCH_ID })).rejects.toThrow(
      /Ottelua 999999999 ei löytynyt tulospalvelusta — tarkista ottelu-ID\./
    );
  });

  it("stores no job for a match that does not exist", async () => {
    await expect(createJob({ matchId: UNKNOWN_MATCH_ID })).rejects.toThrow();
    expect(await listJobs()).toEqual([]);
  });

  it("still creates a job for a match that does exist", async () => {
    const job = await createJob({ matchId: 1 });
    expect(job).toMatchObject({ matchId: 1, home: "Koti-1", status: "draft" });
  });
});

describe("single active job invariant", () => {
  it("blocks a second job from arming while one is live, naming the blocking job in Finnish", async () => {
    const jobA = await createJob({ matchId: 1 });
    const jobB = await createJob({ matchId: 2 });
    await setJobStatus(jobA.id, "live");

    await expect(activateJob(jobB.id)).rejects.toThrow(
      /Koti-1 vastaan Vieras-1 on jo lähetyksessä/
    );
  });

  it("blocks a second job from arming while the first is only arming (not yet live)", async () => {
    const jobA = await createJob({ matchId: 1 });
    const jobB = await createJob({ matchId: 2 });
    await activateJob(jobA.id);

    await expect(activateJob(jobB.id)).rejects.toThrow(
      /Koti-1 vastaan Vieras-1 on jo valmistelussa/
    );
  });

  it("allows activation once the blocking job has left arming/live", async () => {
    const jobA = await createJob({ matchId: 1 });
    const jobB = await createJob({ matchId: 2 });
    await setJobStatus(jobA.id, "live");
    await setJobStatus(jobA.id, "finished");

    const activated = await activateJob(jobB.id);
    expect(activated.status).toBe("arming");
  });

  it("does not clash against itself when re-confirming the same status", async () => {
    const jobA = await createJob({ matchId: 1 });
    await setJobStatus(jobA.id, "live");
    await expect(setJobStatus(jobA.id, "live")).resolves.toMatchObject({ status: "live" });
  });

  it("refuses with JobClashError, so the HTTP layer can answer 409 instead of 500 (#101)", async () => {
    const jobA = await createJob({ matchId: 1 });
    const jobB = await createJob({ matchId: 2 });
    await setJobStatus(jobA.id, "live");

    const err = await activateJob(jobB.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobClashError);
    expect((err as InstanceType<typeof JobClashError>).clashing.id).toBe(jobA.id);
  });

  it("getActiveJob surfaces the blocking job over any merely-scheduled one", async () => {
    const jobA = await createJob({ matchId: 1 });
    const jobB = await createJob({ matchId: 2 });
    await setJobStatus(jobB.id, "scheduled");
    await setJobStatus(jobA.id, "live");

    const active = await getActiveJob();
    expect(active?.id).toBe(jobA.id);
  });
});

// #101: the relay stopping — by an operator's tap or by its own shutdown when
// the source ended — has to let go of the broadcast slot. Left holding it, the
// job blocks the NEXT match, and the operator finds out only when activation
// fails with the camera already moving.
describe("closing a run", () => {
  it("closes a run that made it on air as finished, stamping endedAt", async () => {
    const job = await createJob({ matchId: 1 });
    await activateJob(job.id);
    await markRunStarted(1);

    const closed = await closeRunningJob();
    expect(closed?.status).toBe("finished");
    expect(closed?.endedAt).not.toBeNull();
  });

  it("closes a job that never started as cancelled — a broadcast that never happened is not 'finished'", async () => {
    const job = await createJob({ matchId: 1 });
    await activateJob(job.id);

    const closed = await closeRunningJob();
    expect(closed?.status).toBe("cancelled");
  });

  it("frees the slot, so the next match activates without a hand-written PATCH", async () => {
    const jobA = await createJob({ matchId: 1 });
    const jobB = await createJob({ matchId: 2 });
    await setJobStatus(jobA.id, "live");
    await closeRunningJob();

    await expect(activateJob(jobB.id)).resolves.toMatchObject({ status: "arming" });
  });

  it("does nothing when no job holds the slot", async () => {
    const job = await createJob({ matchId: 1 });
    await setJobStatus(job.id, "scheduled");
    expect(await closeRunningJob()).toBeNull();
    expect((await listJobs())[0].status).toBe("scheduled");
  });
});

describe("forced activation", () => {
  it("closes the clashing job and takes the slot in one write", async () => {
    const jobA = await createJob({ matchId: 1 });
    const jobB = await createJob({ matchId: 2 });
    await activateJob(jobA.id);
    await markRunStarted(1);
    const jobC = await createJob({ matchId: 3 });
    expect(jobC.status).toBe("draft"); // unrelated job, must not move

    const activated = await activateJob(jobB.id, { force: true });
    expect(activated.status).toBe("arming");

    const jobs = await listJobs();
    expect(jobs.find((j) => j.id === jobA.id)?.status).toBe("finished");
    // The slot is held by exactly one job at every observable moment.
    expect(jobs.filter((j) => j.status === "arming" || j.status === "live")).toHaveLength(1);
  });

  it("is a no-op difference when there was nothing to close", async () => {
    const job = await createJob({ matchId: 1 });
    await expect(activateJob(job.id, { force: true })).resolves.toMatchObject({ status: "arming" });
  });
});

// Nothing used to stamp a job as running: the UI's start button, a hand-typed
// systemctl and (before the scheduler was ever switched on) every real
// broadcast left the job in "arming" with startedAt null — so a finished run
// had no start time at all.
describe("marking a run started", () => {
  it("moves the armed job to live and stamps startedAt", async () => {
    const job = await createJob({ matchId: 1 });
    await activateJob(job.id);

    const started = await markRunStarted(1);
    expect(started?.status).toBe("live");
    expect(started?.startedAt).not.toBeNull();
  });

  it("keeps the original start time when the relay flaps", async () => {
    const job = await createJob({ matchId: 1 });
    await activateJob(job.id);
    const first = await markRunStarted(1);

    await setJobStatus(job.id, "arming");
    const again = await markRunStarted(1);
    expect(again?.startedAt).toBe(first?.startedAt);
  });

  it("does nothing when no job is armed", async () => {
    const job = await createJob({ matchId: 1 });
    await setJobStatus(job.id, "scheduled");
    expect(await markRunStarted(1)).toBeNull();
  });
});

// #118: on 30.7.2026 the relay was started for match 145900 and the control app
// stamped the PREVIOUS EVENING's job (match 145895) as live, because the job was
// picked by status alone — first "arming" in file order. Everything downstream
// reads job.matchId, so the operator's narration and delay knobs were written to
// the wrong match's control file and the running relay never saw them.
describe("binding a run to the match the relay is actually running", () => {
  it("refuses to bind when the armed job is for a different match", async () => {
    const stale = await createJob({ matchId: 145895 });
    await activateJob(stale.id);

    expect(await markRunStarted(145900)).toBeNull();

    const jobs = await listJobs();
    expect(jobs[0].status).toBe("arming");
    expect(jobs[0].startedAt).toBeNull();
  });

  it("binds the job whose match the relay is running, not the first armed one", async () => {
    const other = await createJob({ matchId: 145895 });
    const running = await createJob({ matchId: 145900 });
    await setJobStatus(other.id, "scheduled");
    await activateJob(running.id);

    const started = await markRunStarted(145900);
    expect(started?.id).toBe(running.id);

    const jobs = await listJobs();
    expect(jobs.find((j) => j.id === other.id)?.startedAt).toBeNull();
  });

  it("is idempotent, so the scheduler and the poller can both stamp the same run", async () => {
    const job = await createJob({ matchId: 7 });
    await activateJob(job.id);

    const first = await markRunStarted(7);
    const second = await markRunStarted(7);
    expect(second?.startedAt).toBe(first?.startedAt);
    expect(second?.status).toBe("live");
  });
});

describe("closing a named run", () => {
  it("closes the job it was asked for", async () => {
    const job = await createJob({ matchId: 1 });
    await activateJob(job.id);

    const closed = await closeRunningJob(job.id);
    expect(closed?.id).toBe(job.id);
  });

  it("leaves the slot alone when the named job is not the one holding it", async () => {
    const holding = await createJob({ matchId: 1 });
    const other = await createJob({ matchId: 2 });
    await activateJob(holding.id);

    expect(await closeRunningJob(other.id)).toBeNull();
    expect((await listJobs()).find((j) => j.id === holding.id)?.status).toBe("arming");
  });
});

// The falling edge only fires if the control app was watching when the relay
// went down. A job left open across a control-app restart is invisible to it
// forever — which is how #118's job survived the night and swallowed the next
// morning's run, and how #101's activation kept failing with 409.
describe("reconciling open jobs", () => {
  it("closes a job left armed overnight while the relay runs another match", async () => {
    const stale = await createJob({ matchId: 145895 });
    await activateJob(stale.id);

    const closed = await reconcileOpenJobs(145900, Date.now() + ARMING_STALE_MS + 1000);
    expect(closed.map((j) => j.id)).toEqual([stale.id]);
    expect((await listJobs())[0].status).toBe("cancelled");
  });

  it("gives a just-armed job the same grace even when the relay runs another match", async () => {
    // Edellinen ottelu voi olla ajossa ilman omaa työtä (käsin käynnistetty
    // relay, tai työ suljettu alta). Silloin seuraavan ottelun valmistelu on
    // täysin normaalia, eikä sitä saa perua 5 s välein — oikea vastaus on
    // ristiriitavaroitus, jonka sidonta jo nostaa.
    const next = await createJob({ matchId: 145901 });
    await activateJob(next.id);

    expect(await reconcileOpenJobs(145900)).toEqual([]);
    expect((await listJobs())[0].status).toBe("arming");
  });

  it("closes a live job whose match is not the one running", async () => {
    // "live" ilman sitä ajoa: ajo on ohi riippumatta iästä.
    const job = await createJob({ matchId: 145895 });
    await activateJob(job.id);
    await markRunStarted(145895);

    const closed = await reconcileOpenJobs(145900);
    expect(closed[0].status).toBe("finished");
  });

  it("leaves the job of the run that is actually happening alone", async () => {
    const running = await createJob({ matchId: 145900 });
    await activateJob(running.id);
    await markRunStarted(145900);

    expect(await reconcileOpenJobs(145900)).toEqual([]);
    expect((await listJobs())[0].status).toBe("live");
  });

  it("closes a live job as finished when nothing is running", async () => {
    const job = await createJob({ matchId: 1 });
    await activateJob(job.id);
    await markRunStarted(1);

    const closed = await reconcileOpenJobs(null);
    expect(closed[0].status).toBe("finished");
    expect(closed[0].endedAt).not.toBeNull();
  });

  it("does not cancel a job armed a moment ago — arming early and waiting for the camera is normal", async () => {
    const job = await createJob({ matchId: 1 });
    await activateJob(job.id);

    expect(await reconcileOpenJobs(null)).toEqual([]);
    expect((await listJobs())[0].status).toBe("arming");
  });

  it("cancels a job that has been armed with no relay for longer than the grace", async () => {
    const job = await createJob({ matchId: 1 });
    await activateJob(job.id);

    const closed = await reconcileOpenJobs(null, Date.now() + ARMING_STALE_MS + 1000);
    expect(closed[0].status).toBe("cancelled");
  });

  it("treats a job armed before armedAt existed as stale by its creation time", async () => {
    // Jobs persisted before #118 have no armedAt. The one this bug was found on
    // was created the previous evening, so createdAt is the right fallback.
    const job = await createJob({ matchId: 1 });
    await activateJob(job.id);
    const jobs = JSON.parse(readFileSync(jobsFile, "utf8")) as Array<Record<string, unknown>>;
    delete jobs[0].armedAt;
    writeFileSync(jobsFile, JSON.stringify(jobs), "utf8");

    const closed = await reconcileOpenJobs(null, Date.now() + ARMING_STALE_MS + 1000);
    expect(closed[0].status).toBe("cancelled");
  });

  it("writes nothing when there is nothing to reconcile", async () => {
    const job = await createJob({ matchId: 1 });
    await setJobStatus(job.id, "scheduled");
    const before = readFileSync(jobsFile, "utf8");

    expect(await reconcileOpenJobs(null)).toEqual([]);
    expect(readFileSync(jobsFile, "utf8")).toBe(before);
  });
});

// Slotin voi ottaa myös suoralla PATCHilla — se on operaattorin hätäkeino, ja
// juuri sillä korjattiin 30.7. väärä sidonta käsin (#118). Jos se ei leimaa
// armedAt:ia, sovittelu putoaa createdAt:iin, joka on aamulla luodulla työllä
// jo tunteja vanha, ja työ perutaan heti sen alta.
describe("armedAt", () => {
  it("leimautuu myös käsin tehdyssä PATCHissa", async () => {
    const job = await createJob({ matchId: 1 });
    await patchJob(job.id, { status: "arming" });
    expect((await listJobs())[0].armedAt).not.toBeNull();
  });

  it("leimautuu setJobStatusin kautta", async () => {
    const job = await createJob({ matchId: 1 });
    await setJobStatus(job.id, "arming");
    expect((await listJobs())[0].armedAt).not.toBeNull();
  });

  it("ei siirry kun työ leimataan käyntiin", async () => {
    const job = await createJob({ matchId: 1 });
    await activateJob(job.id);
    const armed = (await listJobs())[0].armedAt;
    await markRunStarted(1);
    expect((await listJobs())[0].armedAt).toBe(armed);
  });

  it("suojaa PATCHilla armatun työn sovittelulta", async () => {
    // Vanha työ (createdAt aamulla) armattuna juuri nyt: sovittelu ei saa
    // perua sitä, vaikka createdAt on jo yli tunnin vanha.
    const job = await createJob({ matchId: 1 });
    await patchJob(job.id, { status: "arming" });

    expect(await reconcileOpenJobs(null, Date.now() + 5 * 60_000)).toEqual([]);
    expect((await listJobs())[0].status).toBe("arming");
  });
});

// #180: lähetysparin luonti jätti työn "draft"-tilaan, eikä ajastin koskaan
// ottanut sitä automaattikäynnistyksen ehdokkaaksi. Luontireitti kutsuu nyt
// markJobScheduledia; palvelin on tilan totuuslähde (#171), joten siirto ei
// saa tulla clientin PATCHista.
describe("markJobScheduled (#180)", () => {
  it("siirtää luonnoksen scheduled-tilaan ja tallentaa sen levylle", async () => {
    const job = await createJob({ matchId: 1 });
    expect(job.status).toBe("draft");

    const scheduled = await markJobScheduled(job.id);
    expect(scheduled.status).toBe("scheduled");
    expect((await listJobs())[0].status).toBe("scheduled");
  });

  it("ei pudota pidemmällä olevaa työtä taaksepäin (uudelleenluotu lähetyspari)", async () => {
    const job = await createJob({ matchId: 1 });
    await setJobStatus(job.id, "live");

    const after = await markJobScheduled(job.id);
    expect(after.status).toBe("live");
    expect((await listJobs())[0].status).toBe("live");
  });

  it("hylkää tuntemattoman työn suomenkielisellä virheellä", async () => {
    await expect(markJobScheduled("eiole123")).rejects.toThrow(/Työtä eiole123 ei löytynyt\./);
  });
});
