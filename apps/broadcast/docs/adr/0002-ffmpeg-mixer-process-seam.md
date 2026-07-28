# FfmpegMixer gets a test-only process seam

Issue #45 (relay ei sammu itsestään kun lähde katkeaa epänormaalisti) is a bug
in the *supervisor*, not in ffmpeg: when the source device dies mid-match,
yt-dlp still resolves a valid URL, every spawn succeeds, and ffmpeg exits
cleanly (`code=0`) seconds later. The old rule "a successful spawn clears the
give-up window" then meant the window never accrued and the relay respawned
forever. Getting a regression test onto that path needs a *session* — a
process that completes the FIFO handshake, lives briefly, and exits 0 — which
`resolveTestSource` (ADR 0001) cannot produce: a bad source makes ffmpeg die
*before* the handshake, i.e. on the start-up-failure path that already worked.

We added `FfmpegMixerOptions.spawnMixerProcess` — an optional factory that
receives the exact argv the real ffmpeg would have been given and returns the
`ChildProcess` to supervise. A test passes a shell stand-in that opens the
narration FIFO for reading (completing the handshake), sleeps for a chosen
number of milliseconds, and exits 0. Everything else — FIFO handling, session
accounting, backoff, respawn, `SourceExhaustedError` — runs unmodified, so the
tests exercise the real loop rather than a re-implementation of it.

**Trade-off accepted:** a second production-forbidden option on
`FfmpegMixer`'s surface, next to `resolveTestSource`. The alternative —
extracting the give-up accounting into its own unit-testable class — was
considered and rejected for now: the accounting is only a handful of lines,
and the part that actually broke was how the loop *called* it (a successful
spawn resolving `spawnOnce`), which a class-level test would not have caught.
Spawning a real ffmpeg against a fixture was also rejected: it needs the
binary, takes seconds per session, and cannot produce a session of a
controlled length on demand.
