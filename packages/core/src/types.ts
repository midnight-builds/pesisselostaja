export type EventTextElement =
  | string
  | { type: "event"; text: string; base?: string | null }
  | { type: "player"; id?: number; number?: number; role?: string; team?: number; "settling-at-bat"?: boolean }
  | { type: "team"; id: number }
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
}

export interface LiveEventsResponse {
  events: LiveEvent[];
  period?: number;
  team?: number | null;
  bat_turn?: number;
  finished?: boolean;
  /** Set by the server on delta (`after=`) queries when the client should
   *  discard its local history and treat this response as authoritative —
   *  the pesistulokset.fi frontend handles the same flag. Null/absent in
   *  normal responses (observed live 2026-07-16). */
  reset?: boolean | null;
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
