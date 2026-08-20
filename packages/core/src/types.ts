export type EventTextElement =
  | string
  | { type: "event"; text: string; base?: string | null }
  | { type: "player"; id?: number; number?: number; role?: string; team?: number; "settling-at-bat"?: boolean }
  | { type: "team"; id: number }
  // Lineup change: the API sends the whole new batting order (player ids as
  // strings) plus the pitcher. Not spoken — 11 numbers in a row is unlistenable
  // and would block the narration queue; see speech.ts dropDanglingClause.
  | { type: "substitution"; team?: number; newLineUp?: string[]; pitcher?: number }
  | { type: "stat"; score?: number; out?: number; [key: string]: unknown }
  | { hide?: boolean; type: "stat"; [key: string]: unknown };

export interface SubEvent {
  texts: EventTextElement[];
  runnersAtBases?: (number | null)[];
}

export interface LiveEvent {
  id: number | string;
  groupType: string;
  period: number;
  inning: number;
  batTurn: number;
  team: number | null;
  hTeam: number;
  batter: number | null;
  pairIndex: number | null;
  hitNumber: number | null;
  hit: string | null;
  events: SubEvent[];
  timestamp: number | null;
  updated?: number | null;
  /** Kirjaushetki unix-sekunteina (seinäkello, toisin kuin ottelunsisäinen
   *  `timestamp` joka on tällä syötteellä käytännössä aina null). Todennettu
   *  oikeasta datasta 30.7.2026 (ottelu 145900); optionaalinen koska kentän
   *  läsnäoloa kaikissa vastauksissa ei ole verifioitu (#119). */
  created?: number | null;
}

export interface LiveEventsResponse {
  events: LiveEvent[];
  period?: number;
  team?: number | null;
  bat_turn?: number;
  finished?: boolean;
  /** Delta (`after=`) queries only, and NOT a boolean despite reading like a
   *  flag: the server answers with the ISO instant its online data for this
   *  match was created / last rebuilt (e.g. "2026-07-27T18:25:29+03:00"), and
   *  it does so exactly when the requested `after` is OLDER than that instant.
   *  Such a response ignores `after` entirely and carries the COMPLETE event
   *  history — i.e. it already is a full fetch, and the client only has to
   *  replace its local history with it (verified live 2026-07-28 against a
   *  running match: `after` one second either side of the reported instant
   *  flipped the flag, and the reset response's event list matched the plain
   *  full fetch's). The period/team/inning fields are NOT a reset speciality:
   *  any response carrying events carries them too, and only an empty delta
   *  (nothing changed since `after`) leaves them null.
   *  Null/absent in normal responses. */
  reset?: string | boolean | null;
}

export interface Player {
  id: number;
  /** **Not a jersey number** — the player's position in the batting order at
   *  the moment the metadata was fetched (issue #241). Every roster observed
   *  runs 1..N in `players` order, and `/public/match` does not follow in-match
   *  lineup changes at all: match 136765's metadata still returned the
   *  pre-match order when fetched after the match had ended, though the event
   *  stream carried two `substitution` events reordering slots 7–11.
   *
   *  The field keeps the API's name because this type mirrors the wire format.
   *  Do not read it as a current position: `PlayerLookup.slotOf` (speech.ts) is
   *  maintained from the event stream and is the one that stays right. */
  number: number;
  name: string;
  first_name: string;
  last_name: string;
}

export interface Team {
  id: number;
  name: string;
  shorthand: string;
  players: Player[];
  all_players: number[];
}

export interface MatchResult {
  match_id: number;
  details: {
    periods_home: number;
    periods_away: number;
    [key: string]: unknown;
  };
}

export interface MatchMetadata {
  id: number;
  date: string;
  home: Team;
  away: Team;
  series: { custom_name?: string; name?: string };
  stadium: { name: string };
  result?: MatchResult;
  live: boolean;
  started: boolean;
}

export interface LiveMatchSummary {
  id: number;
  home: { id: number; name: string; shorthand: string };
  away: { id: number; name: string; shorthand: string };
  live: boolean;
  matchStatus: "live" | "upcoming" | "finished";
  startTime: string | null;
  seriesName?: string;
}

/** Miksi relayn lähdeajo päättyi. Tämä asuu coressa eikä relayssä, jotta
 *  ohjaamo voi vartioida kattavuutta käännösaikana: ohjaamo peilaa relayn
 *  telemetriaa käsin, ja juuri sellainen peilaus ajautui erilleen `ended`- ja
 *  `no_signal`-lähdetiloissa (#117). Kun molemmat puolet lukevat TÄTÄ tyyppiä,
 *  uusi arvo kaataa käännöksen molemmissa eikä putoa hiljaa defaulttiin.
 *
 *  - `ended`     — lähde päättyi hallitusti (kuvaaja lopetti).
 *  - `exhausted` — luovutusikkuna umpeutui tuloksettomien yritysten jälkeen.
 *  - `hard_stop` — takarajatarkastus sammutti ajon: ottelu päättynyt, ei uusia
 *                  tapahtumia ja lähde oireili (#123). */
export type SourceEndReason = "ended" | "exhausted" | "hard_stop";
