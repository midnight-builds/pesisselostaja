/** The scheduler: the one part of the control app that acts on its own.
 *
 *  DESIGN.md "Ajastus ja käynnistys" fixes what it may do, and every rule below
 *  is a safety property rather than a convenience:
 *
 *    1. **OFF by default.** The persisted state starts at `{ enabled: false }`
 *       and only a POST from the UI flips it. A hand-run broadcast must never be
 *       ambushed by automation that woke up on its own after a service restart.
 *       When it is off it still computes the whole decision and stores it in
 *       `wouldHaveDone` — the operator gets to watch the logic be right for a
 *       match or two before trusting it with the relay.
 *    2. **The trigger is the source going live, never a clock.** A pesäpallo
 *       match starts when the phone starts pushing, not when the fixture list
 *       says it does. So we poll the job's own sourceUrl with the relay's own
 *       source resolver and start on the transition.
 *    3. **One broadcast at a time, and a running one is NEVER cut** (uptime
 *       first). If a queued job's source goes live while another is on air, we
 *       notify and do nothing else.
 *    4. **Preflight is a gate.** Blockers > 0 means no start, notify instead.
 *    5. **Disk critical means nothing starts at all** (global operating rule).
 *
 *  Structure follows from rule 1: `plan()` is a pure-ish read-only computation
 *  (it reads jobs, vitals and yt-dlp, and mutates nothing), and `execute()` is
 *  the only function in this file that writes anything. `execute` is called from
 *  exactly one place, inside `if (enabled)`. That is what makes "off can't start
 *  anything" auditable rather than merely intended. */

import { checkSource, type Check } from "../../../broadcast/src/preflight.js";
import type {
  Job,
  PreflightResult,
  SchedulerAction,
  SchedulerDecision,
  SchedulerNextJob,
  SchedulerState,
  SystemState,
} from "../shared/types.js";
import { activateJob, listJobs, markRunStarted, setJobStatus } from "./jobs.js";
import { notifySchedulerAction } from "./notifications.js";
import { runControlPreflight } from "./preflight.js";
import { startRelay, writeRelayEnv } from "./relay.js";
import { createStore } from "./store.js";
import { getSystemState } from "./system.js";

// ------------------------------------------------------------------ cadence
//
// One tick can cost a full `yt-dlp -g` resolve: a network round trip to
// YouTube plus a JS-runtime run, seconds of wall clock and a request against
// someone else's service. So the loop asks itself "could anything plausibly
// have happened by now?" before it pays that cost, and the answer is driven by
// the one hint we have — the job's scheduled kickoff.

/** Nothing to wait for (no job in "scheduled" with a source URL). This path
 *  never calls yt-dlp at all; the cost is one JSON file read, and the 5 minutes
 *  are only the delay before the scheduler notices a job the operator just
 *  created on the phone. */
const IDLE_POLL_MS = 5 * 60_000;

/** A job exists but its kickoff is still far away. Twelve yt-dlp calls an hour
 *  is polite towards YouTube and still catches an operator who starts pushing
 *  half an hour early — the relay would just sit through the pre-roll, which is
 *  exactly what it does when started by hand. */
const SLOW_POLL_MS = 5 * 60_000;

/** Kickoff is imminent (or already passed): this is the window in which the
 *  source actually flips. 30 s bounds how late the broadcast can start, and the
 *  real figure is 30 s + preflight (~10 s) + relay startup. Faster buys little:
 *  yt-dlp itself takes seconds, and the first thing the relay does on a source
 *  that just went live is wait out its own narration delay anyway. */
const FAST_POLL_MS = 30_000;

/** "Imminent" = 15 min before kickoff. Streamlabs is typically started a few
 *  minutes before the first pitch; a quarter of an hour covers the eager
 *  operator without polling all afternoon. */
const NEAR_WINDOW_MS = 15 * 60_000;

/** A "scheduled" job still sitting there two hours after kickoff has been
 *  abandoned (the operator moved on and never cancelled it). Drop back to the
 *  slow cadence rather than hammering yt-dlp about it until the box reboots. */
const STALE_AFTER_START_MS = 2 * 60 * 60_000;

/** After a refused start (preflight blockers, or a start that threw), wait this
 *  long before trying the whole expensive chain again. Without it, a job whose
 *  source is live but whose stream key is missing would run a preflight every
 *  30 seconds for the rest of the afternoon. */
const RETRY_AFTER_BLOCK_MS = 5 * 60_000;

/** Purely a function of "how close is kickoff" — exported so the cadence can be
 *  tested without a clock, a job store or a network. */
export function pollIntervalMs(input: {
  now: number;
  hasCandidate: boolean;
  /** Candidate job's scheduled kickoff, ISO or null. */
  startsAt: string | null;
  /** yt-dlp's own "starts in N min" from the last check, if it gave one. It
   *  beats startsAt when present: it comes from YouTube's own schedule for the
   *  very broadcast we are waiting for. */
  sourceStartsInMs?: number | null;
}): number {
  if (!input.hasCandidate) return IDLE_POLL_MS;

  const eta = input.sourceStartsInMs;
  if (eta !== null && eta !== undefined) {
    return eta <= NEAR_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS;
  }

  const startsAt = input.startsAt ? Date.parse(input.startsAt) : NaN;
  // No kickoff time on the job and no ETA from YouTube: we have no reason to
  // believe anything is imminent, so stay slow instead of guessing.
  if (!Number.isFinite(startsAt)) return SLOW_POLL_MS;

  const untilStart = startsAt - input.now;
  if (untilStart > NEAR_WINDOW_MS) return SLOW_POLL_MS;
  if (untilStart < -STALE_AFTER_START_MS) return SLOW_POLL_MS;
  return FAST_POLL_MS;
}

// ------------------------------------------------------------ source liveness

export type SourceLiveness =
  | { state: "live"; quality: "full" | "degraded"; detail: string }
  | { state: "scheduled"; startsInMs: number | null; detail: string }
  | { state: "error"; detail: string };

/** Reads the relay's own `checkSource` verdict.
 *
 *  We deliberately do NOT run yt-dlp ourselves: checkSource already resolves the
 *  source with the exact flags and format selector the relay uses (including the
 *  node JS runtime, without which YouTube hands back a 360p mp4), and a second
 *  implementation would be a second opinion — the phone would show "live" while
 *  the relay refused to start, or vice versa.
 *
 *  The price of reusing it is that its verdict arrives as a Finnish sentence,
 *  so this function matches on that wording. The coupling is real and is kept
 *  to this one place; if checkSource's wording changes, the tests below fail
 *  loudly instead of the scheduler silently deciding "not live" forever. */
export function classifySource(check: Check): SourceLiveness {
  const detail = check.detail;

  // FIRST: "ei vielä livenä" contains the substring "livenä", and it is also
  // reported with status "ok" (waiting for a scheduled start is healthy). Test
  // it before anything else or every pre-match check reads as "live".
  if (/ei vielä livenä/i.test(detail)) {
    const eta = /~\s*(\d+)\s*min/.exec(detail);
    return {
      state: "scheduled",
      startsInMs: eta ? Number(eta[1]) * 60_000 : null,
      detail,
    };
  }
  if (check.status === "fail") return { state: "error", detail };
  if (/livenä/i.test(detail)) {
    // "livenä, mutta EI HLS-manifestia" — the stream is up, it would just go out
    // in poor quality. Not a reason to refuse the start: a degraded broadcast
    // beats no broadcast, and preflight's own warning tells the operator.
    return { state: "live", quality: /EI HLS/i.test(detail) ? "degraded" : "full", detail };
  }
  return { state: "error", detail };
}

// -------------------------------------------------------------- job selection

function startKey(job: Job): number {
  const t = job.startsAt ? Date.parse(job.startsAt) : NaN;
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}

/** The one job the scheduler watches: earliest kickoff among jobs that are
 *  "scheduled" AND have a source to poll.
 *
 *  "draft" is excluded on purpose — a draft is a job the operator has not
 *  finished filling in, and starting a broadcast off a half-entered form is the
 *  exact surprise this whole module is written to avoid. */
export function pickCandidate(jobs: Job[]): Job | null {
  const ready = jobs.filter((j) => j.status === "scheduled" && j.sourceUrl);
  if (ready.length === 0) return null;
  return ready.reduce((best, j) => {
    const d = startKey(j) - startKey(best);
    // createdAt breaks the tie, so two jobs without kickoff times still order
    // deterministically instead of by array position.
    if (d !== 0) return d < 0 ? j : best;
    return j.createdAt < best.createdAt ? j : best;
  });
}

function blockingJob(jobs: Job[]): Job | null {
  return jobs.find((j) => j.status === "arming" || j.status === "live") ?? null;
}

// -------------------------------------------------------------- dependencies

/** Every side effect and every outside read, in one injectable bag.
 *
 *  Tests hand in fakes so no test run can reach yt-dlp, systemctl, `.env.relay`
 *  or a push service — the module under test is the decision logic, and the
 *  things it drives are precisely the things that must not be driven from a
 *  test suite. */
export interface SchedulerDeps {
  now(): number;
  listJobs(): Promise<Job[]>;
  getSystemState(): Promise<SystemState>;
  checkSource(url: string): Promise<Check>;
  writeRelayEnv(job: Job): Promise<void>;
  /** Job mukana, jotta preflight voi tarkistaa myös työn sidonnan (#155).
   *  Ajastimen polulla `writeRelayEnv` on juuri ajettu, joten tarkistus on
   *  tässä varmistus siitä että kirjoitus meni perille — ohjaamon napin
   *  polulla se on itse suoja. */
  runPreflight(job: Job): Promise<PreflightResult>;
  activateJob(id: string): Promise<Job>;
  setJobStatus(id: string, status: Job["status"]): Promise<Job>;
  /** Sama funktio jota poller käyttää — ei omaa `setJobStatus(…, "live")`
   *  -oikopolkua, joka jätti `startedAt`in tyhjäksi (#118). */
  markRunStarted(matchId: number): Promise<Job | null>;
  startRelay(): Promise<unknown>;
  notify(tag: string, title: string, body: string): Promise<unknown>;
}

function defaultDeps(): SchedulerDeps {
  return {
    now: () => Date.now(),
    listJobs,
    getSystemState,
    checkSource,
    writeRelayEnv,
    runPreflight: runControlPreflight,
    activateJob,
    setJobStatus,
    markRunStarted,
    startRelay,
    notify: notifySchedulerAction,
  };
}

// ------------------------------------------------------------------ the plan

/** What the tick decided to do, before anything was done. `decision: "start"`
 *  means "source is live, slot is free, disk is fine — proceed to preflight and
 *  start"; preflight itself runs in execute(), because it only means anything
 *  after `.env.relay` has been pointed at this job, and pointing it is a write. */
interface Plan {
  decision: SchedulerDecision;
  reason: string;
  job: Job | null;
  blocking: Job | null;
  liveness: SourceLiveness | null;
}

function label(job: Job): string {
  return `${job.home} – ${job.away}`;
}

export function createScheduler(overrides: Partial<SchedulerDeps> = {}) {
  const deps: SchedulerDeps = { ...defaultDeps(), ...overrides };
  // `{ enabled: false }` is both the initial value and the fallback for a
  // missing or corrupt file (see store.ts): every failure mode of the storage
  // layer lands on "off", never on "on".
  const store = createStore<{ enabled: boolean }>("scheduler.json", { enabled: false });

  let lastCheckAt: string | null = null;
  let lastAction: SchedulerAction | null = null;
  let wouldHaveDone: SchedulerAction | null = null;
  let nextJob: SchedulerNextJob | null = null;
  let nextCheckInMs = IDLE_POLL_MS;
  /** Wall clock before which the expensive start chain is not retried. */
  let retryAfter = 0;
  /** Last ETA yt-dlp gave us, used to tighten the cadence. */
  let sourceStartsInMs: number | null = null;

  async function isEnabled(): Promise<boolean> {
    const persisted = await store.read();
    // Strict `=== true`: a hand-edited file with "enabled": "false" (a string,
    // which is truthy) must not arm the scheduler.
    return persisted.enabled === true;
  }

  /** Read-only. Reads the job store, the machine vitals and — only when there is
   *  actually something to wait for — the source. Writes nothing, ever, so it is
   *  safe to run on every tick regardless of `enabled`. */
  async function plan(): Promise<Plan> {
    const jobs = await deps.listJobs();
    const candidate = pickCandidate(jobs);
    const blocking = blockingJob(jobs);

    if (!candidate) {
      sourceStartsInMs = null;
      return {
        decision: "idle",
        reason: blocking
          ? `Ei jonossa olevia töitä — ${label(blocking)} on ajossa.`
          : "Ei jonossa olevia töitä.",
        job: null,
        blocking,
        liveness: null,
      };
    }

    const now = deps.now();
    if (now < retryAfter) {
      const waitMin = Math.ceil((retryAfter - now) / 60_000);
      return {
        decision: "waiting",
        reason: `Edellinen käynnistysyritys ei mennyt läpi — uusi yritys ~${waitMin} min kuluttua.`,
        job: candidate,
        blocking,
        liveness: null,
      };
    }

    // Disk before the source check: it is the global stop rule, it is cheap, and
    // there is no point resolving a stream we would refuse to record anyway.
    const system = await deps.getSystemState();
    if (system.diskCritical) {
      return {
        decision: "blocked-disk",
        reason: `Levytila lopussa (${(system.diskFreeBytes / 1024 ** 3).toFixed(1)} Gt) — mitään ei käynnistetä.`,
        job: candidate,
        blocking,
        liveness: null,
      };
    }

    const liveness = classifySource(await deps.checkSource(candidate.sourceUrl as string));
    sourceStartsInMs = liveness.state === "scheduled" ? liveness.startsInMs : null;

    if (liveness.state === "scheduled") {
      const eta =
        liveness.startsInMs === null ? "" : ` (~${Math.round(liveness.startsInMs / 60_000)} min)`;
      return {
        decision: "waiting",
        reason: `${label(candidate)}: lähde ei ole vielä livenä${eta}.`,
        job: candidate,
        blocking,
        liveness,
      };
    }
    if (liveness.state === "error") {
      // Usually "video unavailable" for a broadcast that has not been created
      // yet — an ordinary pre-match state, not an alarm. Recorded, not pushed.
      return {
        decision: "source-error",
        reason: `${label(candidate)}: lähdettä ei saatu selvitettyä — ${liveness.detail}`,
        job: candidate,
        blocking,
        liveness,
      };
    }

    // Source is live from here on.
    if (blocking) {
      return {
        decision: "blocked-busy",
        reason:
          `${label(candidate)} meni liveen, mutta ${label(blocking)} on jo ajossa — ` +
          "ajossa olevaa ei katkaista automaattisesti.",
        job: candidate,
        blocking,
        liveness,
      };
    }

    const quality = liveness.quality === "degraded" ? " (heikkolaatuisena)" : "";
    return {
      decision: "start",
      reason: `${label(candidate)}: lähde on livenä${quality} — preflight ja käynnistys.`,
      job: candidate,
      blocking: null,
      liveness,
    };
  }

  /** The ONLY function in this file that writes anything: `.env.relay`, the job
   *  status, systemd and the push service. Called from exactly one place, behind
   *  the `enabled` check. */
  async function execute(p: Plan): Promise<SchedulerAction> {
    const at = new Date(deps.now()).toISOString();
    const jobId = p.job?.id ?? null;

    if (p.decision === "blocked-disk") {
      await deps.notify("disk", "Ajastin: levytila lopussa", p.reason);
      return { at, decision: p.decision, jobId, reason: p.reason, applied: false };
    }
    if (p.decision === "blocked-busy") {
      await deps.notify(
        `busy:${jobId ?? "-"}`,
        "Ajastin: lähetys jonossa",
        `${p.reason} Lopeta ajossa oleva käsin, jos haluat vaihtaa.`
      );
      return { at, decision: p.decision, jobId, reason: p.reason, applied: false };
    }
    if (p.decision !== "start" || !p.job) {
      // idle / waiting / source-error: nothing to do and nothing worth a push.
      return { at, decision: p.decision, jobId, reason: p.reason, applied: false };
    }

    const job = p.job;
    try {
      // Preflight checks what systemd would actually run, which means it reads
      // `.env.relay` — so the file has to point at THIS job before the gate can
      // mean anything. Safe here and only here: we have already established that
      // no other job holds the slot.
      await deps.writeRelayEnv(job);
      const preflight = await deps.runPreflight(job);
      if (preflight.blockers > 0) {
        // runControlPreflight sends its own "Preflight: N estettä" push, so this
        // one adds the piece that push cannot know: the start was refused.
        retryAfter = deps.now() + RETRY_AFTER_BLOCK_MS;
        const reason = `${label(job)}: preflightissa ${preflight.blockers} estettä — EI käynnistetty.`;
        await deps.notify(
          `preflight:${job.id}`,
          "Ajastin: käynnistys estyi",
          `${reason} ${preflight.summary}`
        );
        return { at, decision: "blocked-preflight", jobId, reason, applied: false };
      }

      // activateJob re-checks the single-active-job invariant inside the job
      // store's own serialized update — belt and braces against a manual start
      // that landed between plan() and here.
      await deps.activateJob(job.id);
      await deps.startRelay();
      // markRunStarted, ei setJobStatus: pelkkä tilan kääntäminen jätti
      // `startedAt`in tyhjäksi, jolloin pollerin oma sidonta ei enää löytänyt
      // armattua työtä eikä työ saanut aloitushetkeä lainkaan — ja ajon
      // päätyttyä se kirjautui `cancelled`ksi vaikka lähetys oli oikeasti
      // ajettu (#118). Ottelu on tässä varma: sen `.env.relay` juuri
      // kirjoitettiin ja sillä ottelulla relay käynnistettiin.
      const started = await deps.markRunStarted(job.matchId);
      if (!started) {
        // Ei kaadeta ajoa tähän: relay on jo käynnissä, ja pollerin sidonta
        // yrittää uudelleen relayn oman status-tiedoston perusteella.
        console.warn(
          `[scheduler] työtä ${job.id} (ottelu ${job.matchId}) ei saatu leimattua käyntiin — poller yrittää uudelleen`
        );
      }
      await deps.notify(
        `started:${job.id}`,
        "Ajastin käynnisti lähetyksen",
        `${p.reason} Preflight puhdas.`
      );
      return { at, decision: "start", jobId, reason: p.reason, applied: true };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      retryAfter = deps.now() + RETRY_AFTER_BLOCK_MS;
      // Back to "scheduled" rather than "failed": a systemd hiccup or a slow
      // preflight should be retried, and leaving the job in "arming" would hold
      // the queue's only slot with nothing running in it.
      try {
        await deps.setJobStatus(job.id, "scheduled");
      } catch {
        // The job store is the thing that just failed; do not lose the original
        // error behind a second one.
      }
      const reason = `${label(job)}: käynnistys kaatui — ${detail}`;
      await deps.notify(`failed:${job.id}`, "Ajastin: käynnistys kaatui", reason).catch(() => undefined);
      return { at, decision: "start-failed", jobId, reason, applied: false };
    }
  }

  function describeJob(p: Plan): SchedulerNextJob | null {
    if (!p.job) return null;
    return {
      id: p.job.id,
      home: p.job.home,
      away: p.job.away,
      startsAt: p.job.startsAt,
      sourceUrl: p.job.sourceUrl,
      sourceState: p.liveness ? p.liveness.state : "unknown",
      sourceDetail: p.liveness?.detail ?? null,
    };
  }

  function snapshot(enabled: boolean): SchedulerState {
    return { enabled, lastCheckAt, nextJob, lastAction, wouldHaveDone, nextCheckInMs };
  }

  async function tick(): Promise<SchedulerState> {
    const enabled = await isEnabled();
    let p: Plan;
    try {
      p = await plan();
    } catch (err) {
      // A failed read (job file, vitals, yt-dlp crash) must not kill the loop:
      // record it and try again next interval.
      const detail = err instanceof Error ? err.message : String(err);
      p = {
        decision: "source-error",
        reason: `Ajastin ei saanut tilaa luettua: ${detail}`,
        job: null,
        blocking: null,
        liveness: null,
      };
    }

    lastCheckAt = new Date(deps.now()).toISOString();
    nextJob = describeJob(p);

    if (enabled) {
      lastAction = await execute(p);
    } else {
      // The dry run stops here on purpose. Everything execute() would do next —
      // writing .env.relay, running preflight, touching systemd — is a write, and
      // a disabled scheduler performs no writes at all. So what we record is the
      // decision, not its consequences.
      wouldHaveDone = {
        at: new Date(deps.now()).toISOString(),
        decision: p.decision,
        jobId: p.job?.id ?? null,
        reason:
          p.decision === "start"
            ? `${p.reason} (Ajastin on pois päältä — mitään ei tehty.)`
            : p.reason,
        applied: false,
      };
    }

    nextCheckInMs = pollIntervalMs({
      now: deps.now(),
      hasCandidate: p.job !== null,
      startsAt: p.job?.startsAt ?? null,
      sourceStartsInMs,
    });

    return snapshot(enabled);
  }

  return {
    tick,

    async getState(): Promise<SchedulerState> {
      return snapshot(await isEnabled());
    },

    async setEnabled(enabled: boolean): Promise<SchedulerState> {
      await store.update(() => ({ enabled }));
      if (!enabled) {
        // Turning it off never stops anything that is already running (uptime
        // first) — it only stops the scheduler from acting again. Clearing the
        // last action keeps the UI from showing a stale "käynnisti lähetyksen"
        // next to a switch that is now off.
        lastAction = null;
      } else {
        wouldHaveDone = null;
      }
      return snapshot(enabled);
    },

    /** Self-rescheduling loop: the interval changes between ticks, so this is a
     *  chain of setTimeouts rather than a setInterval. `unref` is deliberately
     *  not used — the control server is a long-lived service and the timer
     *  should be visible in a heap dump. */
    start(): { stop(): void } {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const loop = async (): Promise<void> => {
        if (stopped) return;
        try {
          await tick();
        } catch (err) {
          console.error("[control] ajastin kaatui:", err);
        }
        if (stopped) return;
        timer = setTimeout(() => void loop(), nextCheckInMs);
      };

      // First look right away: a control-server restart in the ten minutes
      // before kickoff should not cost a full poll interval of blindness.
      void loop();

      return {
        stop() {
          stopped = true;
          if (timer) clearTimeout(timer);
        },
      };
    },
  };
}

// ------------------------------------------------- module-level default instance

const scheduler = createScheduler();

export function startScheduler(): { stop(): void } {
  return scheduler.start();
}

export async function getSchedulerState(): Promise<SchedulerState> {
  return scheduler.getState();
}

export async function setSchedulerEnabled(enabled: boolean): Promise<SchedulerState> {
  return scheduler.setEnabled(enabled);
}
