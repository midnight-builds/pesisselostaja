/** Which side of the pipeline ffmpeg was complaining about when it died.
 *
 *  `null` means "the tail doesn't say" — that is a normal, common answer and
 *  must stay distinguishable from a confident verdict. Guessing here is worse
 *  than staying silent: the operator acts on this (go check the phone vs. go
 *  check the stream key), and a wrong verdict sends them to the wrong end of
 *  the chain for the rest of a live match. */
export type FfmpegFailureSide = "source" | "target" | null;

/** How much of ffmpeg's stderr to keep for post-mortem classification. ffmpeg
 *  is chatty (per-frame progress lines), so anything useful is in the last few
 *  KB; keeping more would just hold the noise before it. */
export const STDERR_TAIL_BYTES = 8192;

/** Errors that can ONLY come from the output side: connecting, handshaking or
 *  being refused by the RTMP endpoint. These are the ones worth naming — if
 *  the target rejects our push (wrong stream key, another encoder already
 *  publishing to the same key, broadcast not accepting), this is what it looks
 *  like locally, and it is otherwise indistinguishable from a dead source. */
const TARGET_PATTERNS: readonly RegExp[] = [
  /Connection to tcp:\/\/[^\s]* failed/i,
  /rtmp:\/\/[^\s]*: (Connection refused|Operation not permitted|Input\/output error|Broken pipe)/i,
  /\[rtmp[^\]]*\][^\n]*(failed|error|refused|denied)/i,
  /Error opening output file rtmp:/i,
  /Could not write header for output file/i,
  /Server error/i,
];

/** Errors that can only come from the input side — the phone's broadcast, the
 *  HLS/HTTPS pull, or yt-dlp's resolved URL going stale. */
const SOURCE_PATTERNS: readonly RegExp[] = [
  /\[https?[^\]]*\][^\n]*(HTTP error|Server returned)/i,
  /Server returned 4\d\d/i,
  /googlevideo\.com[^\n]*(error|failed|403|404)/i,
  /\[hls[^\]]*\][^\n]*(Failed|error)/i,
  /Invalid data found when processing input/i,
  /Error opening input/i,
];

/** Deliberately NOT treated as a target verdict on their own.
 *
 *  `av_interleaved_write_frame(): Broken pipe` and friends are what ffmpeg says
 *  whenever the output goes away — including when it goes away *because* the
 *  input ended and ffmpeg is tearing the whole graph down. They appear in
 *  perfectly ordinary end-of-source shutdowns, so counting them would label
 *  every dead phone a target problem. They only reinforce a verdict that a
 *  connection-level pattern already established.
 *
 *  `[flv] Failed to update header with correct duration/filesize` was a TARGET
 *  pattern until #122. It is printed by the MUXER while it closes the output,
 *  which it does on every teardown — including the ordinary one where the input
 *  ended first. Live on 30.7.2026 it was the only "error" in the tail twice
 *  (matches 145900 and 145905) and both times it sent the operator to check a
 *  stream key that was fine while the phone was the thing that had stopped. */
const WEAK_TARGET_PATTERNS: readonly RegExp[] = [
  /av_interleaved_write_frame\(\)/i,
  /Broken pipe/i,
  /Connection reset by peer/i,
  /\[flv[^\]]*\][^\n]*(Failed to|error)/i,
];

/** Best-effort read of which side failed, from ffmpeg's own stderr tail.
 *
 *  Returns `null` unless exactly one side matches: if both sides produced real
 *  errors we genuinely cannot tell which was the cause and which was the
 *  consequence, and saying so is the honest answer. */
export function classifyFfmpegFailure(stderrTail: string): FfmpegFailureSide {
  if (!stderrTail) return null;
  const target = TARGET_PATTERNS.some((re) => re.test(stderrTail));
  const source = SOURCE_PATTERNS.some((re) => re.test(stderrTail));
  if (target && !source) return "target";
  if (source && !target) return "source";
  return null;
}

/** True when the tail contains only the ambiguous write-side noise — used to
 *  soften the wording rather than to make a claim. */
export function hasWeakTargetSignal(stderrTail: string): boolean {
  return WEAK_TARGET_PATTERNS.some((re) => re.test(stderrTail));
}

/** One operator-facing sentence about where to look, or null when the tail
 *  doesn't justify pointing anywhere. Phrased as a suspicion, not a finding:
 *  it is read off ffmpeg's error text, not measured.
 *
 *  `exitCode` overrides the tail (#122). ffmpeg exiting 0 means it read its
 *  input to EOF and shut the graph down cleanly — a target that refuses or
 *  drops our push makes it exit non-zero. So on a clean exit the tail can only
 *  contain teardown noise, and naming a side from it is guessing: the two live
 *  cases on 30.7.2026 both blamed the target on a code=0 exit whose real cause
 *  was the phone. Pass `null` for a spawn error, where there is no exit code
 *  and the tail is all we have. */
export function describeFailureSide(
  side: FfmpegFailureSide,
  weakTarget: boolean,
  exitCode: number | null = null
): string | null {
  if (exitCode === 0) {
    return (
      "ffmpeg poistui koodilla 0 eli luki syötteensä loppuun — syöte loppui. " +
      "Tämä ei kerro kohteesta mitään, joten stream keytä ei ole syytä epäillä."
    );
  }
  if (side === "target") {
    return (
      "ffmpegin virheet tulivat KOHTEEN puolelta (RTMP) — tarkista stream key, " +
      "ettei toinen enkooderi työnnä samalla avaimella, ja että kohdelähetys ottaa vastaan."
    );
  }
  if (side === "source") {
    return "ffmpegin virheet tulivat LÄHTEEN puolelta — tarkista puhelimen lähetys.";
  }
  if (weakTarget) {
    return (
      "ffmpeg raportoi kirjoitusvirheen ulostuloon, mutta se tapahtuu myös silloin kun " +
      "lähde loppuu — kumpaakaan puolta ei voi tästä päätellä."
    );
  }
  return null;
}

/** Removes the stream key from anything on its way to a log.
 *
 *  ffmpeg prints the full output URL — stream key included — in its own error
 *  lines, and those are forwarded verbatim to the journal. The key is a
 *  publishing credential for the operator's channel, and log excerpts get
 *  pasted into issues and handoff notes. Empty/short keys are ignored so a
 *  dry-run placeholder can't turn every line into redaction noise. */
export function redactStreamKey(text: string, streamKey: string | undefined): string {
  if (!streamKey || streamKey.length < 8) return text;
  return text.split(streamKey).join("<stream-key>");
}

/** Fixed-size tail buffer over a stream of chunks. */
export function createStderrTail(maxBytes: number = STDERR_TAIL_BYTES) {
  let buf = "";
  return {
    push(chunk: string): void {
      buf += chunk;
      if (buf.length > maxBytes) buf = buf.slice(buf.length - maxBytes);
    },
    text(): string {
      return buf;
    },
  };
}
