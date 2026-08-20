/** How far behind the scorer we are (issue #120).
 *
 *  On 30.7.2026 (match 145900) the third palo was heard 49 s after the scorer
 *  recorded it, and a listener who could see the scoreboard noticed. Working
 *  out how much of that was ours took an offline pass over the API's `created`
 *  field afterwards, because nothing measured it during the run.
 *
 *  `created` is the scorer's marking instant in unix seconds — the only
 *  wall-clock the feed carries (`timestamp` is null on this feed, #119). The
 *  gap between it and our own clock is therefore the whole delay ahead of the
 *  narration: the scorer's typing is not in it, but the API's publish delay and
 *  our polling are.
 *
 *  Two caveats that keep this honest, and neither is fixable from here:
 *
 *  - **It is a cross-clock difference.** `created` comes from someone else's
 *    server and `nowMs` from ours; a skewed clock shows up as a constant
 *    offset. Read the number as a trend, not as a stopwatch.
 *  - **`created` is optional.** Its presence in every response has never been
 *    verified (see LiveEvent), so every function here answers null rather than
 *    guessing — a missing field must read as "not measured", never as 0 s. */

import type { LiveEvent } from "./types.js";

/** The scorer's marking instant in epoch milliseconds, or null when the event
 *  carries no usable one. Values outside 2000-01-01…2100-01-01 are rejected as
 *  garbage rather than turned into an absurd lag. */
export function eventCreatedMs(event: LiveEvent): number | null {
  const created = event.created;
  if (typeof created !== "number" || !Number.isFinite(created)) return null;
  const ms = created * 1000;
  if (ms < 946_684_800_000 || ms > 4_102_444_800_000) return null;
  return ms;
}

/** Milliseconds between the scorer's marking and `nowMs`, or null when the
 *  event carries no `created`.
 *
 *  Negative results are clamped to 0: a marking cannot be in the future, so a
 *  negative value is clock skew, and reporting "-3 s behind" would read as a
 *  measurement rather than as the noise it is. */
export function eventLagMs(event: LiveEvent, nowMs: number): number | null {
  const createdMs = eventCreatedMs(event);
  if (createdMs === null) return null;
  return Math.max(0, nowMs - createdMs);
}

/** Running lag statistics over a window. Deliberately tiny and pure: the relay
 *  owns when to reset it and where to report it. */
export interface LagWindow {
  /** Most recent measured lag, or null when nothing has been measured. */
  latestMs: number | null;
  /** Largest lag in the window — the one worth chasing. A mean would hide
   *  exactly the spike this exists to catch. */
  maxMs: number | null;
  samples: number;
  /** Events seen with no `created` field. Kept so a window of "no lag data"
   *  cannot be mistaken for a window of "no lag". */
  missing: number;
}

export function emptyLagWindow(): LagWindow {
  return { latestMs: null, maxMs: null, samples: 0, missing: 0 };
}

/** Folds one event into the window, in place. Returns the measured lag so the
 *  caller can act on this single event (log it, warn on it) without repeating
 *  the computation. */
export function recordEventLag(window: LagWindow, event: LiveEvent, nowMs: number): number | null {
  const lag = eventLagMs(event, nowMs);
  if (lag === null) {
    window.missing++;
    return null;
  }
  window.latestMs = lag;
  window.maxMs = window.maxMs === null ? lag : Math.max(window.maxMs, lag);
  window.samples++;
  return lag;
}

/** Human-readable window summary for the log line. Says which of "no data" and
 *  "no delay" it means, because those were indistinguishable before (#120). */
export function formatLagWindow(window: LagWindow): string {
  if (window.samples === 0) {
    return window.missing > 0 ? `ei mitattavissa (${window.missing} ilman created-kenttää)` : "ei mitattua";
  }
  const latest = Math.round((window.latestMs ?? 0) / 1000);
  const max = Math.round((window.maxMs ?? 0) / 1000);
  const missing = window.missing > 0 ? `, ${window.missing} ilman created-kenttää` : "";
  return `viimeisin ${latest} s, suurin ${max} s (${window.samples} kpl${missing})`;
}
