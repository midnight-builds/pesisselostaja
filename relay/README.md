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

   mkdir -p relay/voices
   curl -L -o relay/voices/fi_FI-harri-medium.onnx      https://huggingface.co/diffusionstudio/piper-voices/resolve/main/fi/fi_FI/harri/medium/fi_FI-harri-medium.onnx
   curl -L -o relay/voices/fi_FI-harri-medium.onnx.json https://huggingface.co/diffusionstudio/piper-voices/resolve/main/fi/fi_FI/harri/medium/fi_FI-harri-medium.onnx.json
   ```
2. `cp relay/.env.relay.example relay/.env.relay` and confirm `piper --help`
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
3. Edit `relay/.env.relay`:
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
- **Live, without restarting:** the loop re-reads `relay/run/.control-<matchId>.json`
  every poll (~6 s). Flip it and the change takes effect within one poll:
  ```bash
  echo '{"announceBatterChanges": false}' > relay/run/.control-143280.json   # off
  echo '{"announceBatterChanges": true}'  > relay/run/.control-143280.json   # back on
  ```
  The relay logs a line when the effective value changes. The startup log
  prints the exact control-file path for the running match. (The file is
  written from the env/CLI value at startup, so the env/CLI setting is
  authoritative on start and live edits take over after.)

### Testing without touching YouTube (dry run)

```bash
npm run relay:dev -- --match-id 123456 --youtube-url "https://..." --dry-run
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

## Swapping voices later

Only `fi_FI-harri-medium` is wired up today (`RELAY_VOICE=harri-medium` is
the default and the only model downloaded during setup). To add
`harri-low`/`asmo-medium`, download their `.onnx`/`.onnx.json` pair into
`relay/voices/` (same URLs as `v2/src/piper.ts` uses) — `piperTts.ts`'s
`VOICE_FILES` map already has entries for all three, so this is config only,
no code change.
