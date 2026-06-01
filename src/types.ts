/** Raw event text element - either a plain string or a typed object */
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
    runs_home_first_period?: number;
    runs_away_first_period?: number;
    runs_home_second_period?: number;
    runs_away_second_period?: number;
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
  seriesName?: string;
}

export interface AppConfig {
  matchId: number;
  pollInterval: number;
  dryRun: boolean;
  announceBatterChanges: boolean;
  apiKey: string;
  apiBase: string;
  haUrl: string;
  haToken: string;
  haTtsEntity: string;
  haMediaPlayerEntity: string;
  stateFile: string;
}
