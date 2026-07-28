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

vi.mock("../src/server/matches.js", () => ({
  getMatch: vi.fn(
    async (id: number): Promise<MatchOption> => ({
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

const { activateJob, createJob, getActiveJob, setJobStatus } = await import(
  "../src/server/jobs.js"
);

beforeEach(() => {
  writeFileSync(jobsFile, "[]", "utf8");
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
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

  it("getActiveJob surfaces the blocking job over any merely-scheduled one", async () => {
    const jobA = await createJob({ matchId: 1 });
    const jobB = await createJob({ matchId: 2 });
    await setJobStatus(jobB.id, "scheduled");
    await setJobStatus(jobA.id, "live");

    const active = await getActiveJob();
    expect(active?.id).toBe(jobA.id);
  });
});
