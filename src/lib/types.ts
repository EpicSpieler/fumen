/* Shapes shared with the Rust backend (see src-tauri/src/library.rs, lib.rs). */

export type Mode = 0 | 1 | 2 | 3;

export interface SetRow {
  id: string;
  onlineId?: number;
  status: number;
  added?: number;
  ranked?: number;
  title: string;
  titleUnicode?: string;
  artist: string;
  artistUnicode?: string;
  creator: string;
  source?: string;
  tags?: string;
  bg?: string;
  audio?: string;
  preview?: number;
  protected?: boolean;
  /** indices into Snapshot.maps */
  maps: number[];
}

export interface BestScore {
  /** lazer ScoreRank: -1 F, 0 D, 1 C, 2 B, 3 A, 4 S, 5 SH, 6 X, 7 XH */
  rank: number;
  acc: number;
  score: number;
  plays: number;
  last?: number;
}

export interface MapRow {
  /** index into Snapshot.sets */
  set: number;
  id: string;
  onlineId?: number;
  version: string;
  /** 0 osu, 1 taiko, 2 catch, 3 mania, -1 custom */
  mode: number;
  ruleset?: string;
  status: number;
  sr: number;
  bpm: number;
  /** ms */
  length: number;
  objects: number;
  /** long notes (mania) / sliders + spinners */
  holds: number;
  hp: number;
  cs: number;
  od: number;
  ar: number;
  bg?: string;
  audio?: string;
  preview?: number;
  played?: number;
  hidden?: boolean;
  best?: BestScore;
  /** densest two seconds in notes per second (chart analysis) */
  peak?: number;
  /** pattern tags from the chart analysis, space-separated (osu!mania) */
  patterns?: string;
  /** osu!mania star rating with Half Time (0.75×) / Double Time (1.5×), Fumen's own calculation */
  srHt?: number;
  srDt?: number;
}

export interface CollectionRow {
  id: string;
  name: string;
  maps: number[];
  missing: number;
}

export interface Snapshot {
  source: "lazer";
  scannedAt?: number;
  sets: SetRow[];
  maps: MapRow[];
  collections: CollectionRow[];
  /** owner of the local scores, if any */
  user?: { name: string; id?: number };
}

export type PatternName = "stream" | "jumpstream" | "handstream" | "chordjack" | "jacks" | "ln";

export interface ChartAnalysis {
  /** first object / end of the last object, ms */
  start: number;
  end: number;
  /** playable ms (minus breaks) */
  drain: number;
  notes: number;
  holds: number;
  npsAvg: number;
  npsPeak: number;
  /** notes per second, one value per second from `start` */
  density: number[];
  longestBurst: number;
  /** osu!mania only from here */
  lanes: number[];
  /** rows of 1, 2, 3 and 4+ notes */
  chords: [number, number, number, number];
  jackRatio: number;
  lnTime: number;
  patterns: { pattern: PatternName; share: number }[];
  tags: string[];
}

/** One difficulty's chart (see src-tauri/src/charts.rs). Flat arrays keep the payload small. */
export interface ChartData {
  mode: number;
  keys: number;
  /** [time, lane, length] per object (lane is the x position outside osu!mania) */
  notes: number[];
  /** [time, beat length, meter] per uninherited timing point */
  beats: number[];
  /** [start, end] pairs */
  breaks: number[];
  kiai: number[];
  /** osu!mania star rating at 0.5×, 0.55× … 2.0× (empty for other modes) */
  stars: number[];
  analysis: ChartAnalysis;
}

export interface LazerInstall {
  path: string;
  storage: string;
  realmSize: number;
  realmModified: number;
}

export interface LibraryStatus {
  install: LazerInstall | null;
  defaultPath: string | null;
  scannedAt: number | null;
  counts: { sets: number; maps: number; scores: number; collections: number } | null;
  changed: boolean;
  scanning: boolean;
}

export interface ScanProgress {
  stage: "copy" | "sets" | "scores" | "collections" | "import" | string;
  done: number;
  total: number;
}

export interface Settings {
  lazerPath: string | null;
  autoRescan: boolean;
  ui: Partial<UiPrefs>;
}

export type AccentMode = "dynamic" | "fixed";
export type LibraryLayout = "grid" | "table";
export type RepeatMode = "off" | "all" | "one";

export interface UiPrefs {
  accentMode: AccentMode;
  accent: string;
  ambient: boolean;
  reduceMotion: boolean;
  unicode: boolean;
  theme: "dark" | "oled";
  volume: number;
  layout: LibraryLayout;
  sort: string;
  sortDesc: boolean;
  /** default ruleset filter, -1 = all */
  mode: number;
  /** mania key filter, empty = any */
  keys: number[];
  sidebarCollapsed: boolean;
  /** collapsible sidebar groups that are closed */
  collapsedGroups: string[];
  shuffle: boolean;
  repeat: RepeatMode;
  /** set once the first-run defaults (e.g. mode from play history) were applied */
  defaultsApplied: boolean;
}

export interface ApiError {
  code: string;
  message: string;
}
