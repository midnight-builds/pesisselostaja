# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

**Layout: single-context.** This is an npm-workspaces monorepo (`packages/core`,
`apps/web|broadcast|server|control`), but the domain is one: pesäpallo and the
broadcast chain. The vocabulary is shared across every workspace, so there is one
root `CONTEXT.md` — no `CONTEXT-MAP.md`.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the broadcast-chain terms (raakalähetys,
  selostettu lähetys, tulospalvelun ottelusivu, ajastushetki, käynnistysikkuna).
  Read it before writing about the chain anywhere; a bare "lähde-URL" has already
  caused confusion twice.
- **`CLAUDE.md`** at the repo root — the **pesäpallo** domain rules live here, not
  in `CONTEXT.md`: palo, tuoja vs. lyöjä, harhaheitto, periods/jaksot, and the
  scoring model (one marking = one run). When a pesäpallo detail isn't written
  down, **ask the user** rather than inferring it from baseball intuition.
- **`packages/core/README.md`** — the pesistulokset API surface (which paths need
  `?apikey=`, which don't). Read it before reverse-engineering `src/api.ts`.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT.md          ← broadcast-chain terms
├── CLAUDE.md           ← pesäpallo domain rules + repo operating rules
├── docs/adr/           ← architectural decisions (created lazily)
├── packages/core/
└── apps/{web,broadcast,server,control}/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
