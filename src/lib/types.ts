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

/** The player's best on a difficulty (passes, local and from osu!) and how often they played it. */
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
  /** osu!mania dan at 1×: the rice reading, then " || " and the LN one for long-note charts */
  dan?: string;
  /** Azusa's dan number (4K rice): Reform 1–10 = 1–10, Alpha = 11 … */
  danValue?: number;
  /** pattern category from the pattern report ("Jumpstream", "Chordjacks Tech", "… SV") */
  category?: string;
  /** osu!mania: each pattern's share of the chart in percent, in lib/skills' PATTERNS order
   * (stream, jumpstream, handstream, chordjack, jacks, ln) */
  shares?: number[];
}

export interface CollectionRow {
  id: string;
  name: string;
  maps: number[];
  missing: number;
}

/** One of Fumen's own collections: difficulties by the library's ids (it keeps their MD5s, so
 * ones not in the library are kept and counted as missing). */
export interface FumenCollection {
  id: string;
  name: string;
  /** unix ms */
  created: number;
  maps: string[];
  missing: number;
  /** a smart collection: its saved search (lib/search FilterState as JSON); `maps` is then empty */
  query?: string;
}

export interface Snapshot {
  source: "lazer";
  scannedAt?: number;
  sets: SetRow[];
  maps: MapRow[];
  collections: CollectionRow[];
  /** owner of the local scores, if any */
  user?: { name: string; id?: number };
  /** lazer's osu!mania settings the playfield preview follows */
  mania: { scrollSpeed?: number; scrollDirection?: "Down" | "Up" };
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
  /** the pattern of every one-second window from `start` (null = light or empty) */
  windows?: (PatternName | null)[];
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
  /** osu!mania: ManiaMapAnalyser's pattern report */
  report?: PatternReport;
  /** osu!mania: the dan at 1× */
  dan?: DanRating;
}

export type CorePattern = "Stream" | "Chordstream" | "Jacks" | "Coordination" | "Density" | "Wildcard";

/** Matches of one core pattern at one speed (see src-tauri/src/mma/patterns.rs). */
export interface PatternCluster {
  pattern: CorePattern;
  /** specific patterns inside, with their share of the matches, biggest first */
  specific: [string, number][];
  /** speed as the BPM of 1/4 notes at it (0 = none) */
  bpm: number;
  /** its matches don't hold one speed */
  mixed: boolean;
  /** chart ms it covers */
  amount: number;
}

export interface PatternReport {
  category: string;
  /** rice, long notes, hybrid (notes and heads in the same rows), mixed */
  mode: "RC" | "LN" | "HB" | "Mix";
  lnRatio: number;
  /** ms at a scroll speed away from 1× */
  svAmount: number;
  /** most important first */
  clusters: PatternCluster[];
}

export interface DanRating {
  /** rice reading, e.g. "Gamma mid", "Reform 7 high", "< Intro 1 low" */
  rc: string;
  /** long-note reading, for charts with 15 % long notes or more */
  ln?: string;
  /** Azusa's number for 4K rice */
  value?: number;
  by: "azusa" | "sunny";
  /** Sunny's star rating */
  sunny: number;
}

/** A sound of the playing chart: one of its set's files, or a skin sample ("soft-hitclap"). */
export type HitSample = { file: string } | { skin: string };

/** An osu!mania chart's hitsounds (see src-tauri/src/hitsounds.rs). */
export interface ChartSounds {
  samples: HitSample[];
  /** [time, sample index, volume 0–100] per sound, by time */
  events: number[];
}

export type SkinKind = "legacy" | "classic" | "retro" | "triangles" | "argon" | "argon-pro";

export interface SkinEntry {
  id: string;
  name: string;
  creator: string;
  kind: SkinKind;
  protected: boolean;
}

export interface SkinList {
  skins: SkinEntry[];
  /** lazer's selected skin */
  selected: string | null;
  /** file names of lazer's built-in classic / retro textures */
  classic: string[];
  retro: string[];
  /** file names of the built-in hit sounds of triangles, argon and argon pro */
  triangles: string[];
  argon: string[];
  argonPro: string[];
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
export type LibraryLayout = "grid" | "list";
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
  /** osu!mania scroll speed for the playfield preview; null = follow lazer's setting */
  scrollSpeed: number | null;
  /** skin of the playfield (a lazer skin id); null = the one selected in lazer */
  playfieldSkin: string | null;
  /** volume of the playfield's hitsounds, 0–1, relative to the music */
  hitsoundVolume: number;
  /** fullscreen view used last */
  fullscreenMode: "visual" | "field";
  /** set once the first-run defaults (e.g. mode from play history) were applied */
  defaultsApplied: boolean;
}

/** The osu! account Fumen is logged in to (src-tauri/src/osu_auth.rs). */
export interface OsuAccount {
  id: number;
  username: string;
  avatar: string | null;
  country: string | null;
  /** main ruleset on osu!: rank and pp are in it */
  mode: "osu" | "taiko" | "fruits" | "mania" | null;
  rank: number | null;
  countryRank: number | null;
  pp: number | null;
}

/** One play: lazer's local score, osu!'s, or both (src-tauri/src/osu_scores.rs). */
export interface Play {
  /** the library difficulty */
  map?: string;
  /** not in the library: index into History.beatmaps */
  beatmap?: number;
  /** osu!'s difficulty id, when osu! knows the play */
  beatmapId?: number;
  /** 0 osu, 1 taiko, 2 catch, 3 mania, -1 custom */
  mode: number;
  ruleset?: string;
  /** unix ms */
  date: number;
  /** lazer ScoreRank */
  rank: number;
  acc: number;
  score: number;
  pp?: number;
  combo: number;
  mods?: string[];
  /** playback rate from the mods, when not 1× */
  rate?: number;
  /** judgement counts above zero: perfect, great, good, ok, meh, miss, large_tick_hit, … */
  hits?: Record<string, number>;
  failed?: boolean;
  /** "lazer": only on this computer · "osu": only on osu! · "both" */
  source: "lazer" | "osu" | "both";
  /** position in osu!'s top plays for its ruleset */
  top?: number;
  /** osu!'s score id */
  id?: number;
  /** osu!mania at a rate the library has no star rating for: the star rating at it (Fumen's
   * calculator) */
  sr?: number;
}

/** A difficulty that isn't in the library, as osu! described it. */
export interface OnlineMap {
  id: number;
  setId?: number;
  mode: number;
  version: string;
  sr: number;
  /** ms */
  length: number;
  title: string;
  titleUnicode?: string;
  artist: string;
  artistUnicode?: string;
  creator: string;
}

/** osu!'s numbers for one ruleset. */
export interface OsuModeStats {
  pp: number | null;
  rank: number | null;
  countryRank: number | null;
  /** 0–1 */
  accuracy: number | null;
  playCount: number | null;
  /** seconds */
  playTime: number | null;
  maxCombo: number | null;
  grades: { ss: number; ssh: number; s: number; sh: number; a: number } | null;
  /** global rank over the last 90 days, oldest first (0: unranked that day) */
  rankHistory: number[] | null;
}

export interface History {
  /** whose plays these are */
  player?: { id?: number; name?: string };
  /** last sync with osu! (unix ms) */
  syncedAt?: number;
  /** newest first */
  plays: Play[];
  /** osu!'s most played difficulties (its top 100) */
  mostPlayed: { map?: string; beatmap?: number; beatmapId: number; count: number }[];
  /** by ruleset name: "osu", "taiko", "fruits", "mania" */
  stats: Partial<Record<"osu" | "taiko" | "fruits" | "mania", OsuModeStats>>;
  beatmaps: OnlineMap[];
}

export interface SyncSummary {
  added: number;
  total: number;
  at: number;
}

/** Whether sets can go into osu!lazer right now (see src-tauri/src/lazer_import.rs). */
export interface LazerImportStatus {
  ready: boolean;
  reason: "not-installed" | "untested" | "running" | "no-library" | null;
  message: string | null;
  /** the installed lazer, as in its sq.version ("2026.1005.0-lazer") */
  version: string | null;
  tested: boolean;
  running: boolean;
  testedVersions: string[];
}

export type ImportStage = "resolving" | "downloading" | "importing" | "done" | "skipped" | "error";

/** `import-progress`: one pasted line moving along */
export interface ImportProgress {
  index: number;
  stage: ImportStage;
  set: number | null;
  title: string | null;
  /** bytes, while downloading */
  done: number;
  total: number;
  message: string | null;
}

export interface ImportSummary {
  imported: number;
  skipped: number;
  failed: number;
}

export interface ApiError {
  code: string;
  message: string;
}
