# pesistulokset-voice-watcher

Watch Finnish pesäpallo matches live from [pesistulokset.fi](https://www.pesistulokset.fi) and speak important events through Home Assistant TTS.

## Features

- Polls the Pesistulokset live events API for match updates
- Converts events to natural Finnish speech
- Speaks through Home Assistant Cloud TTS (or any HA TTS entity)
- Deduplicates events with a persistent state file (safe to restart)
- Supports dry-run mode for testing without HA

### Spoken events

- **Juoksut** (runs): "Korhonen löi juoksun, tuojana Virtanen."
- **Kunnarit** (home runs): "Nieminen löi kunnarin!"
- **Palot** (outs): "Palo! IPV."
- **Jakson alku/loppu** (period start/end)
- **Ottelu alkoi/päättyi** (match start/end with score)
- **Hutunkeiton voitto** (draw of choice)

### Not spoken

- Lyöntivuorossa (at-bat announcements) — too frequent
- Stats-only updates

## Setup

```bash
npm install
npm run build
cp .env.example .env
# Edit .env with your Home Assistant URL and token
```

## Usage

```bash
# Dry run (logs speech to console)
npm run dev -- --match-url https://www.pesistulokset.fi/ottelut/135155 --dry-run

# With Home Assistant TTS
npm start -- --match-id 135155

# Custom poll interval (seconds)
npm run dev -- --match-id 135155 --dry-run --poll-interval 10
```

### CLI options

| Option | Description |
|---|---|
| `--match-url <url>` | Pesistulokset match page URL |
| `--match-id <id>` | Match ID (numeric) |
| `--dry-run` | Log speech instead of calling HA TTS |
| `--poll-interval <s>` | Poll interval in seconds (default: 6) |
| `--state-file <path>` | State file path (default: `.state-<matchId>.json`) |
| `--api-key <key>` | Override API key |

### Environment variables

| Variable | Description |
|---|---|
| `HOMEASSISTANT_URL` | Home Assistant base URL |
| `HOMEASSISTANT_TOKEN` | Long-lived access token |
| `HA_TTS_ENTITY` | TTS entity (default: `tts.home_assistant_cloud`) |
| `HA_MEDIA_PLAYER_ENTITY` | Media player entity |
| `PESISTULOKSET_API_KEY` | API key override |
| `PESISTULOKSET_API_BASE` | API base URL override |

## Development

```bash
npm run dev -- --match-id 135155 --dry-run  # Run with tsx
npm run typecheck                            # Type check
npm run lint                                 # Lint
npm test                                     # Run tests
```

## Limitations

- Player name resolution depends on the match metadata. If a player ID in an event doesn't match the roster, the name will show as "?".
- The events API structure is reverse-engineered from the frontend; it may change.
- Score summaries are only available for completed matches (from the result field).
