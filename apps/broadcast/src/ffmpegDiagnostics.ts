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
  /\[flv[^\]]*\][^\n]*(Failed to|error)/i,
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
 *  connection-level pattern already established. */
const WEAK_TARGET_PATTERNS: readonly RegExp[] = [
  /av_interleaved_write_frame\(\)/i,
  /Broken pipe/i,
  /Connection reset by peer/i,
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
 *  it is read off ffmpeg's error text, not measured. */
export function describeFailureSide(side: FfmpegFailureSide, weakTarget: boolean): string | null {
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
