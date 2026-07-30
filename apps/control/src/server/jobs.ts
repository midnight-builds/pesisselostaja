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
  // armedAt leimataan täällä eikä activateJobissa, koska slotin voi ottaa myös
  // suoralla PATCHilla (`{"status":"arming"}`) — se on operaattorin hätäkeino,
  // ja juuri sillä korjattiin 30.7. väärä sidonta käsin. Ilman leimaa
  // reconcileOpenJobs putoaisi createdAt:iin, joka on aamulla luodulla työllä
  // jo tunteja vanha, ja sovittelu perisi työn heti (#118). */
  const armedAt =
    nextStatus === "arming" && current.status !== "arming"
      ? new Date().toISOString()
      : (patch.armedAt ?? current.armedAt);
  const job: Job = { ...current, ...patch, armedAt };
  nextJobs = nextJobs.slice();
  nextJobs[idx] = job;
  return { jobs: nextJobs, job };
}

/** Runs a status/field change through applyPatch and store.update in one
 *  shot, returning the job as it ended up. `store.update`'s reducer must
 *  return the array to persist — applyPatch's thrown errors (not-found,
 *  invariant violation) propagate out of the reducer, so the store is never
 *  written on a rejected change. */
async function updateJob(
  id: string,
  patch: Partial<Job>,
  opts: { force?: boolean } = {}
): Promise<Job> {
  let job!: Job;
  await store.update((jobs) => {
    const result = applyPatch(jobs, id, patch, opts);
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
    armedAt: null,
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
 *  writeRelayEnv, called by the HTTP route once activation here succeeds.
 *
 *  `force` = the operator answered "lopeta edellinen ja aktivoi tämä". */
export async function activateJob(id: string, opts: { force?: boolean } = {}): Promise<Job> {
  // armedAt: ks. applyPatch — leima tulee sieltä, jotta myös suora PATCH saa sen.
  return updateJob(id, { status: "arming" }, opts);
}

/** How long a job may hold the slot in "arming" with no relay running before
 *  the reconciler treats it as abandoned. Generous on purpose: arming early and
 *  waiting for the camera operator is normal, and cancelling a job somebody is
 *  about to start is worse than leaving a dead one an hour longer. The case
 *  this exists for was a job left arming OVERNIGHT (#118). */
export const ARMING_STALE_MS = 60 * 60_000;

/** Stamps the armed job as actually running, and returns it — or null if there
 *  was nothing waiting to start.
 *
 *  The relay can be started from the UI, from the scheduler, or by hand with
 *  systemctl, and only the first two ever told the job store about it. So a job
 *  could sit in "arming" through a whole broadcast, `startedAt` stayed null,
 *  and the run had no start time at all in the post-match report. The observer
 *  that watches the unit does this instead, so every route is covered by one
 *  rule. */
export async function markRunStarted(matchId: number): Promise<Job | null> {
  let started: Job | null = null;
  await store.update((jobs) => {
    const idx = jobs.findIndex((j) => j.matchId === matchId && isBlocking(j.status));
    if (idx === -1) return jobs;
    const current = jobs[idx];
    // Idempotent: the scheduler stamps the job it just started, and the poller
    // stamps whatever the relay turns out to be running. Both paths run for a
    // scheduler start, and the second one must not write.
    if (current.status === "live" && current.startedAt) {
      started = current;
      return jobs;
    }
    const next = jobs.slice();
    next[idx] = {
      ...current,
      status: "live",
      // Kept if already set: a relay that flaps must not keep resetting the
      // run's start time.
      startedAt: current.startedAt ?? new Date().toISOString(),
    };
    started = next[idx];
    return next;
  });
  return started;
}

/** Closes the job that holds the broadcast slot, and returns it — or null if
 *  the slot was already free.
 *
 *  Called when the relay is no longer running: an operator's stop, or the
 *  relay's own shutdown once the source ended. Without this the job stays
 *  "arming" forever and the NEXT match cannot be activated at all, which is
 *  exactly the moment nobody has time to debug it (#101).
 *
 *  `jobId` names the job the caller has been tracking, so a poller that watched
 *  one run cannot close a different one that took the slot meanwhile. `null` =
 *  "whichever holds it", which is what an operator's explicit stop means: they
 *  are freeing the slot, not ending a particular run. */
export async function closeRunningJob(jobId: string | null = null): Promise<Job | null> {
  let closed: Job | null = null;
  await store.update((jobs) => {
    const idx = jobs.findIndex((j) => isBlocking(j.status) && (jobId === null || j.id === jobId));
    if (idx === -1) return jobs;
    const next = jobs.slice();
    next[idx] = closeJob(jobs[idx], new Date().toISOString());
    closed = next[idx];
    return next;
  });
  return closed;
}

/** Closes every job that holds the broadcast slot without being the run that is
 *  actually happening, and returns what it closed.
 *
 *  This is the cure for the state the falling edge can never reach. The edge
 *  only fires if the control app was watching when the relay went down; a job
 *  left open across a control-app restart is invisible to it forever, and on
 *  30.7.2026 exactly that job — armed the previous evening — swallowed the next
 *  morning's run (#118) and blocked the match after it (#101).
 *
 *  Evidence, not guesswork:
 *  - `runningMatchId` set = the relay demonstrably runs that match, so any OTHER
 *    blocking job is stale no matter how young it is: it cannot start, the slot
 *    is taken.
 *  - `runningMatchId` null = nothing is running. A "live" job is then over by
 *    definition. An "arming" one is only abandoned once ARMING_STALE_MS has
 *    passed — before that it is a job somebody is about to start by hand.
 *
 *  The caller owns the "is the relay really down" judgement; passing null while
 *  the relay is merely restarting would close a running broadcast's job. */
export async function reconcileOpenJobs(
  runningMatchId: number | null,
  now: number = Date.now()
): Promise<Job[]> {
  const isStale = (j: Job): boolean => {
    if (!isBlocking(j.status)) return false;
    // Ajossa oleva ottelu omistaa slotin oikeutetusti.
    if (runningMatchId !== null && j.matchId === runningMatchId) return false;
    // "live" ilman sitä ajoa: ajo on määritelmän mukaan ohi, koska tähän
    // päästään vain kun relay on alhaalla settle-ikkunan yli tai ajaa jotain
    // muuta.
    if (j.status === "live") return true;
    // "arming" saa aina armonajan, myös silloin kun relay ajaa jotain muuta.
    // Muuten seuraavaa ottelua valmisteleva työ peruuntuisi 5 s välein sinä
    // aikana kun edellinen ottelu on vielä ajossa ilman omaa työtä — ja
    // työn perumisen sijaan oikea vastaus on ristiriitavaroitus, jonka
    // sidonta jo nostaa. armedAt puuttuu ennen #118:aa kirjoitetuilta
    // töiltä; createdAt on ainoa muu aikaleima, ja sillä työllä jolta tämä
    // vika löytyi se sanoo "eilen" — mikä on oikea vastaus.
    const armed = Date.parse(j.armedAt ?? j.createdAt);
    return !Number.isFinite(armed) || now - armed >= ARMING_STALE_MS;
  };

  // Read first so the common case (nothing to do, every tick) writes nothing.
  // The reducer re-checks, so a job that changes in between is still judged on
  // its current state.
  const current = await store.read();
  if (!current.some(isStale)) return [];

  const closed: Job[] = [];
  await store.update((jobs) => {
    const at = new Date(now).toISOString();
    closed.length = 0;
    let changed = false;
    const next = jobs.map((j) => {
      if (!isStale(j)) return j;
      changed = true;
      const done = closeJob(j, at);
      closed.push(done);
      return done;
    });
    return changed ? next : jobs;
  });
  return closed;
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
