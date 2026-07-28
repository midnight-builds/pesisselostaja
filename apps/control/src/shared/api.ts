/** HTTP contract. The server implements these paths; the client calls them.
 *  Every route is JSON in / JSON out except the SSE stream and static assets.
 *
 *  GET  /api/live                 -> LiveState                (one-shot snapshot)
 *  GET  /api/live/stream          -> text/event-stream        (LiveState pushes, event: "live")
 *  GET  /api/matches?date=YYYY-MM-DD        -> DayMatches
 *  GET  /api/matches/:id                    -> MatchOption
 *  POST /api/jobs                 {CreateJobRequest}  -> Job
 *  GET  /api/jobs                 -> Job[]
 *  PATCH /api/jobs/:id            {Partial<Job>}      -> Job
 *  POST /api/jobs/:id/activate    -> Job              (writes .env.relay for this job)
 *  POST /api/preflight            -> PreflightResult
 *  POST /api/relay/start|stop|restart  -> RelayProcess
 *  POST /api/knobs                {Partial<ControlKnobs>} -> ControlKnobs
 *  POST /api/knobs/delay-nudge    {deltaMs: number}   -> ControlKnobs
 *  GET  /api/log?limit=&level=    -> LogLine[]
 *  GET  /api/push/key             -> {publicKey}      (VAPID, generated on first boot)
 *  POST /api/push/subscribe       {PushSubscription}  -> 204
 *  POST /api/push/test            -> PushSendResult   (409 jos ei tilauksia)
 *  GET  /api/push/prefs           -> NotificationPrefs
 *  POST /api/push/prefs           {Partial<NotificationPrefs>} -> NotificationPrefs
 */

import type { ControlKnobs, Job } from "./types.js";

export interface CreateJobRequest {
  matchId: number;
  sourceUrl?: string;
  targetStreamKey?: string;
  targetRtmpUrl?: string;
  targetVideoId?: string;
  startsAt?: string;
  note?: string;
}

export interface ApiError {
  error: string;
  detail?: string;
}

export type PatchJobRequest = Partial<
  Pick<
    Job,
    "sourceUrl" | "targetStreamKey" | "targetRtmpUrl" | "targetVideoId" | "note" | "status" | "startsAt"
  >
>;

export type PatchKnobsRequest = Partial<ControlKnobs>;

/** The RTMP ingest that has worked for every broadcast so far; the UI offers
 *  it as the default so the operator only ever pastes a stream key. */
export const DEFAULT_RTMP_URL = "rtmp://a.rtmp.youtube.com/live2";
