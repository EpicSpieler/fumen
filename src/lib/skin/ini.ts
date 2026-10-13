/* ini.ts — skin.ini, read the way osu!lazer reads it.
 *
 * A port of lazer's LegacyDecoder + LegacySkinDecoder + LegacyManiaSkinDecoder (MIT, ppy Pty Ltd),
 * quirks included, so a skin lays out exactly as it does in lazer:
 *  - lines are skipped when blank or starting with "//"; "//" later in a line starts a comment;
 *  - an unknown [Section] is read as [General];
 *  - [Mania] lines are held back until a `Keys:` line, then applied to that key count;
 *    duplicate key counts are ignored;
 *  - a bad value fails its line only, but in [Mania] it also stops every later line of the
 *    section from being applied (lazer re-reads the held lines and fails on the same one).
 */

/** stable's 480-tall layout → lazer's 768-tall one */
export const STABLE_SCALE = 1.6;
export const LATEST_VERSION = 2.7;
export const DEFAULT_COLUMN_SIZE = 30 * STABLE_SCALE;
export const DEFAULT_HIT_POSITION = (480 - 402) * STABLE_SCALE;

/** RGBA, 0–255 each */
export type Rgba = [number, number, number, number];

/** LegacyManiaSkinConfiguration.LegacyNoteBodyStyle */
export const BODY_STRETCH = 0;

export interface ManiaConfig {
  keys: number;
  /** one per column, in lazer units (stable × 1.6) */
  columnWidth: number[];
  /** keys − 1 */
  columnSpacing: number[];
  /** keys + 1, not scaled */
  columnLineWidth: number[];
  explosionWidth: number[];
  holdNoteLightWidth: number[];
  hitPosition: number;
  lightPosition: number;
  comboPosition: number;
  scorePosition: number;
  barLineHeight: number;
  showJudgementLine: boolean;
  keysUnderNotes: boolean;
  lightFramePerSecond: number;
  /** null: depends on the skin version */
  noteBodyStyle: number | null;
  widthForNoteHeightScale: number;
  colours: Map<string, Rgba>;
  images: Map<string, string>;
}

export interface SkinIni {
  /** `Version:`; 1.0 when the file doesn't say */
  version: number;
  /** every key/value outside [Colours] (lazer's ConfigDictionary) */
  config: Map<string, string>;
  mania: Map<number, ManiaConfig>;
  /** [Colours] Combo1… in the order written, 0–255 */
  combo: Rgba[];
  /** the other colours of [Colours] and [CatchTheBeat] (SliderBorder, HyperDash …), 0–255 */
  colours: Map<string, Rgba>;
}

export function maniaDefaults(keys: number): ManiaConfig {
  if (!Number.isInteger(keys) || keys < 1) throw new Error(`bad key count ${keys}`);
  return {
    keys,
    columnWidth: new Array<number>(keys).fill(DEFAULT_COLUMN_SIZE),
    columnSpacing: new Array<number>(keys - 1).fill(0),
    columnLineWidth: new Array<number>(keys + 1).fill(2),
    explosionWidth: new Array<number>(keys).fill(0),
    holdNoteLightWidth: new Array<number>(keys).fill(0),
    hitPosition: DEFAULT_HIT_POSITION,
    lightPosition: (480 - 413) * STABLE_SCALE,
    comboPosition: 111 * STABLE_SCALE,
    scorePosition: 300 * STABLE_SCALE,
    barLineHeight: 1.2,
    showJudgementLine: true,
    keysUnderNotes: false,
    lightFramePerSecond: 60,
    noteBodyStyle: null,
    widthForNoteHeightScale: 0,
    colours: new Map(),
    images: new Map(),
  };
}

const SECTIONS = ["General", "Editor", "Metadata", "Difficulty", "Events", "TimingPoints", "Colours", "HitObjects", "Variables", "Fonts", "CatchTheBeat", "Mania"];

/** .NET's Enum.TryParse: a member name (case-sensitive) or its number. */
function parseSection(name: string): string | null {
  const s = name.trim();
  if (SECTIONS.includes(s)) return s;
  if (/^[+-]?\d+$/.test(s)) {
    const n = Number(s);
    return SECTIONS[n] ?? null;
  }
  return null;
}

/** float.Parse(s, CultureInfo.InvariantCulture): throws on anything that isn't a number. */
export function parseFloatStrict(s: string): number {
  const t = s.trim();
  if (!/^[+-]?(?:\d[\d,]*(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) throw new Error(`not a number: ${s}`);
  return Number(t.replace(/,/g, ""));
}

function parseIntStrict(s: string): number {
  const t = s.trim();
  if (!/^[+-]?\d+$/.test(t)) throw new Error(`not an integer: ${s}`);
  return Number(t);
}

function parseByte(s: string): number {
  const n = parseIntStrict(s);
  if (n < 0 || n > 255) throw new Error("Color must be specified with 8-bit integer components");
  return n;
}

/** float.TryParse with NumberStyles.Float: like parseFloatStrict without thousands separators. */
function tryParseFloat(s: string): number | null {
  const t = s.trim();
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(t) ? Number(t) : null;
}

/** Enum.TryParse for LegacyNoteBodyStyle: a name or any integer. */
function parseBodyStyle(s: string): number | null {
  const names: Record<string, number> = { Stretch: 0, RepeatTop: 2, RepeatBottom: 3, RepeatTopAndBottom: 4 };
  const t = s.trim();
  if (t in names) return names[t];
  return /^[+-]?\d+$/.test(t) ? Number(t) : null;
}

/** SplitKeyVal: split at the first ':', both sides trimmed. */
function splitKeyVal(line: string): [string, string] {
  const i = line.indexOf(":");
  return i < 0 ? [line.trim(), ""] : [line.slice(0, i).trim(), line.slice(i + 1).trim()];
}

function parseColour(value: string, allowAlpha: boolean): Rgba {
  const split = value.split(",");
  if (split.length !== 3 && split.length !== 4) throw new Error(`Color specified in incorrect format: ${value}`);
  const a = allowAlpha && split.length === 4 ? parseByte(split[3]) : 255;
  return [parseByte(split[0]), parseByte(split[1]), parseByte(split[2]), a];
}

function parseArray(value: string, out: number[], scale = true): void {
  const values = value.split(",");
  for (let i = 0; i < values.length && i < out.length; i++) {
    // stable reads bad entries as zero
    const v = tryParseFloat(values[i]) ?? 0;
    out[i] = scale ? v * STABLE_SCALE : v;
  }
}

/** One held [Mania] line applied to a configuration (LegacyManiaSkinDecoder.flushPendingLines). */
function applyManiaLine(c: ManiaConfig, line: string): void {
  const [key, value] = splitKeyVal(line);
  switch (key) {
    case "ColumnLineWidth":
      return parseArray(value, c.columnLineWidth, false);
    case "ColumnSpacing":
      return parseArray(value, c.columnSpacing);
    case "ColumnWidth":
      return parseArray(value, c.columnWidth);
    case "BarlineHeight":
      c.barLineHeight = parseFloatStrict(value);
      return;
    case "HitPosition":
      c.hitPosition = (480 - Math.min(480, Math.max(240, parseFloatStrict(value)))) * STABLE_SCALE;
      return;
    case "LightPosition":
      c.lightPosition = (480 - parseFloatStrict(value)) * STABLE_SCALE;
      return;
    case "ComboPosition":
      c.comboPosition = parseFloatStrict(value) * STABLE_SCALE;
      return;
    case "ScorePosition":
      c.scorePosition = parseFloatStrict(value) * STABLE_SCALE;
      return;
    case "JudgementLine":
      c.showJudgementLine = value === "1";
      return;
    case "KeysUnderNotes":
      c.keysUnderNotes = value === "1";
      return;
    case "LightingNWidth":
      return parseArray(value, c.explosionWidth);
    case "LightingLWidth":
      return parseArray(value, c.holdNoteLightWidth);
    case "NoteBodyStyle": {
      const style = parseBodyStyle(value);
      if (style !== null) c.noteBodyStyle = style;
      return;
    }
    case "WidthForNoteHeightScale":
      c.widthForNoteHeightScale = parseFloatStrict(value) * STABLE_SCALE;
      return;
    case "LightFramePerSecond": {
      const fps = parseIntStrict(value);
      c.lightFramePerSecond = fps > 0 ? fps : 24;
      return;
    }
    // read by lazer but unused: still parsed, since a bad value fails the line there too
    case "ColumnStart":
    case "ColumnRight":
    case "StageSeparation":
      parseFloatStrict(value);
      return;
  }
  if (key.startsWith("Colour")) {
    c.colours.set(key, parseColour(value, true));
    return;
  }
  if (key.startsWith("NoteImage") || key.startsWith("KeyImage") || key.startsWith("Hit") || key.startsWith("Stage") || key.startsWith("Lighting") || key === "WarningArrow") {
    c.images.set(key, value);
  }
}

export function parseSkinIni(text: string): SkinIni {
  const ini: SkinIni = { version: 1.0, config: new Map(), mania: new Map(), combo: [], colours: new Map() };
  let section = "General";
  // LegacyManiaSkinDecoder state
  let pending: string[] = [];
  let current: ManiaConfig | null = null;

  const flush = () => {
    // a failing line throws out of here and stays held, exactly like lazer
    for (const line of pending) applyManiaLine(current!, line);
    pending = [];
  };

  for (const raw of text.replace(/^﻿/, "").split(/\r\n|\n|\r/)) {
    if (!raw.trim() || raw.trimStart().startsWith("//")) continue;
    let line = raw;
    if (section !== "Metadata") {
      const c = line.indexOf("//");
      if (c > 0) line = line.slice(0, c);
    }
    line = line.trimEnd();

    if (line.startsWith("[") && line.endsWith("]")) {
      section = parseSection(line.slice(1, -1)) ?? "General";
      pending = [];
      current = null;
      continue;
    }

    // LegacySkinDecoder (general settings; [CatchTheBeat] only holds colours)
    try {
      if (section !== "Colours" && section !== "CatchTheBeat") {
        const [key, value] = splitKeyVal(line);
        if (section === "General" && key === "Version") {
          if (value === "latest") ini.version = LATEST_VERSION;
          else if (/^\d*\.?\d*$/.test(value) && /\d/.test(value)) ini.version = Number(value);
        } else if (!(section === "General" && (key === "Name" || key === "Author")) && key) {
          ini.config.set(key, value);
        }
      }
    } catch {
      /* the general decoder never throws for these */
    }

    // LegacyDecoder.handleColours
    if (section === "Colours" || section === "CatchTheBeat") {
      try {
        const [key, value] = splitKeyVal(line);
        const split = value.split(",");
        if (split.length === 3 || split.length === 4) {
          const c: Rgba = [parseByte(split[0]), parseByte(split[1]), parseByte(split[2]), split.length === 4 ? parseByte(split[3]) : 255];
          if (key.startsWith("Combo")) ini.combo.push(c);
          else ini.colours.set(key, c);
        }
      } catch {
        /* lazer logs the line and moves on */
      }
    }

    // LegacyManiaSkinDecoder
    if (section !== "Mania") continue;
    try {
      const [key, value] = splitKeyVal(line);
      if (key === "Keys") {
        const config = maniaDefaults(parseIntStrict(value));
        current = config;
        if (!ini.mania.has(config.keys)) ini.mania.set(config.keys, config);
        flush();
      } else {
        pending.push(line);
        if (current) flush();
      }
    } catch {
      /* lazer logs the line and moves on */
    }
  }
  return ini;
}
