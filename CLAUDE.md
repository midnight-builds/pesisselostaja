# CLAUDE.md

## What this is
Watches live **Finnish pesäpallo** matches (from pesistulokset.fi) and speaks events
aloud via Home Assistant TTS or the browser. This is pesäpallo, **not US baseball** —
the rules differ (jaksot/periods, supervuoro, kotiutuslyöntikilpailu, palot). If your
knowledge of the sport is thin, look it up online and confirm specifics with the user
before relying on them.

## Scoring
The API gives no ready scoreboard — per-period scores are derived by counting events.
**One scoring marking = one run.** Stat values (`score:3`, `homerun:2`) are lyöntipisteet,
not runs. Periods come from `event.period`: 0 = 1. jakso, 1 = 2. jakso, 2 = supervuoro,
3 = kotiutuslyöntikilpailu. See `runValueOfSubEvent` in `src/speech.ts`.

## Terminology
**Palo** = an "out". Palot belong only to the team currently batting (sisävuoro) and
**reset to zero each period / each turn change**; they are announced with a Finnish
ordinal ("kolmas palo").

## TTS pronunciation
Speech is read aloud by HA TTS or the browser, both of which mispronounce some terms.
This is **not** a blanket spell-out rule — most abbreviations (e.g. `IPV`) read fine.
Only specific misread terms get an override, defined as a configurable substitution list
(editable in the web UI, persisted to `.pronunciations.json`). Overrides spell the term
out phonetically, e.g. `KPL` → `Koo Pee Äl`. Substitution happens once in
`WatcherController.say()` (`src/pronunciation.ts`), so both outputs get it; the log keeps
the readable original.

## Build / commit hook
Editing any `src/` file auto-runs `npm run build` + `git add src/` + commit
(`.claude/settings.json`). So: `src/` changes commit themselves; a multi-file refactor
shows build failures on intermediate edits (expected until all files are consistent);
non-`src/` changes (tests, configs) need a manual commit.

## Running
Runs as a systemd **user** unit. Restart with
`systemctl --user restart pesisselostaja.service` (not `sudo`). UI on :3000.

## After completing a feature
1. `src/` changes build and commit themselves (hook above) — verify build was clean.
2. Commit any non-`src/` changes (tests, configs, docs) manually.
3. Restart the service: `systemctl --user restart pesisselostaja.service`
4. Confirm `systemctl --user is-active pesisselostaja.service` → `active`.

Do this automatically at the end of every successful feature, without waiting to be asked.
