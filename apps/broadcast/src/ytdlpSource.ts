import { execFile } from "node:child_process";

/** Resolves the direct HLS/googlevideo playback URL for an already-published
 *  YouTube live broadcast. Forcing an m3u8 format keeps video+audio in one
 *  rendition, so ffmpeg only needs a single `-i`. The resolved URL can expire
 *  or rotate mid-match; callers must re-resolve rather than assume it's
 *  valid forever (see ffmpegMixer's restart/backoff loop). */
export function resolveSourceUrl(youtubeUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "yt-dlp",
      ["-g", "-f", "best[protocol^=m3u8]/best", "--no-playlist", youtubeUrl],
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
        resolve(url);
      }
    );
  });
}
