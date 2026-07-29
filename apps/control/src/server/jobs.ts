// Job queue: one job = one match = two YouTube broadcasts = one relay run
// (see DESIGN.md "Rajaus ja perusmalli"). Persistence is a flat JSON file via
// ./store.js; the invariant that matters here is queueing, not storage:
// only one job may be "arming" or "live" at a time, and a running broadcast
// is never cut automatically (DESIGN.md "Ajastus ja käynnistys" — uptime
// first). This file enforces that invariant; it never decides *when* to
// activate a job or touches .env.relay — that's the HTTP route + relay.ts's
// writeRelayEnv.
import { randomUUID } from "node:crypto";
import { createStore } from "./store.js";
import { DEFAULT_RTMP_URL } from "../shared/api.js";
import type { Job, JobStatus } from "../shared/types.js";
import type { CreateJobRequest, PatchJobRequest } from "../shared/api.js";
import { getMatch } from "./matches.js";

const store = createStore<Job[]>("jobs.json", []);

/** Thrown when a job is asked for a match the source doesn't have — nearly
 *  always a hand-typed or mispasted id. Its own type (not a bare Error) so the
 *  HTTP layer can answer 404 with this exact sentence instead of letting it
 *  fall through to the generic 500 handler, which would put a raw English
 *  fetch error in front of an operator standing in a field. */
export class MatchNotFoundError extends Error {
  readonly matchId: number;

  constructor(matchId: number) {
    super(`Ottelua ${matchId} ei löytynyt tulospalvelusta — tarkista ottelu-ID.`);
    this.name = "MatchNotFoundError";
    this.matchId = matchId;
  }
}

/** "Blocking" = holds the one broadcast slot the whole queue exists to
 *  serialize (DESIGN.md: "Yksi lähetys kerrallaan + jono"). */
function isBlocking(status: JobStatus): boolean {
  return status === "arming" || status === "live";
}

/** Thrown when activating a job would put a second one in the broadcast slot.
 *
 *  Its own type, and it carries the offending job, because this is a STATE
 *  conflict, not a server fault: the HTTP layer answers 409 and the UI offers
 *  "lopeta edellinen ja aktivoi tämä". As a bare Error it fell through to the
 *  generic 500 handler, and the operator's only way out was a hand-written
 *  PATCH — at the exact moment the next match had already started (#101). */
export class JobClashError extends Error {
  readonly clashing: Job;

  constructor(clashing: Job) {
    const verb = clashing.status === "live" ? "lähetyksessä" : "valmistelussa";
    super(
      `${clashing.home} vastaan ${clashing.away} on jo ${verb} — lopeta se ensin, ennen kuin tämä työ voi käynnistyä.`
    );
    this.name = "JobClashError";
    this.clashing = clashing;
  }
}

/** How a run that is over should be recorded. A job that never got as far as
 *  starting the relay was cancelled, not finished — "finished" on a broadcast
 *  that never happened would put a phantom run in the post-match reports. */
function closedStatus(job: Job): JobStatus {
  return job.startedAt ? "finished" : "cancelled";
}

function closeJob(job: Job, at: string): Job {
  return { ...job, status: closedStatus(job), endedAt: job.endedAt ?? at };
}

/** Applies a patch to one job inside the full list, enforcing the
 *  single-active-job invariant whenever the patch would newly put a job into
 *  "arming"/"live". Centralized so patchJob, activateJob and setJobStatus —
 *  the three paths that can change `status` — can't disagree on the rule.
 *
 *  `force` closes the clashing job instead of refusing. It is only ever set by
 *  an explicit operator action ("lopeta edellinen ja aktivoi tämä"); nothing
 *  automatic may use it, because a running broadcast is never cut on its own
 *  (DESIGN.md: uptime first). */
function applyPatch(
  jobs: Job[],
  id: string,
  patch: Partial<Job>,
  opts: { force?: boolean } = {}
): { jobs: Job[]; job: Job } {
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) throw new Error(`Työtä ${id} ei löytynyt.`);
  const current = jobs[idx];
  const nextStatus = patch.status ?? current.status;
  let nextJobs = jobs.slice();
  if (isBlocking(nextStatus) && nextStatus !== current.status) {
    const clashingIdx = nextJobs.findIndex((j) => j.id !== id && isBlocking(j.status));
    if (clashingIdx !== -1) {
      if (!opts.force) throw new JobClashError(nextJobs[clashingIdx]);
      // Same array, same write: the slot is never momentarily held by two jobs
      // and never momentarily held by none.
      nextJobs[clashingIdx] = closeJob(nextJobs[clashingIdx], new Date().toISOString());
    }
  }
  const job: Job = { ...current, ...patch };
  nextJobs = nextJobs.slice();
  nextJobs[idx] = job;
  return { jobs: nextJobs, job };
}

/** Runs a status/field change through applyPatch and store.update in one
 *  shot, returning the job as it ended up. `store.update`'s reducer must
 *  return the array to persist — applyPatch's thrown errors (not-found,
 *  invariant violation) propagate out of the reducer, so the store is never
 *  written on a rejected change. */
async function updateJob(id: string, patch: Partial<Job>): Promise<Job> {
  let job!: Job;
  await store.update((jobs) => {
    const result = applyPatch(jobs, id, patch);
    job = result.job;
    return result.jobs;
  });
  return job;
}

export async function listJobs(): Promise<Job[]> {
  return await store.read();
}

export async function createJob(req: CreateJobRequest): Promise<Job> {
  // The id can come straight from a pasted URL or be typed by hand, so an id
  // the source has never heard of is an ordinary user mistake — check the
  // lookup instead of reading team names off nothing.
  const match = await getMatch(req.matchId);
  if (!match) throw new MatchNotFoundError(req.matchId);
  const now = new Date().toISOString();
  const job: Job = {
    id: randomUUID().slice(0, 8),
    status: "draft",
    createdAt: now,
    matchId: req.matchId,
    home: match.home,
    away: match.away,
    seriesName: match.seriesName,
    stadium: match.stadium,
    startsAt: req.startsAt ?? match.startsAt,
    sourceUrl: req.sourceUrl ?? null,
    targetStreamKey: req.targetStreamKey ?? null,
    targetRtmpUrl: req.targetRtmpUrl ?? DEFAULT_RTMP_URL,
    targetVideoId: req.targetVideoId ?? null,
    startedAt: null,
    endedAt: null,
    note: req.note ?? null,
  };
  await store.update((jobs) => [...jobs, job]);
  return job;
}

export async function patchJob(id: string, patch: PatchJobRequest): Promise<Job> {
  return updateJob(id, patch);
}

/** Marks a job as the one about to go live. Deliberately does not touch
 *  .env.relay — DESIGN.md's routing splits that out to relay.ts's
 *  writeRelayEnv, called by the HTTP route once activation here succeeds. */
export async function activateJob(id: string): Promise<Job> {
  return updateJob(id, { status: "arming" });
}

export async function getActiveJob(): Promise<Job | null> {
  const jobs = await store.read();
  const blocking = jobs.find((j) => isBlocking(j.status));
  if (blocking) return blocking;
  const scheduled = jobs.filter((j) => j.status === "scheduled");
  if (scheduled.length === 0) return null;
  // "Viimeisin" = most recently created. startsAt can be null (not every
  // scheduled job has a kickoff time pinned down yet), so createdAt is the
  // only ordering key every job is guaranteed to have.
  return scheduled.reduce((latest, j) => (j.createdAt > latest.createdAt ? j : latest));
}

export async function setJobStatus(id: string, status: JobStatus): Promise<Job> {
  return updateJob(id, { status });
}
