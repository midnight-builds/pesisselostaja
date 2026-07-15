# CLAUDE.md

## What this is
Watches live **Finnish pesäpallo** matches (from pesistulokset.fi) and speaks events
aloud in the browser (and mixes the same narration into YouTube rebroadcasts). This is pesäpallo, **not US baseball** —
the rules differ (jaksot/periods, supervuoro, kotiutuslyöntikilpailu, palot). If your
knowledge of the sport is thin, look it up online and confirm specifics with the user
before relying on them.

## Layout
npm-workspaces monorepo: `packages/core` (pure domain logic: types, API client,
speech text, scoring, pronunciation substitution — no localStorage/fs/DOM),
`apps/web` (browser app, localStorage + Web Speech/Piper-WASM adapters),
`apps/broadcast` (YouTube pipeline, file + native-Piper adapters),
`apps/server` (static host for the built web app on :3000).

## Scoring
The API gives no ready scoreboard — per-period scores are derived by counting events.
**One scoring marking = one run.** Stat values (`score:3`, `homerun:2`) are lyöntipisteet,
not runs. Periods come from `event.period`: 0 = 1. jakso, 1 = 2. jakso, 2 = supervuoro,
3 = kotiutuslyöntikilpailu. See `runValueOfSubEvent` in `packages/core/src/speech.ts`.

## Terminology
**Palo** = an "out". Palot belong only to the team currently batting (sisävuoro) and
**reset to zero each period / each turn change**; they are announced with a Finnish
ordinal ("kolmas palo").

## TTS pronunciation
Speech is read aloud by browser TTS or Piper, which mispronounce some terms.
This is **not** a blanket spell-out rule — most abbreviations (e.g. `IPV`) read fine.
Only specific misread terms get an override, defined as a configurable substitution list.
Overrides spell the term out phonetically, e.g. `KPL` → `Koo Pee Äl`. The substitution
logic lives in `packages/core/src/pronunciation.ts`; the web app persists rules in
localStorage, the broadcast app reads repo-root `.pronunciations.json`. The log keeps
the readable original.

## Build / commit hook
Editing a file under any workspace `src/` (`packages/core/src`, `apps/*/src`) auto-runs
that workspace's typecheck+build + `git add <workspace>` + commit
(`.claude/settings.json`, local-only — see `.gitignore`). So: workspace `src/` changes
commit themselves; a multi-file refactor shows build failures on intermediate edits
(expected until all files are consistent); other changes (tests, configs, docs) need a
manual commit. The hook never commits directly onto `main`/`master`: if it's about to
commit while on one of those, it first creates and switches to `auto/<timestamp>`, and
later auto-commits in the same session stay on that branch. Work meant to land via PR
should still check out a real feature branch *before* editing — the auto-branch is a
safety net, not a substitute for a properly named branch.

## Running
`apps/server` runs as a systemd **user** unit. Restart with
`systemctl --user restart pesisselostaja.service` (not `sudo`). UI on :3000 (it serves
`apps/web/dist` — rebuild the web app for UI changes to show). The broadcast pipeline
has its own unit, `pesisselostaja-relay.service` (see `/relay-ottelu`).

## After completing a feature
1. Workspace `src/` changes build and commit themselves (hook above) — verify build was clean.
2. Commit other changes (tests, configs, docs) manually.
3. For web/server changes: `npm run build -w @pesisselostaja/web` (and `-w @pesisselostaja/server`
   if it changed), then restart: `systemctl --user restart pesisselostaja.service`
4. Confirm `systemctl --user is-active pesisselostaja.service` → `active`.

Do this automatically at the end of every successful feature, without waiting to be asked.
