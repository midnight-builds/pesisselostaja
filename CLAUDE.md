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
Broadcast-chain terms (raakalähetys, selostettu lähetys, tulospalvelun
ottelusivu, ajastushetki, käynnistysikkuna, …) are defined in `CONTEXT.md` at
the repo root — **read it before writing about the chain** in issues, docs or
code comments; "lähde-URL" without a qualifier has already caused confusion.

**Palo** = an "out". Palot belong only to the team currently batting (sisävuoro) and
**reset to zero each period / each turn change**; they are announced with a Finnish
ordinal ("kolmas palo").

**Who scores a run.** Confirmed by the user 29.7.2026 after a wrong guess was
nearly acted on — do not re-derive this from general baseball intuition:

- *"Vesterinen löi juoksun, tuojana Hupli"* is CORRECT. **Vesterinen was the
  batter (lyöjä).** After the hit, runners advance 1. pesä → 2. pesä → 3. pesä
  → kotipesä.
- The **tuoja** is the runner who gets from **3. pesä to kotipesä** before the
  ball reaches the lukkari at home. So the verb "löi" belongs to the batter,
  never to the runner.
- *"Juoksun löi Lappalainen, tuojana Vesterinen"* therefore means: Vesterinen
  had advanced around the field, Lappalainen hit the ball, and Vesterinen made
  it home from 3. pesä.
- **Harhaheitto** (`wtscore` in the API): the fielding side had the ball but it
  got away while being thrown between players, and a runner made it home from
  3. pesä in the meantime. No batter is credited — the API sends the phrase
  *"toi juoksun harhaheitolla"* ready-made.

**"Vuorossa" and "lyömässä" mean the same thing** — both refer to the player
now batting. The speech variants may use either freely.

**One marking can bring more than one run** (`oscscore` > 1), though it is rare.
`runValueOfSubEvent` already returns the count; speech that says "a run" in the
singular is therefore not always accurate.

When a pesäpallo detail is not written down here, **ask the user** rather than
inferring it. Getting this wrong ships to every broadcast.

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

## Parallel PRs: don't let branches diverge on the same seam
Several long-lived branches editing the same file, none based on the others, is the
antipattern: **merge/integration debt**, and its failure mode is a **semantic
conflict** — the merge is textually clean, typecheck passes, every test is green, and
the meaning is still wrong. That is not a merge you can review by reading conflict
markers, because there are none.

It has already cost us. On 30.7.2026 nine branches cut from the same `main` were merged
in one sitting, and three separate defects only existed *between* them: the relay
gained source states `ended` (#103) and `no_signal` (#104) after the control app's
telemetry reader (#97) was written, so both fell into a `default` branch and the status
row read "relay ei kerro lähteen tilaa" exactly when the relay was reporting precisely;
the same drift appeared again in `RelayTelemetry.source.state`; and the slate loop
swallowed `SourceEndedError`, which would have left colour bars pushing into an ended
broadcast for the whole give-up window.

So, in order of preference:

1. **Land the first one before starting the second.** Small PRs merged to `main` the
   same day beat four branches held open for review.
2. **If they must overlap, stack them:** branch the second off the *first branch*, not
   off `main`, and say so in the PR body ("perustuu #112:een"). The second PR's diff
   then shows only its own change, and there is nothing to reconcile later.
3. **If they truly are independent, prove it before opening the second PR:**
   `gh pr list` then compare `git diff --name-only main...` between them. Overlap in a
   *file* is a warning; overlap in one function, one `switch`, or one union type means
   go back to option 1 or 2.

When integrating anyway:

- **`git fetch` after every `gh pr merge`.** A "no conflicts" result computed against a
  stale `origin/main` is meaningless — this happened here, on the one file another PR
  had just rebuilt.
- **Merge `origin/main` into the feature branch, not the other way round**, and resolve
  there. Editing `main` directly trips the auto-commit hook mid-merge.
- **A green suite is not enough.** After resolving, re-read the seam the other PR
  changed and ask what the *other* side now expects. Every new enum value, widened
  union or added state is a contract: find every `switch`, every mirrored type (the
  control app mirrors `RelayStatus` by hand) and every consumer, in the same PR.
- **Add a test for each cross-PR defect you find**, named after the interaction. Those
  are the defects no single PR's tests could have caught.

## Running
`apps/server` runs as a systemd **user** unit. Restart with
`systemctl --user restart pesisselostaja.service` (not `sudo`). UI on :3000 (it serves
`apps/web/dist` — rebuild the web app for UI changes to show). The broadcast pipeline
has its own unit, `pesisselostaja-relay.service` (see `/relay-ottelu`).

**The relay does NOT run from this working copy.** It runs from a pinned, detached
git worktree at `~/relay-deploy` (`WorkingDirectory` + `ExecStart` in the unit point
there), because it used to run straight out of the development checkout — where a
branch switch mid-broadcast could pull the source out from under a live stream
(issue #59). Consequences worth knowing:

- **Editing or switching branches here never affects a running broadcast.** That is
  the whole point; you don't have to freeze the repo during a match.
- **Code changes reach the relay only via `npm run relay:deploy`** (optionally
  `-- <ref>`, default `origin/main`). Until then the relay keeps running the commit
  it was deployed with. The script refuses to run while the service is active.
- `voices/`, `run/` and `.env.relay` are **symlinked** from this checkout into the
  deploy, not copied — the TTS cache, resume state and Piper models are shared on
  purpose. Editing `.env.relay` here is what the relay reads.

## After completing a feature
1. Workspace `src/` changes build and commit themselves (hook above) — verify build was clean.
2. Commit other changes (tests, configs, docs) manually.
3. For web/server changes: `npm run build -w @pesisselostaja/web` (and `-w @pesisselostaja/server`
   if it changed), then restart: `systemctl --user restart pesisselostaja.service`
4. Confirm `systemctl --user is-active pesisselostaja.service` → `active`.

Do this automatically at the end of every successful feature, without waiting to be asked.
