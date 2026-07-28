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
  (match 146210; an earlier `2000` default had to be raised by hand in every
  broadcast). It stays adjustable from the control file, so treat `4000` as the
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
what made the 4 s timeout bite in matches 144918 and 146210 (27.7.).

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

Each API fetch is aborted after **10 s** (never less than the current poll
interval). A full fetch returns the whole match history, which keeps growing, so
the earlier 4 s cut healthy requests short late in a match — live 146210 logged
12 aborts in two minutes, all at exactly 4.0 s. Polls are sequential, so the
longer timeout cannot stack requests; a hung fetch only postpones the next poll.

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

A source that stays in that state for over **3 hours** is treated as cancelled
and the relay shuts down. Any *other* yt-dlp error is a genuine failure and
accrues toward the give-up window as before.

Before this, a scheduled start looked identical to a dead source, which meant
the relay had to be started in a narrow slot ~6 min before kickoff or it would
give up before the match began (match 144918, 27.7.).

### Give-up window after the match ends

While a match is running, a dead source is retried for the generous
`RELAY_MAX_FAILURE_WINDOW_MS` (12 min) before the relay shuts itself down.
Once the match has finished ("Ottelu päättyi" spoken), the source won't come
back — the shorter `RELAY_FINISHED_FAILURE_WINDOW_MS` (default `120000`)
applies instead. Clean ffmpeg exits (a flapping source) still never count
toward giving up.

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
  unclearly ("Tasan 4, 4" — live 144742), so the EL path converts them to
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
| `run/tts-cache/<sha256>.pcm` | least-recently-used clips evicted until the directory fits the ceiling | `RELAY_TTS_CACHE_MAX_MB` (`512`, `0` = off) |

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
