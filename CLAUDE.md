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
`apps/server` (static host for the built web app on :3000),
`apps/control` (ohjaamo — YouTube chain, relay lifecycle, live monitoring on :3002).

**The pesistulokset API surface** — base URL, which paths need the key and which
don't, and copy-pasteable curl — is in `packages/core/README.md`. Read it before
reverse-engineering `src/api.ts` again (issue #70). The short version: `/public/**`
needs `?apikey=`, `/online/**` does not.

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

## Raakalähetykseen kirjoittaminen

**Raakalähetystä (`RELAY_YOUTUBE_URL`, se johon kuvauspuhelin työntää) ei
kosketa ottelun ollessa kesken.** Ainoa sallittu kirjoitus on hard stopin siivous päättyneen
ottelun jälkeen (issue #123), ja sekin vain kun `CONTROL_HARD_STOP_SOURCE` on
päällä (oletus pois). Siivouksen tekee ohjaamo laskevalla reunalla, kun relayn
oma telemetria kertoo `endReason === "hard_stop"`. Selostettu lähetys transitoidaan
`complete`ksi vain samassa tilanteessa — normaalissa lopetuksessa luotetaan
YouTuben `enableAutoStop`iin.

Aiempi ehdoton muotoilu ("alkuperäistä lähetystä ei kosketa koskaan") on
korvattu tällä; älä palauta sitä. Sama teksti on `.claude/skills/relay-ottelu/`
-runbookissa.

## Ottelupäivä: ohjaamo omistaa ketjun

**Ohjaamo on oletus koko ketjulle** — ottelun valinta, molempien YouTube-
lähetysten luonti, jakoviesti, käynnistys, ajonaikainen ohjaus ja siivous
(issue #124). Käsityökierros YouTube Studiossa on **poikkeuspolku**, jota
käytetään vain kun ohjaamo tai sen YouTube-valtuutus ei toimi — ei runbook.

**Ajaminen tapahtuu ohjaamon käyttöliittymästä, ei agentin kautta.** Kartta
#168 vei ketjun käyttöliittymään asti: yksi tilakortti puhelimen ruudulla,
ei navigaatiota, ei terminaalia. `/relay-ottelu` **ei ole ajotapa vaan
varapolku** — se on osoitin ohjaamoon plus se, mitä tehdään kun ohjaamo ei
riitä (deploy, käsikäynnistys vahdin pettäessä, vianetsintä lokista,
käsikierros Studiossa). Jos ajat ottelun agentin kautta, olet ohittanut sen
mitä varten ohjaamo tehtiin.

Kaksi asiaa, jotka ovat menneet väärin nimenomaan tässä:

- **"Ajasta peli" tarkoittaa ajastusta ohjaamon välinein.** Jos jokin handoff
  tai dokumentti näyttää ohjaavan käsikierrokseen, sano ristiriita ääneen ja
  kysy — älä korvaa käyttäjän eksplisiittistä pyyntöä hiljaa "vastaavalla"
  toteutuksella. 30.7.2026 niin tehtiin, ja lähetysten luonti valui takaisin
  sille ulkopuoliselle palvelulle, jonka korvaaminen on #124:n koko tavoite.
- **Ketjun termit ovat repon juuren `CONTEXT.md`:ssä** (raakalähetys,
  selostettu lähetys, tulospalvelun ottelusivu, ajastushetki,
  käynnistysikkuna). Lue se ennen kuin kirjoitat ketjusta issueen, dokumenttiin
  tai koodikommenttiin; paljas "lähde-URL" on jo kaatanut kaksi dokumenttia.

Ketju **on ajettu läpi ohjaamon luomalla lähetysparilla kahdesti**: 31.7.2026
(ottelu 145918) ja 1.8.2026 (ottelu 136745, 104 min). Luonti, käsikäynnistys,
ajo ja itsesammutus toimivat molemmilla kerroilla, ja 1.8. myös raakalähetys
sulkeutui itsestään.

**Ajastimen automaattikäynnistystä ei ole yhä koeteltu livenä**, eikä hard
stopin siivousta — molemmat lopetukset tulivat normaalina `ended`-polkuna. Älä
esitä koettelematonta varmana; kerro mikä on koeteltu ja mikä ei.

Löydetyt viat: #154 (kunnarin selostus) ja #155 (preflight validoi väärää
ottelua). Myös #162 ja #165 — jotka osuivat **joka** ottelupäivänä — on nyt
korjattu, mutta **kumpaakaan korjausta ei ole koeteltu livenä**:

- **#162** (stream key ei tallentunut työhön) korjattiin #184:ssä: puuttuva
  `liveStreams.list`-rivi on virhe eikä hiljainen null, ja avain kirjoittuu
  työhön sellaisenaan. Käsin kirjoittamisen varapolkua ei ole — käsikentät
  poistuivat käyttöliittymästä (#176).
- **#165** (oletusvalinta osoitti eiliseen työhön) liukeni #183:ssa: valinnan
  totuuslähde on `getActiveJob`, joka ei tarjoa työtä jonka ottelu alkoi yli
  kuusi tuntia sitten. Erillistä ".env.relay" -nappia, joka aktivoi väärän työn,
  ei enää ole.

Molemmissa tapauksissa **#155:n sidontarivi on se, joka pysäyttää
käynnistyksen** ennen kuin selostus menee väärään otteluun. Se ei ole
vikailmoitus vaan viimeinen suoja — ja se korjaa nyt myös itse, kun kohteena on
operaattorin valitsema ottelu (#184).

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
### Ports on this server — check before you curl
| Port | What | Unit |
|---|---|---|
| 3000 | web app (selostus selaimessa) | `pesisselostaja.service` (user) |
| 3001 | **another project entirely** — do not touch | `finance-app-api.service` (system) |
| 3002 | **ohjaamo / control app** | `pesisselostaja-control.service` (user) |

The control app is on **3002**. The address to *use* (and to give the operator) is the
tailnet HTTPS address published by `tailscale serve` — run `tailscale serve status` to
get it; it is not written down here because this repo is public. HTTPS is required for
the iOS home-screen install and push notifications, so prefer it over `IP:3002`, which
works but is second-best.

Port 3001 has twice been assumed to be the control app: it belongs to an
unrelated service that answers with its own Fastify `404 Route not found` JSON, so the
mistake looks like a broken control app rather than a wrong port. `CONTROL_PORT`
defaults to 3002 in `apps/control/src/server/config.ts` and the unit sets it explicitly.

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

### Which build is being served

`apps/web`'s build bakes in the commit it came from (issue #71): the branch,
short SHA, whether the tree was dirty, and the build time. Two places to read
it, neither needing git:

- **`http://<host>:3000/version.json`** — emitted into `dist/` by the vite
  plugin, so `apps/server` serves it as an ordinary static file.
- **The app's Asetukset panel**, bottom line — the one that matters, because it
  is readable on the phone in the field.

`dirty: true` means the build came from a working tree with uncommitted
changes, i.e. it corresponds to no commit anywhere. That is the state that once
went unnoticed: the service kept serving a build carried over from a branch and
nothing in the UI said so.

Without git available the fields read `unknown` and the UI says "versio
tuntematon" — deliberately, rather than showing nothing.

## After completing a feature
1. Workspace `src/` changes build and commit themselves (hook above) — verify build was clean.
2. Commit other changes (tests, configs, docs) manually.
3. For web/server changes: `npm run build -w @pesisselostaja/web` (and `-w @pesisselostaja/server`
   if it changed), then restart: `systemctl --user restart pesisselostaja.service`
4. Confirm `systemctl --user is-active pesisselostaja.service` → `active`.

Do this automatically at the end of every successful feature, without waiting to be asked.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `midnight-builds/pesisselostaja` (`gh` CLI); ne
kirjoitetaan suomeksi, ja ulkoiset PR:t eivät ole triage-pinta. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles under their default names — `needs-triage`,
`needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` (not yet created in
GitHub). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `CONTEXT.md` (chain terms) plus the pesäpallo rules in
this file, `docs/adr/` for decisions. See `docs/agents/domain.md`.
