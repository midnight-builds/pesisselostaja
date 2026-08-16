import { execFile } from "node:child_process";
import { logWarn } from "./log.js";

/** yt-dlp has required a JavaScript runtime for YouTube extraction since the
 *  2026.07 releases, and Deno — its only enabled-by-default runtime — is not
 *  installed on the relay host. Without a runtime the extraction still
 *  *succeeds*, but the m3u8 renditions are missing from the format list, so
 *  `best[protocol^=m3u8]/best` falls through to `best` and hands ffmpeg a
 *  progressive 360p mp4. Nothing in the log says so: the broadcast just looks
 *  bad (found while preparing a scheduled source, 27.7.2026).
 *
 *  Point yt-dlp at the very Node binary running this process — it is
 *  guaranteed to exist, unlike whatever `node` resolves to on $PATH under
 *  systemd. */
const JS_RUNTIME_ARGS = ["--js-runtimes", `node:${process.execPath}`];

/** yt-dlp extractor arguments, i.e. which YouTube player client the extraction
 *  pretends to be.
 *
 *  `youtube:player_client=android` is not a preference, it is the workaround
 *  that got a live broadcast back on 16.8.2026 (issue #249): a mid-match relay
 *  restart forced a re-resolve, YouTube answered the web client with HTTP 429 +
 *  "Sign in to confirm you're not a bot", and viewers saw the slate for ~4 min.
 *  The android client went through from the same IP.
 *
 *  It lives here, in version control, rather than in the host's
 *  `~/.config/yt-dlp/config` where it was first added — a file that is neither
 *  in the repo nor in the deploy, so nothing said the relay's behaviour
 *  depended on it. If the android client ever starts misbehaving (a changed
 *  format list is the symptom to expect), this is the first suspect. */
export const DEFAULT_YTDLP_EXTRACTOR_ARGS = "youtube:player_client=android";

/** Turns the configured extractor-args string into argv. Whitespace separates
 *  several specs (`;` and `,` are part of yt-dlp's own syntax and must survive
 *  untouched).
 *
 *  An empty value means the RELAY passes no extractor args — NOT that yt-dlp
 *  runs with its own defaults. yt-dlp reads its config files (`~/.config/yt-dlp/
 *  config`) before the command line, and this host still carries the original
 *  16.8.2026 workaround line there. A value set here wins over the host's for
 *  the same extractor key; an empty one leaves the host's in force. Getting
 *  back to a bare yt-dlp means editing that file too. */
export function ytdlpExtractorArgs(
  raw: string | undefined = process.env.RELAY_YTDLP_EXTRACTOR_ARGS
): string[] {
  const value = (raw ?? DEFAULT_YTDLP_EXTRACTOR_ARGS).trim();
  if (!value) return [];
  return value.split(/\s+/).flatMap((spec) => ["--extractor-args", spec]);
}

/** The flags that decide WHAT yt-dlp extracts and HOW it talks to YouTube —
 *  shared verbatim by the relay's resolve and by preflight's source check.
 *
 *  One constant on purpose: the two argument lists were copies, so preflight
 *  could report a healthy source while the relay's own resolve used different
 *  flags (or vice versa). A preflight that does not ask the same question it
 *  is trusted to answer is worse than no preflight. */
export function ytdlpSourceArgs(extractorArgs?: string): string[] {
  return [
    "-f",
    "best[protocol^=m3u8]/best",
    "--no-playlist",
    ...JS_RUNTIME_ARGS,
    ...ytdlpExtractorArgs(extractorArgs),
  ];
}

/** An HLS pick resolves to a manifest host; a progressive fallback resolves to
 *  `…/videoplayback?…&itag=18`. Used only to warn — a 360p push still beats no
 *  push at all, so this never fails the resolve (uptime first). */
export function isHlsManifestUrl(url: string): boolean {
  return url.includes("/api/manifest/hls_") || url.includes(".m3u8");
}

/** The source exists and is healthy — it simply hasn't started yet, because
 *  the broadcaster scheduled it for later. Distinct from every other resolve
 *  failure: a dead source should burn the give-up window, a scheduled one
 *  should not (see ffmpegMixer.start). */
export class SourceNotLiveYetError extends Error {
  constructor(
    message: string,
    /** How long until the announced start, or null if yt-dlp said a start is
     *  scheduled but the wording didn't carry a parseable amount. */
    readonly startsInMs: number | null
  ) {
    super(message);
    this.name = "SourceNotLiveYetError";
  }
}

/** Thrown when yt-dlp says the broadcast is over — not that it failed to
 *  reach it. The distinction decides whether the relay retries or finishes:
 *  a source that ended will not come back, and retrying it republishes the
 *  same tail over and over (issue #103).
 *
 *  Deliberately a sibling of SourceNotLiveYetError rather than a subclass of
 *  Error alone: "not yet" and "not any more" are the two ends of the same
 *  broadcast, and both are ordinary states rather than faults. */
export class SourceEndedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceEndedError";
  }
}

/** YouTube refused to answer *us*, and said nothing about the broadcast: HTTP
 *  429, or the bot check that fronts it. The distinction matters twice.
 *
 *  For the relay: this is not an ordinary outage, so the ordinary backoff (a
 *  retry every 30 s at the cap) is exactly wrong — hammering is what keeps the
 *  block alive. See nextBackoffMs in ffmpegMixer.
 *
 *  For the operator: `source.state: failed` under this cause means "the relay
 *  cannot reach the raakalähetys", NOT "the raakalähetys is broken". On
 *  16.8.2026 the ohjaamo said the latter while the phone was pushing perfectly,
 *  which points the operator at the one end of the chain nobody can reach
 *  mid-match (issue #249). */
export class SourceThrottledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceThrottledError";
  }
}

/** yt-dlp's wording when YouTube throttles or bot-checks the request itself.
 *  Both observed on 16.8.2026; the 429 arrived with the bot-check text. */
const THROTTLED_PATTERNS = [
  // `you.{0,4}re` on purpose: yt-dlp quotes YouTube's own wording, which uses a
  // typographic apostrophe ("you’re") — matching only the ASCII one would have
  // missed the exact line this whole change exists for.
  /Sign in to confirm you.{0,4}re not a bot/i,
  /HTTP Error 429/i,
  /\b429\b.*Too Many Requests|Too Many Requests.*\b429\b/i,
] as const;

export function parseSourceThrottled(stderr: string): boolean {
  return THROTTLED_PATTERNS.some((pattern) => pattern.test(stderr));
}

/** yt-dlp's wording when the live is over and it cannot even list formats.
 *
 *  Secondary evidence only: `live_status` below is the real answer and comes
 *  back on every successful extraction. These strings are what is left for the
 *  case where yt-dlp fails before it can report a status at all. */
const ENDED_PATTERNS = [
  /Requested format is not available/i,
  /This live stream recording is not available/i,
  /This live event has ended/i,
] as const;

export function parseSourceEnded(stderr: string): boolean {
  return ENDED_PATTERNS.some((pattern) => pattern.test(stderr));
}

const UNIT_MS: Record<string, number> = {
  second: 1000,
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
};

/** Reads yt-dlp's "This live event will begin in 103 minutes." out of stderr.
 *  Returns `{ startsInMs }` when the source is merely scheduled (startsInMs is
 *  null if the amount didn't parse), or null when this is a real failure.
 *  yt-dlp reports this on stderr with a nonzero exit, so without looking at
 *  the text it is indistinguishable from "the broadcast is gone". */
export function parseScheduledStart(stderr: string): { startsInMs: number | null } | null {
  if (!/live event will begin|premieres in|live event will begin in/i.test(stderr)) return null;
  const m = /will begin in (\d+) (second|minute|hour|day)s?/i.exec(stderr);
  if (!m) return { startsInMs: null };
  return { startsInMs: Number(m[1]) * UNIT_MS[m[2].toLowerCase()] };
}

/** Resolves the direct HLS/googlevideo playback URL for an already-published
 *  YouTube live broadcast. Forcing an m3u8 format keeps video+audio in one
 *  rendition, so ffmpeg only needs a single `-i`. The resolved URL can expire
 *  or rotate mid-match; callers must re-resolve rather than assume it's
 *  valid forever (see ffmpegMixer's restart/backoff loop).
 *
 *  Rejects with SourceNotLiveYetError when the broadcast is scheduled but not
 *  live yet — that is a wait, not a failure. */
/** What YouTube says about the broadcast itself, straight from yt-dlp's
 *  `live_status`. Verified against real sources 29.7.2026: an active live
 *  answers `is_live`, and the morning match's finished source answers
 *  `post_live`.
 *
 *  This is the difference between "the source is in trouble" and "the
 *  broadcast is over" — and it is an ANSWER, not an inference. A finished live
 *  keeps serving its last DVR window for a while, so without asking, the two
 *  look identical from outside: yt-dlp resolves, ffmpeg reads a clean 34
 *  seconds, and the loop republishes the end of the match over and over
 *  (issue #103). */
export type LiveStatus =
  | "is_live"
  /** Ingest has stopped; the DVR tail is still being served. THE tail case. */
  | "post_live"
  /** The recording is finished and processed. */
  | "was_live"
  | "not_live"
  | "is_upcoming"
  /** yt-dlp did not say — an older build, or an extraction that got this far
   *  without the field. "No information", never "ended". */
  | "unknown";

const LIVE_STATUSES: readonly string[] = [
  "is_live",
  "post_live",
  "was_live",
  "not_live",
  "is_upcoming",
];

/** True for the statuses that mean no new video is coming. `unknown` is
 *  deliberately absent: not knowing must never end a broadcast. */
export function isEndedStatus(status: LiveStatus): boolean {
  return status === "post_live" || status === "was_live" || status === "not_live";
}

export interface ResolvedSource {
  url: string;
  liveStatus: LiveStatus;
}

/** yt-dlp prints `--print` fields before `-g`'s URLs, so the status arrives on
 *  its own line ahead of the manifest. Parsed by recognising the values rather
 *  than by line position, so an extra warning line cannot shift it. */
export function parseResolveOutput(stdout: string): { url: string | null; liveStatus: LiveStatus } {
  let url: string | null = null;
  let liveStatus: LiveStatus = "unknown";
  for (const line of stdout.split("\n")) {
    const value = line.trim();
    if (!value) continue;
    if (LIVE_STATUSES.includes(value)) {
      liveStatus = value as LiveStatus;
      continue;
    }
    if (!url && /^https?:\/\//.test(value)) url = value;
  }
  return { url, liveStatus };
}

/** Turns a failed yt-dlp run into the error the relay acts on, or null when
 *  the stderr says nothing recognisable and the raw failure should stand.
 *
 *  Pure and exported because the ORDER is the whole content of this function,
 *  and the order is a policy about broadcasts rather than about strings:
 *   1. "starts later" — waiting beats every other reading (a scheduled
 *      broadcast is healthy, and giving up on one cost us a live start once).
 *   2. "YouTube refused us" — says nothing about the broadcast, so it must not
 *      be read as its end.
 *   3. "the broadcast is over" — only once nothing above claimed the answer. */
export function classifyResolveFailure(stderr: string): Error | null {
  const lastLine = stderr.trim().split("\n").at(-1) ?? "";
  const scheduled = parseScheduledStart(stderr);
  if (scheduled) return new SourceNotLiveYetError(lastLine, scheduled.startsInMs);
  if (parseSourceThrottled(stderr)) return new SourceThrottledError(lastLine);
  if (parseSourceEnded(stderr)) return new SourceEndedError(lastLine);
  return null;
}

export function resolveSourceUrl(
  youtubeUrl: string,
  opts: { extractorArgs?: string } = {}
): Promise<ResolvedSource> {
  return new Promise((resolve, reject) => {
    execFile(
      "yt-dlp",
      [
        "-g",
        // Asked for in the SAME call as the URL: a second invocation would
        // cost another extraction and could answer about a different instant.
        "--print",
        "%(live_status)s",
        ...ytdlpSourceArgs(opts.extractorArgs),
        youtubeUrl,
      ],
      { maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(classifyResolveFailure(String(stderr ?? "")) ?? err);
          return;
        }
        const { url, liveStatus } = parseResolveOutput(stdout);
        // Status first, URL second: a finished live still hands out a playable
        // URL for its DVR tail, and playing that IS the bug. Nothing
        // downstream ever sees the URL of a broadcast that is over.
        if (isEndedStatus(liveStatus)) {
          reject(new SourceEndedError(`yt-dlp: live_status=${liveStatus}`));
          return;
        }
        if (!url) {
          reject(new Error("yt-dlp returned no URL"));
          return;
        }
        if (!isHlsManifestUrl(url)) {
          logWarn(
            "source.progressive_fallback",
            "HUOM: yt-dlp ei palauttanut HLS-manifestia — lähetys menee todennäköisesti " +
              "heikkolaatuisena (progressiivinen varamuoto). Tarkista että yt-dlp on ajan " +
              "tasalla ja että sen JS-runtime toimii."
          );
        }
        resolve({ url, liveStatus });
      }
    );
  });
}
