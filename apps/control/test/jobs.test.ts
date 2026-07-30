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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  createJob,
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
    await markRunStarted();

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
    await markRunStarted();
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

    const started = await markRunStarted();
    expect(started?.status).toBe("live");
    expect(started?.startedAt).not.toBeNull();
  });

  it("keeps the original start time when the relay flaps", async () => {
    const job = await createJob({ matchId: 1 });
    await activateJob(job.id);
    const first = await markRunStarted();

    await setJobStatus(job.id, "arming");
    const again = await markRunStarted();
    expect(again?.startedAt).toBe(first?.startedAt);
  });

  it("does nothing when no job is armed", async () => {
    const job = await createJob({ matchId: 1 });
    await setJobStatus(job.id, "scheduled");
    expect(await markRunStarted()).toBeNull();
  });
});
