# Pesisselostaja Relay

Pulls a phone's already-published YouTube live broadcast back, mixes in
Pesisselostaja's spoken commentary (synthesized with the same Piper voice v2
uses), and republishes the result as a **second, separate** YouTube live
broadcast. The original broadcast is never touched — this only reads it.

See [DESIGN.md](DESIGN.md) for the full architecture/rationale and the
decisions behind it. This file is the day-to-day operator runbook.

## One-time setup

1. Install `yt-dlp` and `piper` on this host, and download the voice model:
   ```bash
   sudo curl -fL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
   sudo chmod +x /usr/local/bin/yt-dlp

   curl -fL https://github.com/rhasspy/piper/releases/latest/download/piper_linux_x86_64.tar.gz -o /tmp/piper.tar.gz
   sudo mkdir -p /opt/piper && sudo tar -xzf /tmp/piper.tar.gz -C /opt/piper --strip-components=1
   sudo ln -sf /opt/piper/piper /usr/local/bin/piper

   mkdir -p apps/broadcast/voices
   curl -L -o apps/broadcast/voices/fi_FI-harri-medium.onnx      https://huggingface.co/diffusionstudio/piper-voices/resolve/main/fi/fi_FI/harri/medium/fi_FI-harri-medium.onnx
   curl -L -o apps/broadcast/voices/fi_FI-harri-medium.onnx.json https://huggingface.co/diffusionstudio/piper-voices/resolve/main/fi/fi_FI/harri/medium/fi_FI-harri-medium.onnx.json
   ```
2. `cp apps/broadcast/.env.relay.example apps/broadcast/.env.relay` and confirm `piper --help`
   and `yt-dlp --version` both work.

## Per-match workflow

1. Start the phone's YouTube livestream as usual — this is the original
   broadcast, and the relay never modifies it.
2. In YouTube Studio, manually create a **second** live broadcast for the
   commentated stream. Copy its RTMP ingest URL + stream key. **Enable
   "Auto-start" (and "Auto-stop")** on this broadcast — with auto-start on,
   the broadcast transitions to live on its own the moment the relay's ffmpeg
   starts pushing, so there's no manual "Go live" click in step 6. (This maps
   to the API's `contentDetails.enableAutoStart`; it can't be toggled on once
   the broadcast has already reached the testing/live stage, so set it at
   creation time.)
3. Edit `apps/broadcast/.env.relay`:
   - `RELAY_MATCH_ID` — same pesistulokset.fi match ID the main app uses.
   - `RELAY_YOUTUBE_URL` — the original broadcast's watch URL.
   - `RELAY_RTMP_URL` / `RELAY_STREAM_KEY` — the second broadcast's ingest info.
4. `systemctl --user start pesisselostaja-relay.service`
5. Watch logs: `journalctl --user -u pesisselostaja-relay -f`
6. With Auto-start enabled (step 2), the second broadcast goes live by itself
   ~5–10 s after you see ffmpeg pushing without errors — no manual step. (If
   Auto-start was *not* enabled, fall back to clicking "Go live" in Studio
   once ffmpeg is pushing cleanly.)
7. After the match: `systemctl --user stop pesisselostaja-relay.service`. With
   Auto-stop enabled the second broadcast ends on its own when the push stops;
   otherwise end both broadcasts manually in YouTube Studio.

The service is intentionally **not enabled** at boot (`systemctl --user
enable` is never run for it) — always started by hand per match, so a stale
`.env.relay` from a finished match can't start replaying into a dead stream key.

### Toggling batter-change announcements (incl. mid-match)

By default the relay announces batter/lineup changes ("Vuorossa X"), the same
as v2's `announceBatterChanges` toggle. If those come through at bad moments
(e.g. the source feed logs substitutions out of order), turn them off — palot,
scores, period events, and the periodic situation summary (score + palot) all
keep playing.

- **At startup:** set `RELAY_ANNOUNCE_BATTER_CHANGES=false` in `.env.relay`, or
  pass `--no-batter-changes` to `relay:dev`.
- **Live, without restarting:** the loop re-reads `apps/broadcast/run/.control-<matchId>.json`
  every poll (see the poll interval below). Flip it and the change takes effect
  within one poll:
  ```bash
  echo '{"announceBatterChanges": false}' > apps/broadcast/run/.control-143280.json   # off
  echo '{"announceBatterChanges": true}'  > apps/broadcast/run/.control-143280.json   # back on
  ```
  The relay logs a line when the effective value changes. The startup log
  prints the exact control-file path for the running match. (The file is
  written from the env/CLI value at startup, so the env/CLI setting is
  authoritative on start and live edits take over after.)

### Narration delay (aligning speech with the video)

If narration lands slightly *before* the matching situation appears on the
video (the API skip-delay can make the commentary pipeline briefly faster than
the video path), add an artificial delay. It affects **only playback** — dedupe
and scoring bookkeeping still run synchronously at detection time — and never
stalls the poll loop or reorders clips.

- **At startup:** `RELAY_NARRATION_DELAY_MS=5000` in `.env.relay`, or
  `--narration-delay-ms 5000`. Default `4000` — a value **calibrated live**
  (an earlier `2000` default had to be raised by hand in every broadcast). It
  stays adjustable from the control file, so treat `4000` as the
  starting point, not a fixed truth.
- **Live, without restarting:** the same control file, `narrationDelayMs` key:
  ```bash
  echo '{"narrationDelayMs": 5000}' > apps/broadcast/run/.control-143280.json   # 5s (1s more than the default)
  echo '{"narrationDelayMs": 0}'    > apps/broadcast/run/.control-143280.json   # off
  ```
  The control-file value wins over the env/CLI seed. You can set several keys
  in one file (`{"announceBatterChanges": false, "narrationDelayMs": 5000}`);
  writing only some keys leaves the others unchanged. The right value is
  calibrated live — the video path's latency varies between broadcasts.

  Note that `>` **replaces** the whole file. The control app writes into the
  same file by merge, so a shell one-liner also drops whatever it has published
  there — currently the `sourceIngest` key (below). Nothing breaks: the control
  app republishes within one of its own polls.

### `sourceIngest` — what the control app publishes here

The relay ignores every key it does not know, and `sourceIngest` is one of
them: the control app (`apps/control`) is the only side with Google
credentials, so it polls the *source* broadcast's `lifeCycleStatus` /
`streamStatus` from the YouTube API every 30 s and writes the raw observation
into this file. Today the relay does not read it and its behaviour is
unaffected; it is groundwork for the "EI SIGNAALIA" slate (issue #104), where
the mixer switches inputs when the phone stops pushing.

When it does get read, two rules hold: only `streamStatus === "active"` means
data is flowing, and a missing key or a stale `observedAt` means *no
information* — never *the source is down*. The relay must keep behaving exactly
as it does today whenever the signal is absent, because the control app's
Google connection is allowed to fail without taking a broadcast with it.

### First-speech grace

The very first line used to play the instant the relay went live, before any
viewer had joined. `RELAY_FIRST_SPEECH_DELAY_MS` (default `20000`, `0` = off)
holds all narration until ffmpeg has been attached that long, measured from
the FIRST attach ever — not relay start (the source may go live minutes
later), and respawns after that add no new delay. Distinct from the narration
delay above, which shifts each clip's playback.

### Delta polling (after= + ETag)

The poll loop fetches events in delta mode by default: `after=` limits the
response to recent events, an ETag turns quiet polls into cheap 304s, and the
default poll interval is `3000` ms (`RELAY_POLL_INTERVAL`). Responses merge
into a local full-history mirror, so all event processing still sees the
complete history every poll; an inconsistent delta triggers an immediate full
refetch, and a full resync runs every ~60 s as insurance. Watch the log for
`Delta-haku: N uutta …` lines and fall back live if anything looks off:

**Reset answers are not failures.** `reset` is not a boolean flag but the ISO
instant the match's online data was created (`"2026-07-27T18:25:29+03:00"`), and
the server returns it — together with the *complete* history — whenever the
requested `after` is older than that instant. Since `after` is the last server
Date minus a 180 s margin, that is guaranteed for the first ~3 minutes of every
match: the response is simply used as the full snapshot it already is, one
request, and the log says so once per streak. The heartbeat's `reset N` counts
them. Before this was understood (issue #46) each such poll also fired a second,
redundant full fetch — two API requests per poll for the whole streak, which is
what made the 4 s timeout bite in two live matches on 27.7.

A reset whose instant our own `after` does **not** explain still counts toward a
breaker: **5 in a row** turn delta off for the rest of the run with one
`HUOM: delta-haku vastasi selittämättömällä reset-leimalla …` line, and later
heartbeats keep saying `delta POIS (katkaisija)`. Writing `{"deltaFetch": true}`
to the control file overrules the breaker and gives delta a fresh streak.

- **At startup:** `RELAY_DELTA_FETCH=false` reverts to plain full fetches.
- **Live, without restarting:** control file keys `deltaFetch` (boolean) and
  `pollIntervalMs` (min 2000):
  ```bash
  echo '{"deltaFetch": false}'    > apps/broadcast/run/.control-143280.json  # full fetches
  echo '{"pollIntervalMs": 5000}' > apps/broadcast/run/.control-143280.json  # slower poll
  ```

#### Every poll leaves a trace (issue #120)

`api.delta_fetch` only logs when something *changed*, so a quiet stretch used to
be invisible. In match 145900 (30.7.2026) narration fell 43 s behind and there
was no way to tell from the log whether the polls had run at all or whether the
API had answered with stale data — the 52 s window that mattered held one line,
a timeout.

Now a windowed summary is written every 20 s whenever at least one poll ran:

```
api.poll_window: Pollit 20 s aikana: 7 kpl (304 5, delta 2, täyshaku 0, reset 0,
virhe 0), 0 uutta tapahtumaa, viimeisin vastaus 18 tapahtumaa, historiassa 18,
kursori 30.7.2026 08:39:22.
```

That answers the three questions the incident could not: **did the polls run**
(`7 kpl`), **what did the API return** (`viimeisin vastaus 18 tapahtumaa`), and
**with which cursor** (`kursori …`).

A summary rather than the line-per-poll the issue asked for, because the control
app derives its whole status column from the **last 50 log lines** — including
debug ones such as the heartbeat. At a 3 s poll interval, one line per poll fills
that window in two and a half minutes and pushes out the evidence the control app
reads; that is exactly the failure mode of issue #102. At 20 s the same
information stays in the window for hours.

When you *are* actively hunting, `RELAY_POLL_TRACE=true` adds `api.poll_trace`,
one line per poll with the cursor and the response size. It is off by default for
the reason above — the cost is paid in the control app's status row, not in log
space.

Fetches are aborted on **two different timeouts**, neither ever shorter than the
current poll interval:

| Fetch | Timeout | Why |
|---|---|---|
| Full history (startup, 60 s resync, delta fallbacks) | **10 s** | The response holds the whole match history and keeps growing, so the earlier 4 s cut healthy requests short late in a match — one broadcast logged 12 aborts in two minutes, all at exactly 4.0 s. |
| Delta poll + startup metadata | **4 s** | Small responses (a 304 smaller still), and the delta runs *every* poll, so it is what decides how fast a hung API is noticed. Giving it the full fetch's patience would only delay detection and recovery by ~6 s per poll. |

**"An aborted delta loses nothing" is only half true, and the half that is false
cost us a wrong conclusion (#156).** Nothing is lost in terms of *correctness* —
the next poll retries and the 60 s resync closes any gap. But `run()` resumes the
cadence from *now*, so the retry fires immediately and the abort costs the whole
timeout in dead waiting, at the head of the speech chain. Match 145918
(31.7.2026) spent 31 x 4 s there, every retry succeeding first try.

Two things to know before retuning either value:

- **The constants are not the effective timeouts.** `apiTimeoutMs()` floors both
  at `pollIntervalMs`, so at the default 3 s cadence the delta timeout is
  `max(4000, 3000)`. Lowering the constant alone can be a no-op.
- **Measure with the relay's own numbers.** `api.poll_window` reports the median
  and max per fetch size (#156). Response times measured externally were p50
  96 ms / max 303 ms under camp-day load, but that is curl's connection
  behaviour, not the relay's.

Also note the startup metadata fetch shares the "small" timeout and is
**unguarded** — a timeout there exits the process while ffmpeg is already
pushing to a live target (#158). Fix that before shortening this.

Polls are sequential, so neither timeout can stack requests; a hung fetch only
postpones the next poll. A control file that raises `pollIntervalMs` above a base
value raises that timeout with it.

### Starting before the source goes live

The relay can be started **any time before** the phone's broadcast begins. If
yt-dlp answers `This live event will begin in N minutes`, that is YouTube
confirming the source exists, so it counts as a wait rather than a failure: the
give-up window below is not touched, and the relay re-checks ~20 s before the
announced time (never sleeping more than 5 min at a stretch, since the estimate
moves). The log says:

```
Lähde ei ole vielä livenä — alkaa noin 103 min kuluttua. Tarkistetaan uudelleen 300 s kuluttua.
```

Shortly before the stream actually starts, yt-dlp stops naming a time and says
`will begin in a few moments` instead. That wording is the **tightest** signal
there is, so the relay switches to a 20 s cadence:

```
Lähde ei ole vielä livenä. Tarkistetaan uudelleen 20 s kuluttua.
```

If "a few moments" outlasts **20 min** the broadcast has really been postponed,
and the cadence relaxes back to 5 min rather than polling hard for hours.

A source that stays in that state for over **3 hours** is treated as cancelled
and the relay shuts down. Any *other* yt-dlp error is a genuine failure and
accrues toward the give-up window as before.

Before this, a scheduled start looked identical to a dead source, which meant
the relay had to be started in a narrow slot ~6 min before kickoff or it would
give up before the match began (observed live 27.7.). The withheld-time branch
then had the opposite bug: it slept the full 5 min cap exactly when the stream
was about to go live. In match 145889 on 29.7. the countdown vanished at 08:28
and ffmpeg attached only at 08:33, so the match start, IPV's first palo and both
first-period runs were narrated into a FIFO nobody was reading.

### Telemetry: status + timeline

Every run writes two machine-readable files into `run/`, for the control app
(`apps/control`) to read while the broadcast is live:

| File | What it is |
|---|---|
| `status-<ID>.json` | The current snapshot, rewritten every poll. Written once immediately at startup and once more on shutdown, so it exists from the moment the unit is active and describes how the run *ended* rather than one poll before. Whole-file and atomic (`.tmp` + rename), so a reader never catches it half-written. |
| `timeline-<ID>.ndjson` | Append-only history: every log line with its level and code, and every narration clip through detected → synthesized → spoken. One JSON object per line. |

The snapshot's most useful field is `readerAttached`: the relay can be running
happily for minutes while ffmpeg is not attached, and everything narrated in
that window is heard by nobody. `narration.muted` counts exactly those clips.
That is not hypothetical — see the poll bug described under "Starting before
the source goes live".

Two fields are only as useful as they are honest, and issue #122 found both
lying at once in match 145900:

- **`respawns`** is the clearest single number for "the picture is stuttering",
  and it read `0` through three logged respawns. It was inferred from state
  that is unavailable in the production configuration (the session index only
  moves when `RELAY_RECORD_FILE` is set); it is now a plain flag set on the
  first spawn.
- **`source.state`** gained `reconnecting`: ffmpeg is not running right now and
  the supervisor is waiting to try again. Before this the snapshot kept saying
  `live` / "ffmpeg käynnissä" for the whole backoff — contradicting the
  `readerAttached: false` sitting next to it in the same file. An ordinary URL
  rotation passes through `reconnecting` too, for a poll at most; the control
  app renders it yellow, because at that instant nothing is reaching the target.

Both files are covered by the `run/` retention sweep, and the running match's
own files are never swept regardless of age.

Telemetry is a pure observer: every write is wrapped, a failure disables
telemetry for the run and says so once, and nothing on the narration path ever
waits for it.

### Log levels and event codes

Each log line carries a **stable event code** (`ffmpeg.respawn`,
`source.not_live`, `speech.muted`, …) and a real severity. Under systemd the
severity goes out as a syslog priority prefix, which journald records as
`PRIORITY` — so `journalctl --user -u pesisselostaja-relay -p warning` works,
and the control app reads the level instead of guessing it from Finnish prose.

The prefix is emitted only when stdout really is the journald stream: systemd
publishes `JOURNAL_STREAM` as `device:inode`, and that is compared against
`fstat(1)`. Presence alone is not enough — the variable is inherited by child
processes, so a relay started by hand from a shell under a systemd unit would
otherwise print `<6>` on every line.

Codes are part of the contract with the control app; the full list is the
`EventCode` union in `src/log.ts`. The developer tools (`flapTest.ts`,
`simulate.ts`) deliberately keep plain uncoded lines — they are not on the
service's path.

### Give-up window after the match ends

While a match is running, a dead source is retried for the generous
`RELAY_MAX_FAILURE_WINDOW_MS` (12 min) before the relay shuts itself down.
Once the match has finished ("Ottelu päättyi" spoken), the source won't come
back — the shorter `RELAY_FINISHED_FAILURE_WINDOW_MS` (default `120000`)
applies instead.

An attempt counts toward the window when it produces no broadcast: either
ffmpeg never started (yt-dlp error, bad args), or it started and the session
ended in under `minProductiveRunMs` (60 s). The exit code is deliberately
ignored — when the source phone dies mid-match, yt-dlp keeps resolving a valid
URL and ffmpeg reads the frozen DVR tail for a few seconds and exits `code=0`,
so a "successful start" alone proves nothing (issue #45; before the fix that
pattern respawned forever and the operator had to stop the service by hand).
Only a run long enough to be real broadcast clears the window — whether it
ended by itself or in the relay's own 15 min URL refresh. That last part
matters: `urlRefreshMs` (15 min) is longer than `RELAY_MAX_FAILURE_WINDOW_MS`
(12 min), so on a healthy source *every* session ends in a refresh kill, and
excusing those from clearing the window would leave a `failingSince` set by
one early blip standing for the rest of the match. A refresh kill only excuses
a session from *accruing*: there the kill, not the source, is why the run was
short.

All durations here are measured on a monotonic clock, so an NTP step can't
turn a healthy session into a seconds-long "failure".

#### Which end failed — source or target?

A target that refuses our push produces **exactly the same session shape** as a
dead phone: ffmpeg starts, dies in seconds, repeat. That matters more now that
short runs accrue toward the give-up window — without help the relay shuts down
blaming the source, and the operator goes to check the phone while the actual
problem is the stream key (issue #51: in one match the phone was streaming with
the wrong key and the whole narration was missing; the only way to tell was
checking ffmpeg respawns and the RTMP connection by hand).

The relay now keeps the tail of ffmpeg's stderr and reads which side it was
complaining about (`ffmpegDiagnostics.ts`). When a short session ends it logs
one extra line naming the suspect, and a target verdict is carried into the
shutdown message.

It only claims a side when **exactly one** side produced connection-level
errors. Three deliberate silences:

- `av_interleaved_write_frame(): Broken pipe` and friends are **not** a target
  verdict on their own — ffmpeg says that whenever the output goes away,
  including when it goes away because the input ended. Counting it would label
  every dead phone a stream-key problem. Since issue #122 the FLV muxer's
  `Failed to update header with correct duration/filesize` is in that same
  category: it is printed while the *output is closed*, which happens on every
  teardown including the ordinary one where the input ended first.
- **A `code=0` exit names nobody at all** (issue #122). Exiting 0 means ffmpeg
  read its input to EOF; a target that refuses or drops the push makes it exit
  non-zero. So on a clean exit the tail can only hold teardown noise, and the
  log says "syöte loppui" instead of pointing anywhere. This was not a
  hypothetical: on 30.7.2026 two matches (145900 and 145905) ended with a
  `code=0` exit whose only stderr was the FLV line, and both told the operator
  to go check a stream key that was fine while the phone had stopped sending.
- If both sides errored, cause and consequence are indistinguishable, so it
  says so instead of guessing.

This reads ffmpeg's error text; it does not query YouTube. Confirming that the
target broadcast is actually bound and accepting still needs the YouTube Data
API, which is not wired up — the rest of issue #51.

The stream key is redacted (`<stream-key>`) from everything ffmpeg writes to the
journal, since ffmpeg prints the full output URL in its own error lines.

### No-signal slate ("EI SIGNAALIA") — off by default

When the source drops, ffmpeg exits and the respawn loop leaves the RTMP push
*paused*, so the viewer sees a frozen picture or "stream offline". With the
slate enabled the relay instead keeps pushing: a still image (colour bars,
"EI SIGNAALIA", the score and a status line) with the narration mixed on top,
until the source comes back.

**The narration keeps running over it.** Commentary comes from the results
service, not from the video, so it works even when the picture is gone — the
viewer still gets the runs, the palot and the batters. That is why every
wording on the status line ends in *"selostus jatkuu"*: it tells the viewer not
to close the stream.

| Situation | Status line |
|---|---|
| Source dropped mid-broadcast | `kuvayhteys katkesi, selostus jatkuu` |
| Source has not started yet | `kuvayhteyttä odotetaan — selostus jatkuu` |
| A reconnect attempt is running | `yhdistetään uudelleen — selostus jatkuu` |

The current period and palot are prefixed when known (`1. jakso, 2 paloa — …`),
and the score row above shows `<home> 12 – <away> 1` — each score next to its
own team, because with the numbers between the names ("koti 12 - 1 vieras") the
first person to read a preview read "1 vieras" as the team name. A row too wide
for the frame is truncated with an ellipsis: `drawtext` cannot shrink text and
its font size cannot depend on the measured width, so the writing side has to
fit it. Both rows are supplied ready-made by the commentary loop; the mixer only
displays them. Before the match has produced any event both rows are empty and
the picture is just "EI SIGNAALIA" plus the footer — that is a valid result.

**Turning it on**

```
RELAY_NO_SIGNAL_SLATE=true            # default false
RELAY_NO_SIGNAL_SLATE_AFTER_MS=8000   # how long the source must be gone first (floor 2000)
RELAY_NO_SIGNAL_SLATE_SIZE=1280x720   # default 1920x1080 — set it to the SOURCE's resolution
```

**Set the size to match the source.** The slate pushes to the same RTMP key as
the source session, so if their resolution or frame rate differ, YouTube's
transcoder restarts on the way in *and* on the way back — two extra viewer-side
blips per outage, which is the very thing this feature exists to remove. The
source's resolution is not available for free (`yt-dlp -g` does not report it),
so it is the operator's job to say. A handheld phone stream is often 720p; the
startup log prints the slate's size so a mismatch is visible afterwards.

The threshold exists so a one-second respawn blip does not flash the slate; the
issue asks for a 5–10 s outage before it engages. It is floored at 2000 ms — `0`
would flash the slate on every scheduled URL refresh. The background is rendered
once per run by `tools/no-signal-slate.py` into `run/slate-<matchId>.png`; the
score and status rows live in `run/slate-score-<matchId>.txt` and
`run/slate-status-<matchId>.txt` and are read by ffmpeg's `drawtext ... reload`,
so they update **without a respawn**. All of these are covered by the `run/`
retention sweep.

**Why it defaults to off.** This is a new ffmpeg path that runs precisely when
the broadcast is already in trouble, and it has not been exercised live. The
first attempt has to be a deliberate choice, not something that happens by
itself the first time a camera falls over mid-match.

**What it will never do**

- It never keeps the relay alive. The give-up window
  (`RELAY_MAX_FAILURE_WINDOW_MS` / `RELAY_FINISHED_FAILURE_WINDOW_MS`) runs
  unchanged while the slate is up: each source probe during the slate goes
  through the same accounting as a normal respawn, so `SourceExhaustedError`
  arrives at exactly the same moment it would without the slate. Pushing colour
  bars is not "productive broadcast" and never resets anything.
- It never starts once the match has finished, or when the control app's
  `sourceIngest` observation says the source broadcast is `complete` — a source
  that ended in an orderly way means the broadcast ends, not that we stand
  there pushing bars into an empty stream.
- Any failure in the chain (missing `python3`/PIL, a failed render, ffmpeg
  dying in slate mode, a failed write) skips the slate for the rest of the run
  with **one** warning line, and the respawn loop behaves exactly as it does
  today.

The state is visible to the control app: `status-<ID>.json` reports
`source.state = "no_signal"` while the slate is up (with `source.detail` still
naming the underlying reason), and the log carries `ffmpeg.slate_start` /
`ffmpeg.slate_end`. A broadcast that *looks* smooth must not hide a camera that
has fallen over.

The `sourceIngest` key is an optional input only. It is used for the two things
above (ending cleanly, and sharpening the wording) and never as the trigger:
the trigger is always the relay's own local observation, because that signal
arrives up to 30 s late and depends on the control app and on Google. Missing,
stale (>120 s) or malformed means *no information* — never *the source is
down*.

### Preflight (run this before every match)

```bash
npm run broadcast:preflight              # reads apps/broadcast/.env.relay
npm run broadcast:preflight -- /path/to/other.env
```

Checks everything that has ever gone wrong before a broadcast, in one pass, and
exits nonzero if anything blocks:

```
✓ Levytila             37.0 Gt vapaana / 78.6 Gt
✓ Roikkuvat prosessit  ei roikkuvia ajoja
✓ Relay-palvelu        inactive (odotettu)
✓ yt-dlp               2026.07.04
✓ ffmpeg               ffmpeg version 6.1.1
✓ Ottelu               Laihian Luja vs Pesä Ysit, Lappeenranta
✓ Tapahtumat           0 tapahtumaa — ottelua ei ole vielä avattu (normaali ennen alkua)
✓ Lähde                ei vielä livenä, ajastettu alkavaksi (~103 min) — relay odottaa
✓ Kohde                rtmp://a.rtmp.youtube.com/live2 + stream key asetettu
✓ ElevenLabs           14760 merkkiä jäljellä (ottelu kuluttaa ~5000)

Kaikki kunnossa — relay voidaan käynnistää.
```

`✗` = blocker (exit 1), `⚠` = worth reading but not fatal (a stale process,
low ElevenLabs quota, a source that resolves to something other than HLS).

It reads `.env.relay` **the same way systemd does**, so it checks what the
service will actually run — a plain `npm run` shell has none of those variables,
which is how an earlier check reported Piper while the real run used ElevenLabs.
Variables already set in the environment win over the file.

### Testing without touching YouTube (dry run)

```bash
npm run broadcast:dev -- --match-id 123456 --youtube-url "https://..." --dry-run
```
This runs the same commentary poll loop against real match data, logs what
would be synthesized, and never starts ffmpeg or touches RTMP.

## Expected latency

Total delay between a real event and hearing it on the second broadcast is
roughly **30–90 seconds** — the original stream's own latency, plus this
relay's pull/mix/encode time, plus the second broadcast's own YouTube ingest
latency, all stack. This is inherent to the pull-back architecture (chosen so
the original broadcast can never be affected by this subsystem crashing) and
is not something to try to eliminate.

## Troubleshooting

- **ffmpeg exits immediately with "No such file or directory" on the FIFO
  input** — the pipe wasn't created before ffmpeg spawned; check the
  `narrationFifo.prepare()` step ran (should self-heal on the next
  respawn/backoff cycle).
- **"Thread message queue blocking" / audio glitches** — usually means the
  FIFO's 20ms writer fell behind (GC pause, CPU contention). Check `top`/`free
  -h` for resource pressure from other services on this host.
- **yt-dlp returns no URL / 403** — the original broadcast may have ended, be
  private, or YouTube may be rate-limiting; `yt-dlp --version` should also be
  reasonably current (update it if extraction starts failing repo-wide).
- **`HUOM: yt-dlp ei palauttanut HLS-manifestia`** — the picture is going out
  at whatever the progressive fallback offers (typically 360p) instead of the
  full-quality HLS rendition. Since the 2026.07 releases yt-dlp needs a
  JavaScript runtime to list the m3u8 formats, and Deno — its only default —
  isn't installed here, so `resolveSourceUrl` passes the running Node binary
  via `--js-runtimes`. If the warning appears anyway, check that `yt-dlp` is
  current and that the process can execute `process.execPath`. Verify by hand
  with:

  ```bash
  yt-dlp -g -f "best[protocol^=m3u8]/best" --js-runtimes "node:$(which node)" <URL>
  ```

  A good result starts `https://manifest.googlevideo.com/api/manifest/hls_…`;
  a bad one is `…/videoplayback?…&itag=18`.
- **No narration audible on the second broadcast, but ffmpeg looks healthy**
  — check `RELAY_NARRATION_GAIN` isn't 0, and confirm `commentaryLoop` is
  actually seeing new pesistulokset.fi events (compare against the main app's
  own log for the same match).
- **RTMP push drops repeatedly** — ffmpeg has no automatic reconnect for the
  push side; each drop triggers a full respawn (with backoff). Persistent
  drops point to a network/ISP issue on this host, not a code bug.
- **The target broadcast stays "live" in Studio for minutes after the push
  stops** — expected. Auto-stop works, but with a delay; end it by hand from
  Studio if it needs to be immediate.
- **A live glitch cannot be replayed from the API afterwards** — once a match
  ends, `online/{id}/events` returns only the final, cleaned history. The
  evidence for anything that happened *during* the match is what the run left
  behind in `run/`: `.state-<ID>.json`, `status-<ID>.json` and
  `timeline-<ID>.ndjson`. Keep them before cleaning up.

## ElevenLabs voice (primary engine)

When `ELEVENLABS_API_KEY` is set in `.env.relay`, narration is synthesized with
the ElevenLabs API (`elevenLabsTts.ts`) instead of Piper; Piper stays installed
as the automatic per-utterance fallback (network error, credits exhausted, 429),
so the stream never goes silent. Details:

- **Voice/model:** `RELAY_ELEVENLABS_VOICE` (default Brian,
  `nPczCjzI2devNBz1zQrb`, chosen by listening tests 2026-07-14) and
  `RELAY_ELEVENLABS_MODEL` (default `eleven_multilingual_v2`, 1 credit/char).
- **No pronunciation substitutions:** ElevenLabs reads abbreviations like `KPL`
  correctly, so it gets the readable text as-is. The `.pronunciations.json`
  substitutions still apply on the Piper fallback path.
- **Numbers are spelled out:** EL reads bare digits in short Finnish phrases
  unclearly ("Tasan 4, 4", heard live), so the EL path converts them to
  Finnish words ("Tasan neljä, neljä") before synthesis (`spellOutNumbers` in
  `packages/core`). Logs and the Piper path keep the digits.
- **Cache:** synthesized audio is cached as PCM in `apps/broadcast/run/tts-cache/`
  keyed by model+voice+text, so repeated phrases ("Palo! KPL.") cost credits only
  once — also across matches. Safe to delete anytime; kept under a size ceiling
  automatically (see "Disk retention in `run/`" below).
- **Cost visibility:** each synthesis logs its character count and a running
  total; the total is logged again at shutdown (≈ credits on multilingual v2).

## Disk retention in `run/`

`apps/broadcast/run/` is the relay's scratch directory (git-ignored via the
repo-root `.gitignore`, so nothing here is ever committed). Every run leaves
artifacts behind, and before issue #39 nothing ever removed them — the directory
had grown to 1.4 G. On startup `index.ts` now applies a retention policy
(`runRetention.ts`) before synthesis begins:

| What | Rule | Env var (default) |
|------|------|-------------------|
| `relay-<matchId>.pcm`, `.state-<matchId>.json`, `.control-<matchId>.json` | removed when older than N days | `RELAY_RUN_RETENTION_DAYS` (`30`, `0` = off) |
| `status-<matchId>.json`, `timeline-<matchId>.ndjson` | same | same |
| `slate-<matchId>.png`, `slate-score-<matchId>.txt`, `slate-status-<matchId>.txt` (+ their `.tmp`) | same | same |
| `run/tts-cache/<sha256>.pcm` | least-recently-used clips evicted until the directory fits the ceiling | `RELAY_TTS_CACHE_MAX_MB` (`1024`, `0` = off) |

Two properties matter more than the numbers:

- **It is an allowlist, not a sweep.** Only the filename shapes above are ever
  deleted, only at the top level of `run/`, and **never a directory**. Operator
  material living in `run/` — `field-audio-demo/`, `voice-tuning-demo*/`,
  `simulate-<id>/`, hand-made `live-test-*.mp4` recordings — is invisible to the
  policy no matter how old or how large it gets. Deleting those stays a
  deliberate human action.
- **The starting match is exempt.** Its own state/control files survive
  regardless of age, so a resumed relay never loses its progress.

The sweep is best-effort: a missing `run/`, a missing `tts-cache/`, or an
unlinkable file is logged-and-ignored rather than allowed to block a broadcast.
It logs one line when it removed anything (`Säilytyskäytäntö: poistettu N …`).

TTS-cache eviction is genuine LRU: `elevenLabsTts.ts` bumps a clip's mtime on
every cache hit, so a phrase that recurs match after match outlives a one-off.
Evicted clips are regenerable — the only cost of a wrong guess is re-spending
ElevenLabs credits on that phrase once.

Because everything else in `run/` is out of scope by design, periodically
checking `du -sh apps/broadcast/run/*` and deleting reviewed demo/simulation
output by hand is still part of operating the relay.

## Swapping Piper voices later

Only `fi_FI-harri-medium` is wired up today (`RELAY_VOICE=harri-medium` is
the default and the only model downloaded during setup). To add
`harri-low`/`asmo-medium`, download their `.onnx`/`.onnx.json` pair into
`apps/broadcast/voices/` (same URLs as `apps/web/src/piper.ts` uses) — `piperTts.ts`'s
`VOICE_FILES` map already has entries for all three, so this is config only,
no code change.
