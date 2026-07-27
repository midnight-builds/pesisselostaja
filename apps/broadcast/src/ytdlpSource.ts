import { execFile } from "node:child_process";
import { log } from "./log.js";

/** yt-dlp has required a JavaScript runtime for YouTube extraction since the
 *  2026.07 releases, and Deno — its only enabled-by-default runtime — is not
 *  installed on the relay host. Without a runtime the extraction still
 *  *succeeds*, but the m3u8 renditions are missing from the format list, so
 *  `best[protocol^=m3u8]/best` falls through to `best` and hands ffmpeg a
 *  progressive 360p mp4. Nothing in the log says so: the broadcast just looks
 *  bad (found while preparing match 144918, 27.7.2026).
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

/** Resolves the direct HLS/googlevideo playback URL for an already-published
 *  YouTube live broadcast. Forcing an m3u8 format keeps video+audio in one
 *  rendition, so ffmpeg only needs a single `-i`. The resolved URL can expire
 *  or rotate mid-match; callers must re-resolve rather than assume it's
 *  valid forever (see ffmpegMixer's restart/backoff loop). */
export function resolveSourceUrl(youtubeUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "yt-dlp",
      ["-g", "-f", "best[protocol^=m3u8]/best", "--no-playlist", ...JS_RUNTIME_ARGS, youtubeUrl],
      { maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        const url = stdout.trim().split("\n")[0];
        if (!url) {
          reject(new Error("yt-dlp returned no URL"));
          return;
        }
        if (!isHlsManifestUrl(url)) {
          log(
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
