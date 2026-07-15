import type { LiveEvent, SubEvent, EventTextElement, MatchMetadata, Player } from "./types.js";

export interface PlayerLookup {
  byId: Map<number, Player>;
  byTeamNumber: Map<string, Player>;
  /** Surnames shared by more than one player in the match (both rosters,
   *  case-insensitive) — these need the first name to stay unambiguous. */
  ambiguousSurnames: Set<string>;
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

export function buildPlayerLookup(meta: MatchMetadata): PlayerLookup {
  const byId = new Map<number, Player>();
  const byTeamNumber = new Map<string, Player>();
  const surnameCounts = new Map<string, number>();
  for (const team of [meta.home, meta.away]) {
    for (const p of team.players) {
      byId.set(p.id, p);
      byTeamNumber.set(`${team.id}:${p.number}`, p);
      const key = p.last_name.toLowerCase();
      surnameCounts.set(key, (surnameCounts.get(key) ?? 0) + 1);
    }
  }
  const ambiguousSurnames = new Set<string>();
  for (const [surname, count] of surnameCounts) {
    if (count > 1) ambiguousSurnames.add(surname);
  }
  return { byId, byTeamNumber, ambiguousSurnames };
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
    player = lookup.byTeamNumber.get(`${el.team}:${el.number}`);
  if (!player && "number" in el && el.number !== undefined) player = lookup.byId.get(el.number);
  if (!player) return null;
  const initial = player.first_name ? `${player.first_name.charAt(0)} ` : "";
  return `${player.number} ${initial}${player.last_name}`;
}

function getEventText(el: EventTextElement): string | null {
  if (typeof el === "string") return el;
  if (typeof el === "object" && el.type === "event" && "text" in el) return el.text;
  return null;
}

const FI_ORDINAL: Record<number, string> = {
  1: "ensimmäinen", 2: "toinen", 3: "kolmas", 4: "neljäs", 5: "viides",
  6: "kuudes", 7: "seitsemäs", 8: "kahdeksas", 9: "yhdeksäs", 10: "kymmenes",
  11: "yhdestoista", 12: "kahdestoista",
};

function ordinalPalo(n: number): string {
  const ord = FI_ORDINAL[n];
  return ord ? `${ord} palo` : `${n}. palo`;
}

function vuoropariLabel(inning: number, batTurn: number): string {
  const ord = FI_ORDINAL[inning + 1] ?? `${inning + 1}.`;
  const role = batTurn === 0 ? "aloittava" : "lopettava";
  return `${capitalize(ord)} vuoropari, ${role}.`;
}

/** Random pick among equivalent phrasings, to keep the narration varied.
 *  Never repeats the previous pick of the same group back to back, so the
 *  variation is actually audible (with 2 variants a plain draw repeats half
 *  the time). Group is a stable id per phrase family — the rendered strings
 *  can't key this, they change with names and scores. */
const lastVariantPick = new Map<string, number>();
function pickVariant(group: string, variants: string[]): string {
  if (variants.length === 1) return variants[0];
  const prev = lastVariantPick.get(group);
  let idx = Math.floor(Math.random() * variants.length);
  if (idx === prev) idx = (idx + 1) % variants.length;
  lastVariantPick.set(group, idx);
  return variants[idx];
}

function ttsClean(text: string): string {
  return text
    .replace(/\s*[–—]\s*/g, ", ")
    .replace(/\s*\/\s*/g, " tai ")
    .replace(/\s{2,}/g, " ")
    .trim();
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
      if (name) return pickVariant("batter", [`Vuorossa ${name}.`, `Nyt vuorossa ${name}.`, `Lyömässä ${name}.`]);
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
    return `${label} ${prev}:n vuoro päättyi. ${scoreStr} ${toBat}`;
  }
  if (next) {
    return `${label} ${scoreStr} Sisävuoroon ${next}.`;
  }
  return `${label} ${scoreStr}`;
}

export function formatSituationSummary(meta: MatchMetadata, ctx: SpeechContext): string {
  const parts: string[] = [`Menossa ${periodName(ctx.currentPeriod)}`];

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
  if (h === a) {
    return pickVariant("idle-tie", [
      `Tilanne on edelleen tasan ${h}, ${a}.`,
      `Ottelu jatkuu tasatilanteessa, ${h}, ${a}.`,
    ]);
  }
  const leader = h > a ? meta.home.shorthand : meta.away.shorthand;
  const adv = Math.abs(h - a) <= 2 ? "niukasti" : "reilusti";
  return pickVariant("idle", [
    `Tilanne on edelleen ${h}, ${a}, kun ${leader} johtaa peliä ${adv}.`,
    `Tilanne edelleen ${h}, ${a}, ${leader} johdossa ${adv}.`,
    `Ottelu jatkuu, ${leader} johtaa ${adv}, tilanne ${h}, ${a}.`,
  ]);
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
  const rawText = combined.join(" ").trim();
  if (!rawText) return null;

  if (rawText.includes("löi juoksun")) {
    const base = formatRunScored(texts, meta, lookup);
    return ctx ? `${base} ${formatScore(meta, ctx.periodHomeRuns, ctx.periodAwayRuns)}.` : base;
  }

  if (rawText.includes("löi kunnarin")) {
    const base = formatKunnari(texts, meta, lookup);
    return ctx ? `${base} ${formatScore(meta, ctx.periodHomeRuns, ctx.periodAwayRuns)}.` : base;
  }

  if (rawText.includes("toi juoksun")) {
    const base = formatRunBrought(texts, meta, lookup);
    return ctx ? `${base} ${formatScore(meta, ctx.periodHomeRuns, ctx.periodAwayRuns)}.` : base;
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
      return `${ttsClean(rawText)}.${verdict}`;
    }
    return `${ttsClean(rawText)}.`;
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
    return `${ttsClean(rawText)}.${standing}${pair}${batting}`;
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
    return ttsClean(rawText) + ".";
  }

  return null;
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
  return pickVariant("run-brought", [`${who} ${eventText}.`, `Juoksu! Tuojana ${who}.`]);
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

function formatMatchEnd(meta: MatchMetadata, ctx?: SpeechContext): string {
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
    return winner
      ? `Ottelu päättyi! ${winner} voitti, ${result}.`
      : `Ottelu päättyi! Tasatilanne, ${result}.`;
  }
  const result = meta.result;
  if (result) {
    const d = result.details;
    return `Ottelu päättyi! ${meta.home.shorthand} ${d.periods_home}, ${meta.away.shorthand} ${d.periods_away}.`;
  }
  return `Ottelu päättyi! ${meta.home.shorthand} vastaan ${meta.away.shorthand}.`;
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
