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

/** yt-dlp's wording when the live is over. Captured verbatim.
 *
 *  "Requested format is not available" is what a finished YouTube live answers
 *  while its recording is still being processed: the video exists, the m3u8
 *  rendition we ask for does not. It is the same message a genuinely bad
 *  format selector would produce — but we always ask for the same selector,
 *  and it resolved fine seconds earlier, so in this process the only way to
 *  reach it is that the stream ended. */
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
export function resolveSourceUrl(youtubeUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "yt-dlp",
      ["-g", "-f", "best[protocol^=m3u8]/best", "--no-playlist", ...JS_RUNTIME_ARGS, youtubeUrl],
      { maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const text = String(stderr ?? "");
          const lastLine = text.trim().split("\n").at(-1) ?? "";
          const scheduled = parseScheduledStart(text);
          if (scheduled) {
            reject(new SourceNotLiveYetError(lastLine, scheduled.startsInMs));
            return;
          }
          // Checked after "not live yet": a scheduled broadcast can also
          // mention formats, and waiting must win over finishing.
          if (parseSourceEnded(text)) {
            reject(new SourceEndedError(lastLine));
            return;
          }
          reject(err);
          return;
        }
        const url = stdout.trim().split("\n")[0];
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
        resolve(url);
      }
    );
  });
}
