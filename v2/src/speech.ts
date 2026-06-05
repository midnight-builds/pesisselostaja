import type { LiveEvent, SubEvent, EventTextElement, MatchMetadata, Player } from "./types.js";

export interface PlayerLookup {
  byId: Map<number, Player>;
  byTeamNumber: Map<string, Player>;
}

export interface SpeechContext {
  periodHomeRuns: number;
  periodAwayRuns: number;
  homePeriodsWon: number;
  awayPeriodsWon: number;
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
  for (const team of [meta.home, meta.away]) {
    for (const p of team.players) {
      byId.set(p.id, p);
      byTeamNumber.set(`${team.id}:${p.number}`, p);
    }
  }
  return { byId, byTeamNumber };
}

export function getTeamName(meta: MatchMetadata, teamId: number | null): string {
  if (teamId === null) return "?";
  if (teamId === meta.home.id) return meta.home.shorthand;
  if (teamId === meta.away.id) return meta.away.shorthand;
  return "?";
}

function formatScore(meta: MatchMetadata, homeRuns: number, awayRuns: number): string {
  if (homeRuns > awayRuns) return `${homeRuns}, ${awayRuns}, ${meta.home.shorthand} johtaa`;
  if (awayRuns > homeRuns) return `${awayRuns}, ${homeRuns}, ${meta.away.shorthand} johtaa`;
  if (homeRuns === 0 && awayRuns === 0) return "nolla nolla";
  return `${homeRuns}, ${awayRuns}, tasatilanne`;
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
      if (name) return `Vuorossa ${name}.`;
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
    return `${label} ${prev}:n vuoro päättyi. ${scoreStr} Nyt sisävuoroon ${next}.`;
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
    if (ctx) {
      return `Palo! ${teamName}, ${ordinalPalo(ctx.currentOuts)}.`;
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
  if (eventText.includes("tuojana")) return `${batter} löi juoksun, tuojana ${runner}.`;
  return `${batter} ${eventText}.`;
}

function formatKunnari(texts: EventTextElement[], _meta: MatchMetadata, lookup: PlayerLookup): string {
  for (const el of texts) {
    if (typeof el === "object" && el.type === "player") {
      const name = resolvePlayerName(lookup, el);
      if (name) return `${name} löi kunnarin!`;
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
  return who ? `${who} ${eventText}.` : `${eventText}.`;
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
    const winner = ctx.homePeriodsWon > ctx.awayPeriodsWon
      ? meta.home.shorthand
      : ctx.awayPeriodsWon > ctx.homePeriodsWon ? meta.away.shorthand : null;
    const result = `${meta.home.shorthand} ${ctx.homePeriodsWon}, ${meta.away.shorthand} ${ctx.awayPeriodsWon}`;
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
  const prefix = `${event.inning}:${event.batTurn}:${event.id}`;
  if (!sub) return `${prefix}:${subIndex}`;
  return `${prefix}:${JSON.stringify(sub.texts)}`;
}

export function recomputeCurrentOuts(events: LiveEvent[]): number {
  let outs = 0;
  let team: number | null = null;
  for (const event of events) {
    if (event.team != null && event.team !== team) {
      team = event.team;
      outs = 0;
    }
    for (const sub of event.events) {
      if (isOutSubEvent(sub) && event.team !== null) outs++;
    }
  }
  return outs;
}
