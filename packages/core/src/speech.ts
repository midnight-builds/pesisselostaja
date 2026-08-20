import type { LiveEvent, SubEvent, EventTextElement, MatchMetadata, Player } from "./types.js";
import { venueDisplayName } from "./venue.js";
import { finnishOrdinal } from "./numberSpeech.js";

export interface PlayerLookup {
  byId: Map<number, Player>;
  /** `teamId:slot` -> player, where slot is the player's **current position in
   *  the batting order** (1-based), NOT a jersey number. See `Player.number`
   *  in types.ts for why those are not the same thing (issue #241). Kept as a
   *  lookup because the API's `{type:"player", number, team}` elements are
   *  addressed by that pair. */
  byTeamSlot: Map<string, Player>;
  /** `teamId:playerId` -> current batting-order slot (1-based). The inverse of
   *  `byTeamSlot`, needed when rendering a known player's slot. */
  slotOf: Map<string, number>;
  /** Surnames shared by more than one player in the match (both rosters,
   *  case-insensitive) — these need the first name to stay unambiguous. */
  ambiguousSurnames: Set<string>;
}

function slotKey(teamId: number, playerId: number): string {
  return `${teamId}:${playerId}`;
}

export interface SpeechContext {
  periodHomeRuns: number;
  periodAwayRuns: number;
  homePeriodsWon: number;
  awayPeriodsWon: number;
  /** Distinct periods with any recorded runs. Camp/tournament matches are
   *  often a single jakso, where periodsWon is always 0-1 or 1-0 regardless
   *  of margin — formatMatchEnd needs this to know when to report the actual
   *  score instead. */
  periodsPlayed: number;
  currentOuts: number;
  currentPeriod: number;
  currentBatTeamId: number | null;
  currentInning: number;
  currentBatTurn: number;
}

/** Onko `event.period` **jakso** — eli 1. tai 2. jakso?
 *
 *  Repon termistö (CLAUDE.md, "Scoring"): 0 = 1. jakso, 1 = 2. jakso,
 *  **2 = supervuoro, 3 = kotiutuslyöntikilpailu**. Kaksi jälkimmäistä eivät ole
 *  jaksoja vaan ratkaisuvaiheita, joten "jaksojen välissä" ei tarkoita niitä.
 *  Tämä on olemassa siksi, että `currentPeriod`-vertailu näyttää muuten
 *  harmittomalta lukuvertailulta eikä paljasta mitä lukujen takana on. */
export function isJakso(period: number): boolean {
  return period === 0 || period === 1;
}

export function periodName(period: number): string {
  switch (period) {
    case 0: return "ensimmäinen jakso";
    case 1: return "toinen jakso";
    case 2: return "supervuoro";
    case 3: return "kotiutuslyöntikilpailu";
    default: return `jakso ${period + 1}`;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatPeriodsWon(meta: MatchMetadata, home: number, away: number): string {
  return `Jaksot ${meta.home.shorthand} ${home}, ${meta.away.shorthand} ${away}`;
}

/** The batting order as the metadata knew it *at fetch time*.
 *
 *  The slot is taken from the array index, not from `Player.number`. The two
 *  agree in every roster observed (`number` runs 1..N in `players` order), but
 *  only the index is a definition — `number` is a field whose meaning we
 *  already misread once (issue #241). */
export function buildPlayerLookup(meta: MatchMetadata): PlayerLookup {
  const byId = new Map<number, Player>();
  const byTeamSlot = new Map<string, Player>();
  const slotOf = new Map<string, number>();
  const surnameCounts = new Map<string, number>();
  for (const team of [meta.home, meta.away]) {
    team.players.forEach((p, index) => {
      byId.set(p.id, p);
      byTeamSlot.set(`${team.id}:${index + 1}`, p);
      slotOf.set(slotKey(team.id, p.id), index + 1);
      const key = p.last_name.toLowerCase();
      surnameCounts.set(key, (surnameCounts.get(key) ?? 0) + 1);
    });
  }
  const ambiguousSurnames = new Set<string>();
  for (const [surname, count] of surnameCounts) {
    if (count > 1) ambiguousSurnames.add(surname);
  }
  return { byId, byTeamSlot, slotOf, ambiguousSurnames };
}

/** The batting order carried by one `substitution` element, as player ids in
 *  slot order. Ids arrive as strings; empty/missing slots are dropped rather
 *  than shifting everyone below them, because a hole in the list would
 *  renumber players who did not move. */
function parseLineUp(newLineUp: (string | number | null)[] | undefined): number[] {
  return (newLineUp ?? [])
    .filter((id): id is string | number => id != null && id !== "")
    .map((id) => (typeof id === "string" ? Number(id) : id))
    .filter((id) => Number.isFinite(id));
}

/** A lookup with `teamId`'s batting order replaced by `lineUp` (player ids in
 *  slot order). Returns a new object; the input is not mutated.
 *
 *  This is the only correct source of the order once the match is running.
 *  `/public/match` does NOT follow in-match lineup changes — verified 6.8.2026
 *  against match 136765, whose metadata still returned the pre-match order when
 *  fetched *after* the match had ended. The event stream is all there is
 *  (issue #241). */
export function withLineup(
  lookup: PlayerLookup,
  teamId: number,
  lineUp: (string | number | null)[] | undefined
): PlayerLookup {
  const ids = parseLineUp(lineUp);
  if (ids.length === 0) return lookup;
  const byTeamSlot = new Map(lookup.byTeamSlot);
  const slotOf = new Map(lookup.slotOf);
  // Clear the team's old slots first: a shortened order must not leave the
  // dropped tail addressable at its former slot.
  for (const key of [...byTeamSlot.keys()]) {
    if (key.startsWith(`${teamId}:`)) byTeamSlot.delete(key);
  }
  for (const key of [...slotOf.keys()]) {
    if (key.startsWith(`${teamId}:`)) slotOf.delete(key);
  }
  ids.forEach((id, index) => {
    const slot = index + 1;
    slotOf.set(slotKey(teamId, id), slot);
    const player = lookup.byId.get(id);
    // An id outside the published roster (a jokeri, or anyone only listed in
    // `all_players`) has a slot but no name we can resolve — record the slot
    // anyway so the ORDER stays right, and let the name fall back.
    if (player) byTeamSlot.set(`${teamId}:${slot}`, player);
  });
  return { ...lookup, byTeamSlot, slotOf };
}

/** Applies every lineup change in `changes` (team id -> ids in slot order).
 *  Kept separate from `withLineup` so a caller that rebuilt the lookup from
 *  fresh metadata can replay the in-match changes it has already seen — a
 *  roster refresh would otherwise silently restore the pre-match order. */
export function withLineups(
  lookup: PlayerLookup,
  changes: ReadonlyMap<number, (string | number | null)[]>
): PlayerLookup {
  let out = lookup;
  for (const [teamId, lineUp] of changes) out = withLineup(out, teamId, lineUp);
  return out;
}

/** Every lineup change carried by these events, latest-per-team, in arrival
 *  order. Only the newest matters: each `newLineUp` is the complete order, not
 *  a delta. */
export function collectLineupChanges(
  events: LiveEvent[],
  into: Map<number, (string | number | null)[]> = new Map()
): Map<number, (string | number | null)[]> {
  for (const event of events) {
    for (const sub of event.events ?? []) {
      for (const el of sub.texts ?? []) {
        if (typeof el !== "object" || el === null || el.type !== "substitution") continue;
        if (el.team == null || !el.newLineUp) continue;
        if (parseLineUp(el.newLineUp).length === 0) continue;
        into.set(el.team, el.newLineUp);
      }
    }
  }
  return into;
}

/** Current batting-order slot of a known player, or null when the team is
 *  unknown or the player is not in the order (jokeri). */
export function slotOfPlayer(lookup: PlayerLookup, teamId: number | null | undefined, playerId: number): number | null {
  if (teamId == null) return null;
  return lookup.slotOf.get(slotKey(teamId, playerId)) ?? null;
}

export function getTeamName(meta: MatchMetadata, teamId: number | null): string {
  if (teamId === null) return "?";
  if (teamId === meta.home.id) return meta.home.shorthand;
  if (teamId === meta.away.id) return meta.away.shorthand;
  return "?";
}

function formatScore(meta: MatchMetadata, homeRuns: number, awayRuns: number): string {
  // Runs are always spoken home-first, in match order (koti ennen vierasta),
  // regardless of who leads — only the trailing verdict changes.
  if (homeRuns === 0 && awayRuns === 0) return "nolla nolla";
  const verdict = homeRuns > awayRuns ? `${meta.home.shorthand} johtaa`
    : awayRuns > homeRuns ? `${meta.away.shorthand} johtaa`
    : "tasatilanne";
  if (homeRuns === awayRuns) {
    return pickVariant("tie-score", [`${homeRuns}, ${awayRuns}, tasatilanne`, `tasan ${homeRuns}, ${awayRuns}`]);
  }
  return `${homeRuns}, ${awayRuns}, ${verdict}`;
}

function resolvePlayerName(lookup: PlayerLookup, el: EventTextElement): string | null {
  if (typeof el !== "object" || el.type !== "player") return null;
  let player = undefined as ReturnType<typeof lookup.byId.get>;
  if ("id" in el && el.id !== undefined) player = lookup.byId.get(el.id);
  if (!player && "number" in el && el.number !== undefined && "team" in el && el.team !== undefined)
    player = lookup.byTeamSlot.get(`${el.team}:${el.number}`);
  if (!player && "number" in el && el.number !== undefined) player = lookup.byId.get(el.number);
  if (!player) return null;
  // TTS swallows the raw "5 M Mäyrä" form — speak the surname alone, and
  // qualify with the first name only when the match has two players sharing
  // the surname (the API's first_name is the full name, not just an initial).
  if (lookup.ambiguousSurnames.has(player.last_name.toLowerCase())) {
    const team = typeof el === "object" && "team" in el ? el.team : undefined;
    const qualifier =
      player.first_name || String(slotOfPlayer(lookup, team, player.id) ?? player.number);
    return `${qualifier} ${player.last_name}`;
  }
  return player.last_name;
}

function getEventText(el: EventTextElement): string | null {
  if (typeof el === "string") return el;
  if (typeof el === "object" && el.type === "event" && "text" in el) return el.text;
  return null;
}

/** Finnish ordinal word, or null outside the supported 1–99 range so callers
 *  can fall back instead of throwing mid-narration. Ordinals are generated, not
 *  tabulated: palot have no ceiling (camp-format turns run until three palot
 *  *and* everyone has batted), and a table that stopped at 12 made the speech
 *  read "13. palo" (issue #50). */
function ordinalWord(n: number): string | null {
  return Number.isInteger(n) && n >= 1 && n <= 99 ? finnishOrdinal(n) : null;
}

const FI_CARDINAL: Record<number, string> = {
  1: "yksi", 2: "kaksi", 3: "kolme", 4: "neljä", 5: "viisi",
  6: "kuusi", 7: "seitsemän", 8: "kahdeksan", 9: "yhdeksän", 10: "kymmenen",
  11: "yksitoista", 12: "kaksitoista",
};

function ordinalPalo(n: number): string {
  const ord = ordinalWord(n);
  return ord ? `${ord} palo` : `${n}. palo`;
}

function vuoropariLabel(inning: number, batTurn: number): string {
  const ord = ordinalWord(inning + 1) ?? `${inning + 1}.`;
  const role = batTurn === 0 ? "aloittava" : "lopettava";
  return `${capitalize(ord)} vuoropari, ${role}.`;
}

/** Random pick among equivalent phrasings, to keep the narration varied.
 *  Never repeats the previous pick of the same group back to back, so the
 *  variation is actually audible (with 2 variants a plain draw repeats half
 *  the time). Group is a stable id per phrase family — the rendered strings
 *  can't key this, they change with names and scores.
 *
 *  **A variant may vary the WORDING, never the CONTENT.** The listener does not
 *  know which variant they got, so every variant of a group has to carry the
 *  same facts. Two thirds of the harhaheitto runs in match 144980 were narrated
 *  as a bare "juoksu" because two of three variants dropped the API's own
 *  phrase (issue #99), and four fifths of the idle fillers never said who was
 *  batting (issue #100). Both read as complete sentences, which is exactly why
 *  nobody noticed. `test/variantParity.test.ts` walks every variant of every
 *  group and fails if one drops a fact its siblings carry. */
const lastVariantPick = new Map<string, number>();
/** `allowed` rajaa arvonnan osajoukkoon ILMAN että ryhmä pilkotaan kahdeksi:
 *  "älä toista edellistä" -muisti on indeksipohjainen, joten eri mittaiset
 *  joukot samassa ryhmässä — tai sama joukko kahdessa ryhmässä — antaisivat
 *  saman tekstin kahdesti peräkkäin. Kutsupaikat vaimentavat peräkkäiset
 *  identtiset lauseet, joten toisinto ei kuuluisi toistona vaan katoaisi. */
function pickVariant(
  group: string,
  variants: string[],
  allowed?: (index: number) => boolean,
): string {
  if (variants.length === 1) return variants[0];
  const prev = lastVariantPick.get(group);
  const start = Math.floor(Math.random() * variants.length);
  let chosen = -1;
  let fallback = -1; // sallittu mutta sama kuin edellinen: parempi kuin ei mitään
  for (let step = 0; step < variants.length; step++) {
    const cand = (start + step) % variants.length;
    if (allowed && !allowed(cand)) continue;
    if (fallback < 0) fallback = cand;
    if (cand !== prev) {
      chosen = cand;
      break;
    }
  }
  if (chosen < 0) chosen = fallback >= 0 ? fallback : start;
  lastVariantPick.set(group, chosen);
  return variants[chosen];
}

function ttsClean(text: string): string {
  return text
    .replace(/\s*[–—]\s*/g, ", ")
    .replace(/\s*\/\s*/g, " tai ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Sub-event elements the renderer can't speak are dropped, which can leave the
 *  surrounding text hanging mid-sentence. A `substitution` element (the new
 *  batting order) leaves "X muutti lyöntijärjestystä. Uusi lyöntijärjestys:" —
 *  TTS then reads a bare colon and the listener hears half a sentence. Cut back
 *  to the last completed sentence; if nothing complete is left, say nothing at
 *  all. Guards every unrenderable element type, present and future — not just
 *  substitutions. */
function dropDanglingClause(text: string): string | null {
  const trimmed = text.trim();
  if (!/[:;,]$/.test(trimmed)) return trimmed || null;
  const cut = trimmed.replace(/[^.!?]*[:;,]$/, "").trim();
  return cut || null;
}

/** `<slot> <surname>` for the feed, or a bare id when the player is not in the
 *  published roster. `slot` is passed in rather than read off the player,
 *  because the caller usually knows a slot the lookup does not yet: the index
 *  in a `newLineUp` IS the new position, and that is the very line announcing
 *  it (issue #241 — the feed used to print each player's OLD slot next to the
 *  new order). Falls back to the player's current slot when the caller has
 *  none, and prints no number at all when neither is known. */
function feedPlayerLabel(
  lookup: PlayerLookup,
  teamId: number | null | undefined,
  id: string | number,
  slot?: number
): string {
  const playerId = typeof id === "string" ? Number(id) : id;
  const player = lookup.byId.get(playerId);
  if (!player) return `pelaaja ${id}`;
  const shown = slot ?? slotOfPlayer(lookup, teamId, playerId);
  return shown != null ? `${shown} ${player.last_name}` : player.last_name;
}

/** What the speech deliberately leaves unsaid, rendered for a reader. The feed
 *  mirrors the source data and only the speech trims and dedupes — dropping the
 *  lineup list from the narration (issue #48) must not drop it from the feed
 *  too (issue #74). Batting order as jersey number + surname, pitcher last.
 *  Null when the sub-event carries nothing the speech left out. */
export function subEventFeedDetail(sub: SubEvent, lookup: PlayerLookup): string | null {
  const parts: string[] = [];
  for (const el of sub.texts) {
    if (typeof el !== "object" || el === null || el.type !== "substitution") continue;
    // JSON tells "absent" and "null" apart while the optional-field types don't:
    // a match with no designated pitcher sends `pitcher: null`, which used to
    // render as "Lukkarina pelaaja null." Every id is checked with `!= null`,
    // including individual lineup slots.
    const ids = (el.newLineUp ?? []).filter((id) => id != null && id !== "");
    // Slot from the array index: this element IS the new order, so its own
    // positions are authoritative and need no lookup (issue #241).
    const lineUp = ids.map((id, index) => feedPlayerLabel(lookup, el.team, id, index + 1));
    if (lineUp.length > 0) parts.push(`Uusi lyöntijärjestys: ${lineUp.join(", ")}.`);
    if (el.pitcher != null) {
      const inNewOrder = ids.findIndex((id) => Number(id) === el.pitcher);
      const pitcherSlot = inNewOrder >= 0 ? inNewOrder + 1 : undefined;
      parts.push(`Lukkarina ${feedPlayerLabel(lookup, el.team, el.pitcher, pitcherSlot)}.`);
    }
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/** Feed line for a sub-event: the spoken sentence plus the payload the speech
 *  had to leave out. Takes the already-rendered speech instead of re-rendering
 *  it, so the feed shows exactly the phrasing that was spoken (pickVariant would
 *  otherwise roll a different variant). Null only when neither channel has
 *  anything to show. */
export function subEventToFeedText(
  speech: string | null,
  sub: SubEvent,
  lookup: PlayerLookup
): string | null {
  const detail = subEventFeedDetail(sub, lookup);
  if (!detail) return speech;
  return speech ? `${speech} ${detail}` : detail;
}

/** Terminates a sentence without doubling punctuation the source text already
 *  has (dropDanglingClause can cut back to a text that already ends in "."). */
function endSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function isBatterChangeSubEvent(sub: SubEvent): boolean {
  const firstText = sub.texts[0];
  if (typeof firstText === "string" && firstText.startsWith("Lyöntivuorossa")) return true;
  if (typeof firstText === "object" && "settling-at-bat" in firstText) return true;
  return false;
}

function formatBatterChangeSubEvent(sub: SubEvent, lookup: PlayerLookup): string | null {
  for (const el of sub.texts) {
    if (typeof el === "object" && el.type === "player") {
      const name = resolvePlayerName(lookup, el);
      // Weighted toward longer phrasings: ElevenLabs hallucinates extra
      // syllables at the start of very short inputs ("Lyömässä X." alone can
      // come out as "reewer lyömässä X") — more context stabilizes the
      // synthesis. Short forms stay in the pool but as
      // a minority.
      if (name) {
        return pickVariant("batter", [
          `Vuorossa ${name}.`,
          `Lyömässä ${name}.`,
          `Nyt vuorossa on ${name}.`,
          `Ja lyömässä nyt ${name}.`,
          `Seuraavaksi vuorossa ${name}.`,
          `Seuraavaksi lyömässä ${name}.`,
        ]);
      }
    }
  }
  return null;
}

const RUN_STAT_KEYS = ["score", "homerun", "walkscore", "wtscore"] as const;

export function runValueOfSubEvent(sub: SubEvent): number {
  for (const el of sub.texts) {
    if (typeof el !== "object" || el.type !== "stat") continue;
    const stat = el as Record<string, unknown>;
    if ("oscscore" in stat && typeof stat.oscscore === "number") return stat.oscscore;
    for (const k of RUN_STAT_KEYS) {
      if (k in stat) return 1;
    }
  }
  return 0;
}

export function isRunScoringSubEvent(sub: SubEvent): boolean {
  return runValueOfSubEvent(sub) > 0;
}

export function isOutSubEvent(sub: SubEvent): boolean {
  for (const el of sub.texts) {
    const t = getEventText(el);
    if (t && t.includes("Palo")) return true;
  }
  return false;
}

export function isMatchEndSubEvent(sub: SubEvent): boolean {
  for (const el of sub.texts) {
    if (getEventText(el) === "Ottelu päättyi") return true;
  }
  return false;
}

export function formatStartupSpeech(meta: MatchMetadata, ctx: SpeechContext): string {
  const parts: string[] = [`Seurataan ottelua ${meta.home.shorthand} vastaan ${meta.away.shorthand}.`];

  const hasProgress =
    ctx.currentPeriod > 0 || ctx.periodHomeRuns > 0 || ctx.periodAwayRuns > 0 ||
    ctx.homePeriodsWon > 0 || ctx.awayPeriodsWon > 0;
  if (hasProgress) {
    parts.push(`Menossa ${periodName(ctx.currentPeriod)}.`);
    parts.push(vuoropariLabel(ctx.currentInning, ctx.currentBatTurn));
  }

  const scoreStr = ctx.periodHomeRuns === 0 && ctx.periodAwayRuns === 0
    ? "Tilanne nolla nolla."
    : `${capitalize(formatScore(meta, ctx.periodHomeRuns, ctx.periodAwayRuns))}.`;
  parts.push(scoreStr);

  if (ctx.homePeriodsWon > 0 || ctx.awayPeriodsWon > 0) {
    parts.push(`${formatPeriodsWon(meta, ctx.homePeriodsWon, ctx.awayPeriodsWon)}.`);
  }
  if (ctx.currentBatTeamId) parts.push(`Sisävuorossa ${getTeamName(meta, ctx.currentBatTeamId)}.`);

  return parts.filter(Boolean).join(" ");
}

export function formatBatTurnChangeSpeech(
  meta: MatchMetadata,
  prevTeamId: number | null,
  nextTeamId: number | null,
  periodHomeRuns: number,
  periodAwayRuns: number,
  newInning: number,
  newBatTurn: number,
): string {
  const label = vuoropariLabel(newInning, newBatTurn);
  const prev = prevTeamId ? getTeamName(meta, prevTeamId) : null;
  const next = nextTeamId ? getTeamName(meta, nextTeamId) : null;
  const score = formatScore(meta, periodHomeRuns, periodAwayRuns);
  const scoreStr = `${capitalize(score)}.`;
  if (prev && next) {
    const toBat = pickVariant("to-bat", [
      `Nyt sisävuoroon ${next}.`,
      `${next} siirtyy sisävuoroon.`,
      `Seuraavaksi lyömään ${next}.`,
    ]);
    // No genitive: "KPL:n vuoro päättyi" is the abbreviation convention leaking
    // into every team name, and TTS reads the colon clumsily (issue #49).
    // Inflecting arbitrary Finnish team names (abbreviations, multi-word,
    // foreign) correctly isn't feasible — phrase around it instead.
    const ended = pickVariant("turn-ended", [
      `Vuoro päättyi, ${prev}.`,
      `${prev} lopetti vuoronsa.`,
      `Sisävuoro päättyi, ${prev}.`,
    ]);
    return `${label} ${ended} ${scoreStr} ${toBat}`;
  }
  if (next) {
    return `${label} ${scoreStr} Sisävuoroon ${next}.`;
  }
  return `${label} ${scoreStr}`;
}

export function formatSituationSummary(meta: MatchMetadata, ctx: SpeechContext): string {
  // Source attribution ("Tulospalvelun mukaan…") tells viewers where the data
  // comes from and why it trails the video; the duplicated plain variant keeps
  // it an occasional aside instead of a constant refrain.
  const lead = pickVariant("summary-attribution", ["Menossa", "Menossa", "Tulospalvelun mukaan menossa"]);
  const parts: string[] = [`${lead} ${periodName(ctx.currentPeriod)}`];

  if (ctx.periodHomeRuns > ctx.periodAwayRuns) {
    parts.push(`tilanne ${ctx.periodHomeRuns}, ${ctx.periodAwayRuns}, ${meta.home.shorthand} johtaa`);
  } else if (ctx.periodAwayRuns > ctx.periodHomeRuns) {
    parts.push(`tilanne ${ctx.periodHomeRuns}, ${ctx.periodAwayRuns}, ${meta.away.shorthand} johtaa`);
  } else {
    parts.push(`tilanne ${ctx.periodHomeRuns}, ${ctx.periodAwayRuns}, tasatilanne`);
  }

  let result = parts.join(", ") + ".";
  if (ctx.homePeriodsWon > 0 || ctx.awayPeriodsWon > 0) {
    result += ` ${formatPeriodsWon(meta, ctx.homePeriodsWon, ctx.awayPeriodsWon)}.`;
  }
  const batting = ctx.currentBatTeamId
    ? ` Sisävuorossa ${getTeamName(meta, ctx.currentBatTeamId)}, ${ctx.currentOuts} ${ctx.currentOuts === 1 ? "palo" : "paloa"}.`
    : "";
  return result + batting;
}

/**
 * Silence filler: spoken when nothing has happened for a while, so the
 * narration doesn't go dead. Phrased as "still the same situation" rather
 * than a fresh recap ({@link formatSituationSummary}).
 */
export function formatIdleSummary(meta: MatchMetadata, ctx: SpeechContext): string {
  const h = ctx.periodHomeRuns;
  const a = ctx.periodAwayRuns;
  // Light stat-style variant with the batting team included (user request)
  // — the clause is dropped when the batting team
  // isn't known, so the sentence stays complete either way. Score is always
  // home-first regardless of who leads.
  const batting = ctx.currentBatTeamId != null
    ? `, ja sisävuorossa on ${getTeamName(meta, ctx.currentBatTeamId)}.`
    : ".";
  // Every variant below carries the batting team (and, when someone leads, the
  // margin word): the filler is what a listener hears after a silent stretch,
  // so it is the worst possible place to leave out who is at bat (issue #100).
  if (h === a) {
    return pickVariant("idle-tie", [
      `Tilanne on edelleen tasan ${h}, ${a}${batting}`,
      `Ottelu jatkuu tasatilanteessa, ${h}, ${a}${batting}`,
      `Tulospalvelun mukaan tilanne on yhä tasan ${h}, ${a}${batting}`,
      `Tilasto kertoo tilanteeksi tasan ${h}, ${a}${batting}`,
    ]);
  }
  const leader = h > a ? meta.home.shorthand : meta.away.shorthand;
  const adv = Math.abs(h - a) <= 2 ? "niukasti" : "reilusti";
  return pickVariant("idle", [
    `Tilanne on edelleen ${h}, ${a}, kun ${leader} johtaa peliä ${adv}${batting}`,
    `Tilanne edelleen ${h}, ${a}, ${leader} johdossa ${adv}${batting}`,
    `Ottelu jatkuu, ${leader} johtaa ${adv}, tilanne ${h}, ${a}${batting}`,
    `Tulospalvelun mukaan tilanne on edelleen ${h}, ${a}, ${leader} johdossa ${adv}${batting}`,
    `Tilasto kertoo tilanteeksi ${h}, ${a}, ${leader} johtaa ${adv}${batting}`,
  ]);
}

/** Kenttänimi puhuttavaksi.
 *
 *  Delegoi `venueDisplayName`ille (venue.ts), joka siivoaa sekä putkiliitteen
 *  ("12 Tupos B | LEIRITUOTANTO") että kenttänumeron. Numero oli aiemmin
 *  mukana, ja puhuttuna se kuului muodossa "nolla viisi viiva Liperin
 *  kirkonkylän kenttä viisi" (#101). Sama siivous ajaa nyt ohjaamon
 *  otsikoissa (#132), jotta puhuttu ja kirjoitettu kenttänimi eivät eroa. */
export function stadiumSpeechName(rawName: string): string {
  return venueDisplayName(rawName);
}

/**
 * Pre-game filler: spoken periodically while waiting for the match's first
 * event, so a broadcast that starts well before the game isn't dead air.
 */
export function formatWelcomeFiller(meta: MatchMetadata): string {
  const pair = `${meta.home.name} vastaan ${meta.away.name}`;
  const stadium = stadiumSpeechName(meta.stadium.name);
  const at = stadium ? `, pelikenttänä ${stadium}` : "";
  return pickVariant("welcome", [
    `Tervetuloa seuraamaan ottelua ${pair}${at}.`,
    `Odottelemme pelin alkua. Vastakkain ${pair}${at}.`,
    `Ottelu ei ole vielä alkanut. ${pair}${at}.`,
  ]);
}

interface IntroVariant {
  text: string;
  /** Tosi, jos teksti viittaa aiempaan kertaan ("Muistutan että…"). Sellainen
   *  variantti EI kelpaa ottelun ensimmäiseksi esittelyksi: `pickVariant` on
   *  arpa, joten se voisi osua lähetyksen ensimmäiseksi lauseeksi, ja selostaja
   *  muistuttaisi asiasta jota se ei ole vielä kertonut. */
  assumesEarlierIntro: boolean;
}

/** Esittelyn variantit. Kaikki kertovat saman viiden asian — ks.
 *  {@link formatIntroFiller} ja `test/variantParity.test.ts`. */
const INTRO_VARIANTS: IntroVariant[] = [
  {
    text: "Minun puheeni on tuotettu keinotekoisesti ja luen ääneen pesistulokset.fi-palveluun kirjattuja tietoja. Pahoittelen jos välillä selostuksessani on aukkoja tai asiat tulevat väärään aikaan. Otan mielelläni palautetta vastaan, ja verkosta minut löytää nimellä Pesisselostaja.",
    assumesEarlierIntro: false,
  },
  {
    text: "Muistutan että puheeni on tuotettu keinotekoisesti: luen ääneen pesistulokset.fi-palveluun kirjattuja tietoja. Pahoittelen jos selostuksessani on välillä aukkoja tai asiat tulevat väärään aikaan. Otan mielelläni palautetta vastaan, ja verkosta minut löytää nimellä Pesisselostaja.",
    assumesEarlierIntro: true,
  },
  {
    text: "Luen ääneen pesistulokset.fi-palveluun kirjattuja tietoja, ja puheeni on tuotettu keinotekoisesti. Pahoittelen jos asiat tulevat väärään aikaan tai selostuksessani on välillä aukkoja. Otan mielelläni palautetta vastaan, ja verkosta minut löytää nimellä Pesisselostaja.",
    assumesEarlierIntro: false,
  },
];

/**
 * Selostajan esittely: koneellisesti tuotettu puhe, mihin se perustuu ja mistä
 * antaa palautetta. Puhutaan ottelun alussa ja jokaisen jaksonvaihteen jälkeen
 * kerran (issue #247).
 *
 * **Sanamuoto on käyttäjän antama** (Ossi 16.8.2026, issue #247) — ensimmäinen
 * variantti on se teksti sanatarkasti. Muut variantit vaihtavat vain
 * sanajärjestystä, jottei sama virke toistu identtisenä joka jaksotauolla; ne
 * kertovat kaikki saman viiden asian: puhe on keinotekoista, lähde on
 * pesistulokset.fi, aukoista ja ajoitusheitoista pahoitellaan, palautetta
 * otetaan vastaan ja verkosta löytyy nimellä Pesisselostaja.
 *
 * `firstOfMatch` kertoo, onko tämä ottelun ENSIMMÄINEN esittely. Silloin
 * arvonta rajataan variantteihin, jotka eivät oleta aiempaa kertaa — muuten
 * "Muistutan että…" voisi olla koko lähetyksen ensimmäinen lause. Kutsupaikka
 * tietää tämän `lastIntroPeriod === null` -tilasta. Myöhemmissä esittelyissä
 * koko joukko on käytettävissä.
 */
export function formatIntroFiller(firstOfMatch: boolean): string {
  return pickVariant(
    "intro",
    INTRO_VARIANTS.map((v) => v.text),
    firstOfMatch ? (i) => !INTRO_VARIANTS[i].assumesEarlierIntro : undefined,
  );
}

/** Mikä täyte on vuorossa, jos mikään:
 *  - `"welcome"` → {@link formatWelcomeFiller}, ennen ottelun alkua
 *  - `"intro"`   → {@link formatIntroFiller}, ottelun alussa ja jaksojen välissä
 *  - `"recap"`   → {@link formatSituationSummary}, kun puheita on kertynyt
 *  - `"idle"`    → {@link formatIdleSummary}, kun on ollut liian hiljaista
 *  - `null`      → ei mitään juuri nyt */
export type FillerDecision = "welcome" | "intro" | "recap" | "idle" | null;

/** Tilannekuva päätöstä varten. Pelkkiä lukuja ja lippuja — ei soittimia,
 *  ei syötettä, ei mykistystä. */
export interface FillerTimingState {
  /** Loppuselostus on annettu → selostus vaikenee kokonaan. */
  finished: boolean;
  /** Ottelu on käynnistynyt (ensimmäinen tapahtuma nähty). */
  matchStarted: boolean;
  /** Nykyhetki (ms). Annetaan argumenttina, jotta funktio pysyy puhtaana. */
  now: number;
  /** Milloin viimeksi puhuttiin (ms). */
  lastSpeechAt: number;
  /** Kuinka monta varsinaista selostusta on annettu. */
  announcementCount: number;
  /** `announcementCount` viimeisimmän tilannekatsauksen hetkellä. */
  lastSummaryCount: number;
  /** Käynnissä oleva jakso (`event.period`). Merkitsevä vasta kun
   *  `matchStarted` on tosi. */
  currentPeriod: number;
  /** Jakso, jolle esittely on jo puhuttu; `null` jos ei kertaakaan. Kutsupaikka
   *  päivittää tämän vasta kun esittely on oikeasti annettu, joten lykätty
   *  esittely jää odottamaan seuraavaa kierrosta eikä katoa. */
  lastIntroPeriod: number | null;
  /** Puhejono on tyhjä juuri nyt. Esittely ei saa kiilata tapahtumaselostusten
   *  väliin (issue #247), joten se odottaa hiljaista hetkeä; muut täytteet
   *  eivät lue tätä, koska niillä on jo oma porttinsa kutsupaikassa. */
  speechQueueEmpty: boolean;
}

/** Kynnykset annetaan argumentteina, koska ne EROAVAT sovelluksittain
 *  tarkoituksella: web käyttää 2 min hiljaisuusrajaa, broadcast 90 s (putken
 *  oma viive päälle laskettuna 2 min tuntui jo siltä kuin selostus olisi
 *  kuollut). Kumpi on oikein, on operaattorin päätös — älä yhtenäistä näitä
 *  tässä. */
export interface FillerThresholds {
  /** Ennen ottelua: tervetulotäytteen tahti (ms). */
  welcomeFillerMs: number;
  /** Ottelun aikana: hiljaisuuden raja, jonka jälkeen täyte (ms). */
  idleFillerMs: number;
  /** Joka n:s selostus laukaisee täyden tilannekatsauksen. */
  summaryEveryN: number;
}

/**
 * Hiljaisuustäytön ja tilannekatsauksen **ajastuspäätös** — sama sekä webissä
 * että lähetysputkessa (issue #62). Aiemmin tämä oli kahtena kopiona, ja
 * jatkomuutokset piti muistaa tehdä kahdesti.
 *
 * Funktio on puhdas: se vain kertoo *mikä* täyte olisi vuorossa. Kaikki
 * sivuvaikutukset — kirjanpidon päivitys, syötteeseen kirjoitus, mykistys ja
 * broadcastin `narrationReadyForFiller()`-portti — jäävät kutsupaikoille,
 * koska ne eroavat sovellusten välillä.
 */
export function decideFiller(
  state: FillerTimingState,
  thresholds: FillerThresholds,
): FillerDecision {
  // Loppuselostuksen jälkeen selostus vaikenee täysin: ei katsauksia eikä
  // täytteitä, ennen kuin ottelun jälkeinen pistemuutos herättää sen.
  if (state.finished) return null;
  // Ennen ottelua ei ole tilannetta katsattavaksi; pidetään odotus lämpimänä.
  if (!state.matchStarted) {
    return state.now - state.lastSpeechAt < thresholds.welcomeFillerMs
      ? null
      : "welcome";
  }
  // Esittely (issue #247): kerran ottelun alussa ja kerran jokaisen
  // jaksonvaihteen jälkeen — `currentPeriod` on avain, joten leirimuodossa,
  // jossa jaksoja on vain yksi, väliesittelyä ei tule lainkaan.
  //
  // VAIN JAKSOISSA. `event.period` on repon termistössä (CLAUDE.md, "Scoring")
  // 0 = 1. jakso, 1 = 2. jakso, 2 = supervuoro, 3 = kotiutuslyöntikilpailu.
  // Supervuoro ja kotiutuslyöntikilpailu EIVÄT ole jaksoja, ja issue #247
  // pyytää esittelyä "ottelun alussa ja jaksojen välissä" — ne ovat lisäksi
  // ottelun kireimmät kohdat, joihin parinkymmenen sekunnin puheenvuoro
  // osuisi pahiten. Älä "korjaa" tätä takaisin yleiseksi period-vertailuksi.
  //
  // Ehtona tyhjä puhejono: esittely on parinkymmenen sekunnin puheenvuoro,
  // eikä se saa asettua tapahtumaselostusten väliin. Kun jono ei ole tyhjä,
  // tämä ei "kuluta" esittelyä vaan putoaa läpi tavallisiin täytteisiin, ja
  // esittely jää odottamaan seuraavaa hiljaista kierrosta.
  //
  // Voittaa katsauksen ja täytteen: esittely on kertaluontoinen ja sidottu
  // juuri tähän kohtaan ottelua, katsaus ja täyte toistuvat joka tapauksessa.
  if (
    isJakso(state.currentPeriod) &&
    state.lastIntroPeriod !== state.currentPeriod &&
    state.speechQueueEmpty
  ) {
    return "intro";
  }
  if (state.announcementCount === 0) return null;
  const countDue =
    state.announcementCount - state.lastSummaryCount >= thresholds.summaryEveryN;
  const idleDue = state.now - state.lastSpeechAt > thresholds.idleFillerMs;
  // Katsaus voittaa täytteen, kun molemmat erääntyvät samalla kierroksella.
  if (countDue) return "recap";
  if (idleDue) return "idle";
  return null;
}

export function subEventToSpeech(
  event: LiveEvent,
  sub: SubEvent,
  meta: MatchMetadata,
  lookup: PlayerLookup,
  announceBatterChanges = true,
  ctx?: SpeechContext
): string | null {
  if (isBatterChangeSubEvent(sub)) {
    return announceBatterChanges ? formatBatterChangeSubEvent(sub, lookup) : null;
  }

  const texts = sub.texts;
  const eventTexts: string[] = [];
  const players: string[] = [];

  for (const el of texts) {
    if (typeof el === "object" && "hide" in el && el.hide) continue;
    if (typeof el === "object" && el.type === "stat") continue;

    const evText = getEventText(el);
    if (evText) { eventTexts.push(evText); continue; }

    const playerName = resolvePlayerName(lookup, el);
    if (playerName) { players.push(playerName); continue; }

    if (typeof el === "object" && el.type === "team") {
      eventTexts.push(getTeamName(meta, el.id));
      continue;
    }
    if (typeof el === "string") eventTexts.push(el);
  }

  const combined = [...eventTexts, ...players].filter(Boolean);
  if (combined.length === 0) return null;
  const rawText = dropDanglingClause(combined.join(" "));
  if (!rawText) return null;

  // The appended score starts a new sentence after the run phrase, so it must
  // be capitalized — the tie variant used to leak through lowercase ("…
  // tuojana X. tasan 7, 7.").
  if (rawText.includes("löi juoksun")) {
    const base = formatRunScored(texts, meta, lookup);
    return withRunCountAndScore(base, sub, meta, ctx);
  }

  if (rawText.includes("löi kunnarin")) {
    const base = formatKunnari(texts, meta, lookup);
    return withRunCountAndScore(base, sub, meta, ctx);
  }

  if (rawText.includes("toi juoksun")) {
    const base = formatRunBrought(texts, meta, lookup);
    return withRunCountAndScore(base, sub, meta, ctx);
  }

  if (rawText.includes("Palo")) {
    const teamName = getTeamName(meta, event.team);
    // Full stops (not commas) between the parts so TTS reads it calmly with a
    // pause between each, instead of rattling "Palo KPL kolmas palo" off as one.
    if (ctx) {
      return pickVariant("palo", [
        `Palo! ${teamName}. ${capitalize(ordinalPalo(ctx.currentOuts))}.`,
        `Joukkueen ${teamName} ${ordinalPalo(ctx.currentOuts)}!`,
      ]);
    }
    return `Palo! ${teamName}.`;
  }

  if (rawText.includes("päättyi") && (rawText.includes("jakso") || rawText.includes("Supervuoro"))) {
    if (ctx) {
      const score = `${ctx.periodHomeRuns}, ${ctx.periodAwayRuns}`;
      const winner = ctx.periodHomeRuns > ctx.periodAwayRuns ? meta.home.shorthand
        : ctx.periodAwayRuns > ctx.periodHomeRuns ? meta.away.shorthand : null;
      const verdict = winner ? ` ${winner} voitti, ${score}.` : ` Tasan, ${score}.`;
      return `${endSentence(ttsClean(rawText))}${verdict}`;
    }
    return endSentence(ttsClean(rawText));
  }

  if (rawText.includes("alkoi") && (rawText.includes("jakso") || rawText.includes("Supervuoro"))) {
    const standing = ctx && (ctx.homePeriodsWon > 0 || ctx.awayPeriodsWon > 0)
      ? ` ${formatPeriodsWon(meta, ctx.homePeriodsWon, ctx.awayPeriodsWon)}.`
      : "";
    const pair = ctx && rawText.includes("jakso")
      ? ` ${vuoropariLabel(ctx.currentInning, ctx.currentBatTurn)}`
      : "";
    const batting = ctx?.currentBatTeamId
      ? ` Sisävuorossa ${getTeamName(meta, ctx.currentBatTeamId)}.`
      : "";
    return `${endSentence(ttsClean(rawText))}${standing}${pair}${batting}`;
  }

  if (rawText === "Ottelu alkoi") {
    return `Ottelu alkoi! ${meta.home.shorthand} vastaan ${meta.away.shorthand}.`;
  }
  if (rawText === "Ottelu päättyi") {
    return formatMatchEnd(meta, ctx);
  }

  if (event.id === "drawofchoice") {
    return formatDrawOfChoice(texts, meta, lookup);
  }

  if (eventTexts.some((t) => t.length > 3)) {
    return endSentence(ttsClean(rawText));
  }

  return null;
}

/** Closes a run announcement: the run COUNT when the marking brought more than
 *  one, then the score.
 *
 *  One marking usually means one run, and every run phrase is written in the
 *  singular — but `oscscore` can be 2 or more (rare, confirmed by the user
 *  29.7.2026), and then the scoreboard jumps further than the sentence
 *  explains. Saying the number out loud is the only way a listener can follow
 *  the score they are about to hear. */
function withRunCountAndScore(
  base: string,
  sub: SubEvent,
  meta: MatchMetadata,
  ctx: SpeechContext | undefined
): string {
  const runs = runValueOfSubEvent(sub);
  const count = runs > 1 ? ` ${capitalize(FI_CARDINAL[runs] ?? String(runs))} juoksua.` : "";
  if (!ctx) return `${base}${count}`;
  return `${base}${count} ${capitalize(formatScore(meta, ctx.periodHomeRuns, ctx.periodAwayRuns))}.`;
}

/** The batter's own jersey number in a "löi juoksun"/"löi kunnarin" marking,
 *  or null when the marking is not one of those. The batter is the FIRST
 *  player element — the same positional convention formatRunScored relies on;
 *  in the live data it additionally carries `role: "batter"`, but only on the
 *  "löi juoksun" markings, not on the kunnari one, so position is what can
 *  actually be compared across the two. */
function batterKeyOfHit(sub: SubEvent): string | null {
  let text = "";
  let first: EventTextElement | null = null;
  for (const el of sub.texts) {
    if (typeof el !== "object") continue;
    if (el.type === "event" && "text" in el) text = el.text;
    if (el.type === "player" && first === null) first = el;
  }
  if (!text.includes("löi juoksun") && !text.includes("löi kunnarin")) return null;
  if (first === null || typeof first !== "object" || first.type !== "player") return null;
  const p = first as { id?: number; number?: number; team?: number };
  // `id` and `number` are different namespaces — resolvePlayerName treats them
  // as overlapping on purpose, but a KEY may not: `{id: 12}` and `{number: 12}`
  // can be two different people, and merging them would attribute one player's
  // hit to another. Tagged, so they can never collide.
  if (p.id != null) return `${p.team ?? ""}:id:${p.id}`;
  if (p.number != null) return `${p.team ?? ""}:num:${p.number}`;
  return null;
}

/** Splits one event's sub-events into the units that get ONE sentence each
 *  (issue #154).
 *
 *  The scorer records every runner who reached home as its own marking, so a
 *  kunnari that cleared the bases arrives as three "X löi juoksun, tuojana …"
 *  plus one "X löi kunnarin" — four markings, one swing. Spoken one by one
 *  they were four sentences in the same second, each naming a different tuoja,
 *  and the listener heard four hits. Measured live on 31.7.2026 (match 145918,
 *  10.55.35): six lines within two seconds.
 *
 *  Grouped: consecutive markings of the same event that name the SAME batter
 *  and are of the "löi …" family. That is exactly what one swing looks like in
 *  the data — verified against match 145918, where every multi-marking hit
 *  landed inside a single event with a repeated batter.
 *
 *  NOT grouped, deliberately: `toi juoksun` (harhaheitto / vapaataival) has no
 *  batter to be the same, and two of those in a row are genuinely two separate
 *  things that happened. Palot, batter changes and everything else keep their
 *  own sentence.
 *
 *  Returns index groups rather than merged sub-events, because every caller
 *  still has to walk the ORIGINAL markings: the score counts one run per
 *  marking, and the seen-fingerprint has to be marked per index or the tail of
 *  a group is re-announced on the next poll. */
export function groupSubEventsForSpeech(subs: SubEvent[]): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  let currentBatter: string | null = null;
  for (let i = 0; i < subs.length; i++) {
    const batter = batterKeyOfHit(subs[i]);
    if (batter !== null && batter === currentBatter) {
      current.push(i);
      continue;
    }
    if (current.length > 0) groups.push(current);
    current = [i];
    currentBatter = batter;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** "A", "A ja B", "A, B ja C" — a Finnish list, for the tuojat of one hit.
 *  The operator's decision (31.7.2026) was explicit: read every one of them,
 *  even when a shorter phrasing was on offer. Getting home as a tuoja is the
 *  highlight of a child's match, and hearing the name is what the broadcast is
 *  for. */
function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} ja ${names[names.length - 1]}`;
}

/** One sentence for one swing that produced several markings. */
function formatMultiRunHit(
  subs: SubEvent[],
  lookup: PlayerLookup,
  hasKunnari: boolean
): string {
  let batter: string | null = null;
  const runners: string[] = [];
  for (const sub of subs) {
    const names: string[] = [];
    let players = 0;
    for (const el of sub.texts) {
      if (typeof el === "object" && el.type === "player") {
        players++;
        const name = resolvePlayerName(lookup, el);
        // "?" rather than nothing when a name won't resolve: the relay fetches
        // the roster once at startup, and starting before the lineup is
        // published leaves every name unresolvable for the whole match
        // (reference-lineups-published-late). Dropping the element there would
        // silently shorten the sentence — and an earlier version dropped the
        // whole group, kunnari included.
        names.push(name ?? "?");
      }
    }
    if (batter === null) batter = names[0] ?? null;
    // The kunnari marking names only the batter — he brings himself home, so
    // there is no tuoja to add (CLAUDE.md: the tuoja is the runner who gets
    // from 3. pesä to kotipesä).
    if (players > 1) {
      // A scorer double-marking repeats the same runner; naming them twice in
      // one sentence ("tuojina Ilves ja Ilves") reads as two people. The feed
      // still mirrors both markings.
      if (runners[runners.length - 1] !== names[1]) runners.push(names[1]);
    }
  }
  if (!batter) batter = "?";
  const tuojat = runners.length === 0 ? "" : runners.length === 1 ? `, tuojana ${runners[0]}` : `, tuojina ${listNames(runners)}`;
  if (hasKunnari) {
    return pickVariant("kunnari-multi", [
      `Kunnari! Sen löi ${batter}${tuojat}.`,
      `${batter} löi kunnarin${tuojat}!`,
      `Kunnarilla juoksuja: lyöjänä ${batter}${tuojat}.`,
    ]);
  }
  return pickVariant("run-scored-multi", [
    `${batter} löi juoksut${tuojat}.`,
    `Juoksut löi ${batter}${tuojat}.`,
    `Tulospalveluun on kirjattu juoksut: ne löi ${batter}${tuojat}.`,
  ]);
}

/** Speech for one group from groupSubEventsForSpeech: a single marking behaves
 *  exactly as before, several markings of one swing become one sentence.
 *
 *  The run count is the sum over the group, not one marking's value, so
 *  "Neljä juoksua." matches the jump the listener is about to hear in the
 *  score. */
export function groupToSpeech(
  event: LiveEvent,
  subs: SubEvent[],
  indexes: number[],
  meta: MatchMetadata,
  lookup: PlayerLookup,
  announceBatterChanges = true,
  ctx?: SpeechContext
): string | null {
  if (indexes.length === 1) {
    return subEventToSpeech(event, subs[indexes[0]], meta, lookup, announceBatterChanges, ctx);
  }
  const group = indexes.map((i) => subs[i]);
  const hasKunnari = group.some((sub) =>
    sub.texts.some((el) => typeof el === "object" && el.type === "event" && "text" in el && el.text.includes("löi kunnarin"))
  );
  const base = formatMultiRunHit(group, lookup, hasKunnari);
  const runs = group.reduce((sum, sub) => sum + runValueOfSubEvent(sub), 0);
  const count = runs > 1 ? ` ${capitalize(FI_CARDINAL[runs] ?? String(runs))} juoksua.` : "";
  if (!ctx) return `${base}${count}`;
  return `${base}${count} ${capitalize(formatScore(meta, ctx.periodHomeRuns, ctx.periodAwayRuns))}.`;
}

function formatRunScored(texts: EventTextElement[], _meta: MatchMetadata, lookup: PlayerLookup): string {
  const players: string[] = [];
  let eventText = "";
  for (const el of texts) {
    if (typeof el === "object" && el.type === "player") {
      const name = resolvePlayerName(lookup, el);
      if (name) players.push(name);
    }
    if (typeof el === "object" && el.type === "event" && "text" in el) eventText = el.text;
  }
  const batter = players[0] ?? "?";
  const runner = players[1] ?? "?";
  if (eventText.includes("tuojana")) {
    return pickVariant("run-scored", [
      `${batter} löi juoksun, tuojana ${runner}.`,
      `Juoksun löi ${batter}, tuojana ${runner}.`,
      `Tulospalveluun on kirjattu juoksu: sen löi ${batter}, tuojana ${runner}.`,
    ]);
  }
  return `${batter} ${eventText}.`;
}

function formatKunnari(texts: EventTextElement[], _meta: MatchMetadata, lookup: PlayerLookup): string {
  for (const el of texts) {
    if (typeof el === "object" && el.type === "player") {
      const name = resolvePlayerName(lookup, el);
      if (name) {
        return pickVariant("kunnari", [
          `${name} löi kunnarin!`,
          `Kunnari! Sen löi ${name}.`,
          `${name} lyö kunnarin!`,
        ]);
      }
    }
  }
  return "Kunnari!";
}

function formatRunBrought(texts: EventTextElement[], _meta: MatchMetadata, lookup: PlayerLookup): string {
  let eventText = "";
  const players: string[] = [];
  for (const el of texts) {
    if (typeof el === "object" && el.type === "event" && "text" in el) eventText = el.text;
    if (typeof el === "object" && el.type === "player") {
      const name = resolvePlayerName(lookup, el);
      if (name) players.push(name);
    }
  }
  const who = players[0] ?? "";
  if (!who) return `${eventText}.`;
  // The source ships a finished Finnish phrase ("toi juoksun harhaheitolla"),
  // and it is the only place the LISTENER learns how the run came about — a
  // variant that replaces it with a bare "Juoksu!" invents nothing and loses
  // everything (issue #99). So every variant speaks eventText verbatim.
  return pickVariant("run-brought", [
    `${who} ${eventText}.`,
    `Ja ${who} ${eventText}.`,
    `Tulospalveluun kirjattu: ${who} ${eventText}.`,
  ]);
}

function formatDrawOfChoice(texts: EventTextElement[], meta: MatchMetadata, lookup: PlayerLookup): string {
  const parts: string[] = [];
  for (const el of texts) {
    if (typeof el === "string") parts.push(el);
    else if (typeof el === "object" && el.type === "team") parts.push(getTeamName(meta, el.id));
    else if (typeof el === "object" && el.type === "player") {
      const name = resolvePlayerName(lookup, el);
      if (name) parts.push(name);
    }
  }
  return ttsClean(parts.join(" ")) + ".";
}

/** Also exported for the broadcast relay's first-attach recap: if the match
 *  ended while narration was still suppressed (ffmpeg never attached in time),
 *  the connect-moment recap must speak this same closing line instead of a
 *  mid-game situation summary. */
export function formatMatchEnd(meta: MatchMetadata, ctx?: SpeechContext): string {
  // The closing announcement is the last thing the audience hears (narration
  // goes silent after it), so thank them here.
  const thanks = pickVariant("thanks-viewers", [
    "Kiitos katsojille.",
    "Kiitokset kaikille katsojille.",
    "Kiitos, että olitte mukana.",
  ]);
  if (ctx) {
    // A single-jakso match (camps/tournaments) never reaches a second period,
    // so periodsWon is always 0-1 or 1-0 regardless of margin — report the
    // actual score instead. Multi-jakso matches are decided by periods won,
    // not summed runs, so that stays the headline number there.
    const [homeVal, awayVal] = ctx.periodsPlayed <= 1
      ? [ctx.periodHomeRuns, ctx.periodAwayRuns]
      : [ctx.homePeriodsWon, ctx.awayPeriodsWon];
    const winner = homeVal > awayVal ? meta.home.shorthand : awayVal > homeVal ? meta.away.shorthand : null;
    const result = `${meta.home.shorthand} ${homeVal}, ${meta.away.shorthand} ${awayVal}`;
    const headline = winner
      ? `Ottelu päättyi! ${winner} voitti, ${result}.`
      : `Ottelu päättyi! Tasatilanne, ${result}.`;
    return `${headline} ${formatMatchEndRecap(ctx)} ${thanks}`;
  }
  const result = meta.result;
  if (result) {
    const d = result.details;
    return `Ottelu päättyi! ${meta.home.shorthand} ${d.periods_home}, ${meta.away.shorthand} ${d.periods_away}. ${thanks}`;
  }
  return `Ottelu päättyi! ${meta.home.shorthand} vastaan ${meta.away.shorthand}. ${thanks}`;
}

/** One-off closing recap appended to the match-end announcement — after it the
 *  loops go silent (only a reopened, changed score wakes them again). Match
 *  formats vary: camp games are often a single jakso, so report vuoroparit
 *  there and jaksot/decider elsewhere. */
function formatMatchEndRecap(ctx: SpeechContext): string {
  if (ctx.currentPeriod === 3) return "Ratkaisu syntyi kotiutuslyöntikilpailussa.";
  if (ctx.currentPeriod === 2) return "Ratkaisu syntyi supervuorossa.";
  if (ctx.periodsPlayed > 1) {
    const word = FI_CARDINAL[ctx.periodsPlayed] ?? String(ctx.periodsPlayed);
    return `Ottelussa pelattiin ${word} jaksoa.`;
  }
  const pairs = ctx.currentInning + 1;
  if (pairs === 1) return "Ottelussa pelattiin yksi vuoropari.";
  const word = FI_CARDINAL[pairs] ?? String(pairs);
  return `Ottelussa pelattiin ${word} vuoroparia.`;
}

export function eventFingerprint(event: LiveEvent, subIndex: number): string {
  const sub = event.events[subIndex];
  // event.id restarts at 0 every turn and palot reset every turn, so the first
  // palo of two different vuoroparit share both id and texts (`Palo` + out:1).
  // The turn coordinates (period/inning/batTurn/team) are what tell them apart —
  // without them the later palo collides on an already-seen fingerprint and is
  // silently dropped from the feed and speech (scoreboard still counts it, since
  // that recomputes from the raw stream — hence "palo näkyy herossa muttei
  // teksteissä").
  //
  // Exception: kotiutuslyöntikilpailu (period 3). There the API briefly re-keys
  // a turn-ending palo into the next sisävuoro; including the coordinates would
  // give that transient a fresh fingerprint and double-announce it. Palot don't
  // recur across turns there the way they do in normal vuoroparit, so the
  // coordinate-free key is both safe and necessary in that period. See 38d30cc.
  const coords = event.period === 3
    ? ""
    : `${event.period}:${event.inning}:${event.batTurn}:${event.team}:`;
  if (!sub) return `${coords}${event.id}:${subIndex}`;
  return `${coords}${event.id}:${subIndex}:${JSON.stringify(sub.texts)}`;
}

/** True when two events belong to the same batting turn (per API fields). */
function sameTurn(a: LiveEvent, b: LiveEvent): boolean {
  return a.period === b.period && a.inning === b.inning && a.batTurn === b.batTurn && a.team === b.team;
}

/**
 * Palot in the current turn. Palot reset every turn, so we count out sub-events
 * only in the latest turn — identified by the API's (period, inning, batTurn,
 * team) on each event, never guessed. Single source of truth for both the
 * scoreboard and the spoken ordinal (see {@link outsThroughSubEvent}).
 */
export function recomputeCurrentOuts(events: LiveEvent[]): number {
  return recomputeCurrentOutsKeyed(events).outs;
}

/**
 * Like {@link recomputeCurrentOuts} but also returns a stable key identifying the
 * turn it counted (the `last` event's period/inning/batTurn/team). The watcher uses
 * the key to keep the scoreboard's palot monotonic within a turn: the API briefly
 * re-keys a turn-ending palo into the next sub-inning, which would otherwise make the
 * count rewind mid-turn (e.g. 3 → 2) after the palo was already announced.
 */
export function recomputeCurrentOutsKeyed(events: LiveEvent[]): { outs: number; turnKey: string | null } {
  let last: LiveEvent | null = null;
  for (const e of events) if (e.team != null) last = e;
  if (!last) return { outs: 0, turnKey: null };
  let outs = 0;
  for (const e of events) {
    if (e.team == null || !sameTurn(e, last)) continue;
    for (const sub of e.events) if (isOutSubEvent(sub)) outs++;
  }
  return { outs, turnKey: `${last.period}:${last.inning}:${last.batTurn}:${last.team}` };
}

/**
 * The out count in the current turn up to and including
 * `events[eventIdx].events[subIdx]` — i.e. the palo's ordinal at the moment it
 * happens. Computed from the same turn-key logic as {@link recomputeCurrentOuts}
 * so the spoken "kolmas palo" can never disagree with the scoreboard.
 */
export function outsThroughSubEvent(events: LiveEvent[], eventIdx: number, subIdx: number): number {
  const target = events[eventIdx];
  if (!target || target.team == null) return 0;
  let outs = 0;
  for (let ei = 0; ei <= eventIdx; ei++) {
    const e = events[ei];
    if (e.team == null || !sameTurn(e, target)) continue;
    const limit = ei === eventIdx ? subIdx + 1 : e.events.length;
    for (let si = 0; si < limit; si++) {
      if (isOutSubEvent(e.events[si])) outs++;
    }
  }
  return outs;
}
