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
  /** "stable": from osu!stable (lazer's have none) */
  from?: "stable";
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
  /** "stable": osu!stable's collection.db (lazer's have none) */
  from?: "stable";
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
  /** the lazer collection it went into (or was copied from) */
  lazerId?: string;
}

/** A Fumen collection on its way out; a smart one with what it matches now (library ids). */
export interface CollectionPick {
  id: string;
  maps?: string[];
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
  /** osu!taiko: the chart as lazer plays it (src-tauri/src/taiko.rs) */
  taiko?: TaikoChartData;
  /** osu!: the chart as lazer plays it (src-tauri/src/osu.rs) */
  osu?: OsuChartData;
  /** osu!catch: the chart as lazer plays it (src-tauri/src/catch.rs) */
  catch?: CatchChartData;
}

/** osu!taiko for the playfield, flat (see `TaikoOut` in src-tauri/src/charts.rs). */
export interface TaikoChartData {
  /** [time, kind, end, flags, extra] per object: kind 0 centre, 1 rim, 2 drum roll, 3 swell;
   * flags 1 strong, 2 kiai; extra: a roll's first tick index into `ticks`, a swell's hits */
  objects: number[];
  /** every drum roll's ticks, roll after roll */
  ticks: number[];
  /** every drum roll's time between ticks, roll after roll (charts from before 0.6 lack it) */
  spacing?: number[];
  /** [time, multiplier] scroll speed changes */
  scroll: number[];
  /** [time, major] bar lines */
  bars: number[];
  /** [time, keys, object] autoplay: keys 1 left centre, 2 right centre, 4 left rim, 8 right rim */
  presses: number[];
}

/** osu! for the playfield (see `OsuOut` in src-tauri/src/charts.rs); positions in osu!pixels
 * (512 × 384), stacking applied. */
export interface OsuChartData {
  /** circles are 128 × this across */
  scale: number;
  /** approach time and fade-in, ms */
  preempt: number;
  fadeIn: number;
  /** [time, kind, end, x, y, colour, number, flags, a, b] per object: kind 0 circle, 1 slider,
   * 2 spinner; colour the combo colour index; number the one on the circle; flags 1 new combo;
   * a, b: a slider's index into `sliders`, a spinner's spins needed and bonus spins */
  objects: number[];
  sliders: OsuSliderData[];
  /** [time, x, y, buttons] per autoplay frame: buttons 1 left, 2 right */
  frames: number[];
  /** the beatmap's own combo colours, [r, g, b] 0–255 */
  colours: [number, number, number][];
  sliderBorder?: [number, number, number];
  sliderTrack?: [number, number, number];
}

export interface OsuSliderData {
  /** [x, y] per point of the path, as straight pieces */
  path: number[];
  spans: number;
  spanDuration: number;
  /** [time, path progress] per tick */
  ticks: number[];
}

/** osu!catch for the playfield (see `CatchOut` in src-tauri/src/charts.rs); x in osu!pixels (0–512). */
export interface CatchChartData {
  /** CatchHitObject.Scale from CS: the catcher is twice that */
  scale: number;
  /** how long objects fall, ms */
  preempt: number;
  /** [time, kind, x, flags, index, banana] per object: kind 0 fruit, 1 droplet, 2 tiny droplet,
   * 3 banana; flags 1 hyperdash, 2 last in combo; index the object it came from (its colour and
   * look); banana its number in the shower */
  objects: number[];
  /** [time, x, dash] per autoplay frame */
  frames: number[];
  /** the beatmap's own combo colours, [r, g, b] 0–255 */
  colours: [number, number, number][];
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
  /** what each second from `start` is: an index into `labels`, -1 for nothing */
  seconds?: number[];
  /** a specific pattern ("Jumpstream") or a core one ("Stream", see CorePattern) */
  labels?: string[];
  /** ms */
  start?: number;
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
  /** osu!: [start, end, sample index, volume 0–100, rate at the start, rate at the ramp's end,
   * ramp end] per looping sound (slider slides, spinner spins), by start */
  loops?: number[];
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

export interface StableInstall {
  path: string;
  songs: string;
  dbSize: number;
  dbModified: number;
}

export interface LibraryStatus {
  install: LazerInstall | null;
  defaultPath: string | null;
  scannedAt: number | null;
  /** lazer's and stable's together */
  counts: { sets: number; maps: number; scores: number; collections: number } | null;
  changed: boolean;
  scanning: boolean;
  stable: {
    /** found (and switched on) */
    install: StableInstall | null;
    defaultPath: string | null;
    enabled: boolean;
    scannedAt: number | null;
    counts: { sets: number; maps: number; collections: number; scores?: number } | null;
  };
}

/** Library care (src-tauri/src/care.rs): a set on disk, bytes in all and by kind of file (the
 * song, videos, images, hitsounds, other). */
export interface CareSet {
  id: string;
  size: number;
  kinds: [number, number, number, number, number];
  /** files it lists that aren't on disk */
  missing?: number;
}

export interface CareReport {
  sets: CareSet[];
  /** lazer's beatmap files, each counted once */
  lazerSize: number;
  stableSize: number;
  duplicates: DupeGroup[];
  broken: Broken[];
  /** the sets in `duplicates` and `broken` (osu!stable's copies of lazer's sets aren't in the snapshot) */
  named: DupeSet[];
}

/** A set's song or background that can't be played or shown, or files it lists that are gone. */
export interface Broken {
  set: string;
  /** "files": any other file osu!lazer lists for the set */
  what: "song" | "background" | "files";
  /** "missing": named but not there; "broken": there, but not audio / an image */
  how: "missing" | "broken";
  /** the file's name in the set (not for "files") */
  name?: string | null;
  /** the difficulties it's for ("files": how many files) */
  count: number;
}

/** Sets that are (partly) the same: "stable-copy" osu!stable sets with every difficulty in lazer
 * too, "same-set" one osu! set more than once, "shared" difficulties in common, "reupload" the same
 * title by the same mapper with the same song file. */
export interface DupeGroup {
  kind: "stable-copy" | "same-set" | "shared" | "reupload";
  /** newest first */
  sets: string[];
  /** difficulties in more than one of them */
  shared: number;
}

export interface DupeSet {
  id: string;
  source: "lazer" | "stable";
  onlineId?: number | null;
  title: string;
  artist: string;
  creator: string;
  bg?: string | null;
  added?: number | null;
  maps: number;
  folder?: string | null;
}

export interface ScanProgress {
  stage: "copy" | "sets" | "scores" | "collections" | "import" | string;
  done: number;
  total: number;
}

export interface Settings {
  lazerPath: string | null;
  autoRescan: boolean;
  stablePath: string | null;
  useStable: boolean;
  /** the start ping, so fumen.dertesti.dev can count the people using Fumen */
  startPing: boolean;
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
  theme: "dark" | "oled" | "light";
  /** the UI's language; unset = the system's (src/lib/i18n.ts) */
  lang?: "en" | "de";
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
  /** the one-time notice about the start ping was shown */
  pingNoticed: boolean;
  /** after a play, show its score when Fumen isn't the window in front */
  scoreAuto: boolean;
  /** the companion window opens with Fumen */
  companion: boolean;
  /** the collection the companion window works through ("f:<id>" / "l:<id>") */
  companionPool: string | null;
}

/** A play as it happened, read from the replay lazer saved (src-tauri/src/live.rs). */
export interface LivePlay {
  /** the replay's file in lazer's files */
  id: string;
  md5: string;
  mode: number;
  player: string;
  date: number;
  /** 0–1, as lazer counts it */
  accuracy: number;
  /** XH, X, SH, S, A, B, C, D */
  rank: string | null;
  score: number;
  combo: number;
  mods: string[];
  rate: number | null;
  statistics: Record<string, number>;
  maximumStatistics: Record<string, number>;
  /** the library difficulty, when Fumen has it */
  map: string | null;
  title: string | null;
  artist: string | null;
  version: string | null;
  set: string | null;
  setOnline: number | null;
  stars: number | null;
  /** ms at 1× */
  length: number | null;
  /** the best accuracy on the difficulty before this play */
  bestBefore: number | null;
}

/** A collection the companion window can work through. */
export interface PoolChoice {
  id: string;
  name: string;
  source: "fumen" | "lazer" | "stable";
  count: number;
}

export interface PoolRow {
  md5: string;
  map: string | null;
  title: string | null;
  version: string | null;
  stars: number | null;
  /** passed this session */
  plays: number;
  bestNow: number | null;
  best: number | null;
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
  /** played in osu!stable (its scores.db) */
  stable?: boolean;
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
  /** sets in lazer without their details (an older Fumen imported them so) */
  unfinished: number;
}

export interface RepairSummary {
  finished: number;
  /** left for lazer to finish on its next start */
  failed: number;
}

/** `held`: the mirrors are busy or resting after a rate limit (`total`: about how many seconds
 * to go); `ready`: downloaded, waiting for its turn in osu!lazer's importer */
export type ImportStage = "resolving" | "downloading" | "held" | "ready" | "importing" | "done" | "skipped" | "error";

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
  /** sets left out because the import was stopped */
  cancelled: number;
  /** why the import stopped before the end (osu!lazer was opened, …) */
  stopped: string | null;
}

/** A set the player has played (osu!'s play counts, top plays, synced scores) that osu!lazer doesn't have. */
export interface PlayedSet {
  id: number;
  title: string;
  artist: string;
  creator: string;
  /** plays over all its difficulties (0: known from a score only) */
  plays: number;
  /** difficulties played */
  maps: number;
  /** osu!'s status ("ranked", "loved", …; empty when not known) */
  status: string;
  /** one of its difficulties is in the player's top plays */
  top: boolean;
  /** osu!stable has it */
  inStable: boolean;
}

export interface PlayedFound {
  /** most played first */
  missing: PlayedSet[];
  /** sets played in all */
  played: number;
  /** play counts and top plays read from osu! */
  read: number;
}

export interface ApiError {
  code: string;
  message: string;
}

export type MirrorSort = "relevance" | "ranked" | "plays" | "favourites" | "stars" | "newest";

/** A beatmap search on the mirrors (see src-tauri/src/mirror_search.rs); unset means "any". */
export interface MirrorQuery {
  text: string;
  mode: number | null;
  keys: number[];
  srMin: number | null;
  srMax: number | null;
  /** osu!'s numbers: -2 graveyard … 4 loved */
  status: number[];
  sort: MirrorSort;
  /** from 0 */
  page: number;
}

/** A difficulty of a set found on the mirrors. */
export interface FoundMap {
  id: number;
  mode: number;
  version: string;
  sr: number;
  cs: number;
  ar: number;
  od: number;
  bpm: number;
  /** seconds */
  length: number;
  /** one the search asks for */
  matches: boolean;
}

/** A set found on the mirrors. */
export interface FoundSet {
  id: number;
  title: string;
  titleUnicode?: string;
  artist: string;
  artistUnicode?: string;
  creator: string;
  status: number;
  /** unix ms */
  ranked?: number;
  plays: number;
  favourites: number;
  video: boolean;
  /** the searched ruleset's difficulties (every one without), easiest first */
  maps: FoundMap[];
}

export interface MirrorPage {
  sets: FoundSet[];
  /** the mirror has more */
  more: boolean;
  /** the mirror that answered */
  mirror: string;
  /** that mirror can't filter or sort on its side: the order is its own */
  plain: boolean;
}

/** A lazer score with a replay (see src-tauri/src/replay.rs). */
export interface ReplayEntry {
  /** lazer's score id */
  id: string;
  user?: string;
  /** unix ms */
  date?: number;
  accuracy?: number;
  score?: number;
  rank?: number;
  combo?: number;
  mods: string[];
  /** playback rate from the mods, when not 1× */
  rate?: number;
  /** lazer's judgement counts as JSON */
  statistics?: string;
}

/** One of the player's scores on osu! for a difficulty (see `online_list` in replay.rs). */
export interface OnlineReplayEntry {
  /** osu!'s score id */
  id: number;
  user?: string;
  date: number;
  accuracy: number;
  score: number;
  combo: number;
  mods: string[];
  rate?: number;
  /** osu! keeps a replay of it */
  hasReplay: boolean;
  /** downloaded already */
  cached: boolean;
}

/** A replay's frames: [time (song ms), x, y, buttons] each; osu!mania keeps its keys in x. */
export interface ReplayData {
  mode: number;
  player: string;
  beatmapMd5: string;
  frames: number[];
}
