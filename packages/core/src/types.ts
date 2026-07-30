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
