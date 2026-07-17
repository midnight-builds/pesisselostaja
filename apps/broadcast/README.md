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
  every poll (~4 s). Flip it and the change takes effect within one poll:
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

- **At startup:** `RELAY_NARRATION_DELAY_MS=4000` in `.env.relay`, or
  `--narration-delay-ms 4000`. Default `2000` (calibrated live, match 144742).
- **Live, without restarting:** the same control file, `narrationDelayMs` key:
  ```bash
  echo '{"narrationDelayMs": 4000}' > apps/broadcast/run/.control-143280.json   # add 4s
  echo '{"narrationDelayMs": 0}'    > apps/broadcast/run/.control-143280.json   # off
  ```
  The control-file value wins over the env/CLI seed. You can set several keys
  in one file (`{"announceBatterChanges": false, "narrationDelayMs": 4000}`);
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
complete history every poll; the server's reset flag or an inconsistent delta
triggers an immediate full refetch, and a full resync runs every ~60 s as
insurance. Watch the log for `Delta-haku: N uutta …` lines and fall back live
if anything looks off:

- **At startup:** `RELAY_DELTA_FETCH=false` reverts to plain full fetches.
- **Live, without restarting:** control file keys `deltaFetch` (boolean) and
  `pollIntervalMs` (min 2000):
  ```bash
  echo '{"deltaFetch": false}'    > apps/broadcast/run/.control-143280.json  # full fetches
  echo '{"pollIntervalMs": 5000}' > apps/broadcast/run/.control-143280.json  # slower poll
  ```

### Give-up window after the match ends

While a match is running, a dead source is retried for the generous
`RELAY_MAX_FAILURE_WINDOW_MS` (12 min) before the relay shuts itself down.
Once the match has finished ("Ottelu päättyi" spoken), the source won't come
back — the shorter `RELAY_FINISHED_FAILURE_WINDOW_MS` (default `120000`)
applies instead. Clean ffmpeg exits (a flapping source) still never count
toward giving up.

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
- **Cache:** synthesized audio is cached as PCM in `apps/broadcast/run/tts-cache/`
  keyed by model+voice+text, so repeated phrases ("Palo! KPL.") cost credits only
  once — also across matches. Safe to delete anytime.
- **Cost visibility:** each synthesis logs its character count and a running
  total; the total is logged again at shutdown (≈ credits on multilingual v2).

## Swapping Piper voices later

Only `fi_FI-harri-medium` is wired up today (`RELAY_VOICE=harri-medium` is
the default and the only model downloaded during setup). To add
`harri-low`/`asmo-medium`, download their `.onnx`/`.onnx.json` pair into
`apps/broadcast/voices/` (same URLs as `apps/web/src/piper.ts` uses) — `piperTts.ts`'s
`VOICE_FILES` map already has entries for all three, so this is config only,
no code change.
