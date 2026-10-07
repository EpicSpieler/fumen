/* search.ts — osu!-style query language + filtering and sorting over the in-memory library.
 *
 * Query syntax (same spirit as osu!'s song select):
 *   free text           every word must appear in title/artist/creator/source/tags/difficulty name
 *   "quoted phrase"     phrase match;  -word excludes
 *   key<op>value        op: = == != < <= > >= :   e.g.  keys=7  sr>4.5  bpm<=200  length<2:30
 *                       status=ranked  mode=mania  creator=Shoegazer  grade>=A  played=no  ln>30
 *                       pattern=jumpstream  peak>15   (from the chart analysis)
 */
import type { MapRow, SetRow, Snapshot } from "./types";

// ── query parsing ──────────────────────────────────────────────────────────

type Op = "=" | "==" | "!=" | "<" | "<=" | ">" | ">=";

type NumKey =
  | "sr" | "bpm" | "length" | "od" | "hp" | "ar" | "cs" | "keys" | "objects" | "ln" | "nps"
  | "plays" | "acc" | "added" | "played" | "year" | "setid" | "mapid" | "peak";
type StrKey = "creator" | "artist" | "title" | "source" | "tags" | "diff";
type Key = NumKey | StrKey | "status" | "mode" | "grade" | "pattern";

const ALIASES: Record<string, Key> = {
  star: "sr", stars: "sr", sr: "sr",
  bpm: "bpm",
  length: "length", len: "length", drain: "length", time: "length",
  od: "od", acc: "acc", accuracy: "acc", hp: "hp", ar: "ar", cs: "cs",
  keys: "keys", key: "keys", k: "keys",
  notes: "objects", objects: "objects", objs: "objects",
  ln: "ln", lns: "ln", holds: "ln",
  nps: "nps",
  peak: "peak", peaknps: "peak",
  pattern: "pattern", patterns: "pattern", skill: "pattern", style: "pattern",
  plays: "plays", playcount: "plays",
  added: "added", played: "played", lastplayed: "played",
  ranked: "year", year: "year",
  setid: "setid", set: "setid", beatmapsetid: "setid",
  id: "mapid", mapid: "mapid", beatmapid: "mapid",
  creator: "creator", mapper: "creator", author: "creator",
  artist: "artist", title: "title", source: "source",
  tag: "tags", tags: "tags",
  diff: "diff", difficulty: "diff", version: "diff",
  status: "status", s: "status",
  mode: "mode", m: "mode", ruleset: "mode",
  grade: "grade", rank: "grade",
};

const STATUS_NAMES: Record<string, number[]> = {
  r: [1], ranked: [1],
  a: [2], approved: [2],
  q: [3], qualified: [3],
  l: [4], loved: [4],
  p: [0], pending: [0],
  w: [-1], wip: [-1],
  g: [-2], graveyard: [-2],
  local: [-3, -4], none: [-3], modified: [-4],
  u: [-3, -2, -1, 0], unranked: [-3, -2, -1, 0],
};

const MODE_NAMES: Record<string, number> = {
  o: 0, osu: 0, std: 0, standard: 0, "0": 0,
  t: 1, taiko: 1, "1": 1,
  c: 2, ctb: 2, catch: 2, fruits: 2, "2": 2,
  m: 3, mania: 3, "3": 3,
};

/** Pattern tags from the chart analysis, with the community's short forms. */
const PATTERN_NAMES: Record<string, string> = {
  stream: "stream", streams: "stream",
  jumpstream: "jumpstream", js: "jumpstream",
  handstream: "handstream", hs: "handstream",
  chordjack: "chordjack", chordjacks: "chordjack", cj: "chordjack",
  jack: "jacks", jacks: "jacks", jackhammer: "jacks",
  ln: "ln", lns: "ln", longnote: "ln", longnotes: "ln",
  stamina: "stamina", stam: "stamina",
};

/** lazer ScoreRank ordinal for grade comparisons (silver variants rank with their gold ones). */
const GRADE_NAMES: Record<string, number> = { f: -1, d: 0, c: 1, b: 2, a: 3, s: 4, sh: 4, ss: 6, x: 6, xh: 6 };
const gradeOrdinal = (rank: number): number => (rank === 5 ? 4 : rank === 7 ? 6 : rank);

interface NumCond { key: NumKey; op: Op; value: number; step: number }
interface StrCond { key: StrKey; op: Op; value: string }
interface SetCond { key: "status" | "mode"; op: Op; values: number[] }
interface GradeCond { key: "grade"; op: Op; value: number }
interface PatternCond { key: "pattern"; op: Op; value: string }
type Cond = NumCond | StrCond | SetCond | GradeCond | PatternCond;

export interface ParsedQuery {
  terms: string[];
  excluded: string[];
  conds: Cond[];
}

const TOKEN = /[a-z]+(?:==|!=|>=|<=|=|:|<|>)"[^"]*"?|-?"[^"]*"?|\S+/gi;
const COND = /^([a-z]+)(==|!=|>=|<=|=|:|<|>)(.+)$/i;

/** Seconds from "90", "90s", "1:30", "2m", "1m30s". */
function parseLength(v: string): number | null {
  const s = v.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const colon = /^(\d+):(\d{1,2})$/.exec(s);
  if (colon) return +colon[1] * 60 + +colon[2];
  const unit = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(s);
  if (unit && (unit[1] || unit[2] || unit[3])) return +(unit[1] ?? 0) * 3600 + +(unit[2] ?? 0) * 60 + +(unit[3] ?? 0);
  return null;
}

function decimalsStep(v: string): number {
  const dot = v.indexOf(".");
  return dot < 0 ? 1 : Math.pow(10, -(v.length - dot - 1));
}

function parseCond(rawKey: string, rawOp: string, rawValue: string): Cond | null {
  const key = ALIASES[rawKey.toLowerCase()];
  if (!key) return null;
  const op: Op = rawOp === ":" ? "=" : (rawOp as Op);
  const value = rawValue.replace(/^"|"$/g, "");
  const lower = value.toLowerCase();

  switch (key) {
    case "status": {
      const values = STATUS_NAMES[lower];
      return values ? { key, op, values } : null;
    }
    case "mode": {
      const m = MODE_NAMES[lower];
      return m === undefined ? null : { key, op, values: [m] };
    }
    case "grade": {
      const g = GRADE_NAMES[lower];
      return g === undefined ? null : { key, op, value: g };
    }
    case "creator": case "artist": case "title": case "source": case "tags": case "diff":
      return lower ? { key, op, value: lower } : null;
    case "pattern": {
      const name = PATTERN_NAMES[lower];
      return name ? { key, op: op === "!=" ? "!=" : "=", value: name } : null;
    }
    case "length": {
      const secs = parseLength(lower);
      return secs === null ? null : { key, op, value: secs, step: lower.includes(":") || /[hms]/.test(lower) ? 1 : decimalsStep(lower) };
    }
    case "played": {
      if (["yes", "y", "true", "1"].includes(lower) && op === "=") return { key, op: "<", value: Infinity, step: 1 };
      if (["no", "n", "false", "0"].includes(lower) && op === "=") return { key, op: "=", value: Infinity, step: 1 };
      const days = parseFloat(lower);
      return Number.isFinite(days) ? { key, op, value: days, step: 1 } : null;
    }
    default: {
      const n = parseFloat(lower.replace(/%$/, ""));
      if (!Number.isFinite(n)) return null;
      return { key, op, value: n, step: key === "keys" || key === "setid" || key === "mapid" ? 0 : decimalsStep(lower.replace(/%$/, "")) };
    }
  }
}

export function parseQuery(input: string): ParsedQuery {
  const out: ParsedQuery = { terms: [], excluded: [], conds: [] };
  for (const raw of input.match(TOKEN) ?? []) {
    const m = COND.exec(raw);
    const cond = m ? parseCond(m[1], m[2], m[3]) : null;
    if (cond) {
      out.conds.push(cond);
      continue;
    }
    const neg = raw.startsWith("-") && raw.length > 1;
    const term = (neg ? raw.slice(1) : raw).replace(/^"|"$/g, "").toLowerCase().trim();
    if (!term) continue;
    (neg ? out.excluded : out.terms).push(term);
  }
  return out;
}

function cmpNum(x: number, op: Op, v: number, step: number): boolean {
  switch (op) {
    case "=": case "==":
      // "sr=5" means 5.00–5.99, "sr=5.2" means 5.20–5.29; infinities compare exactly
      if (!Number.isFinite(v) || step === 0) return x === v;
      return x >= v - 1e-9 && x < v + step - 1e-9;
    case "!=": return !cmpNum(x, "=", v, step);
    case "<": return x < v;
    case "<=": return x <= v;
    case ">": return x > v;
    case ">=": return x >= v;
  }
}

function cmpStr(hay: string, op: Op, v: string): boolean {
  switch (op) {
    case "==": return hay === v;
    case "!=": return !hay.includes(v);
    default: return hay.includes(v);
  }
}

// ── index ──────────────────────────────────────────────────────────────────

/** Precomputed lowercase haystacks; rebuilt when a new snapshot arrives. */
export interface LibIndex {
  snap: Snapshot;
  setHay: string[];
  setFields: { title: string; artist: string; creator: string; source: string; tags: string }[];
  mapVersion: string[];
}

export function buildIndex(snap: Snapshot): LibIndex {
  const setFields = snap.sets.map((s) => ({
    title: `${s.title} ${s.titleUnicode ?? ""}`.toLowerCase(),
    artist: `${s.artist} ${s.artistUnicode ?? ""}`.toLowerCase(),
    creator: s.creator.toLowerCase(),
    source: (s.source ?? "").toLowerCase(),
    tags: (s.tags ?? "").toLowerCase(),
  }));
  const setHay = setFields.map((f) => `${f.title} ${f.artist} ${f.creator} ${f.source} ${f.tags}`);
  const mapVersion = snap.maps.map((m) => m.version.toLowerCase());
  return { snap, setHay, setFields, mapVersion };
}

// ── filtering ──────────────────────────────────────────────────────────────

export interface FilterState {
  text: string;
  /** -1 = all rulesets */
  mode: number;
  /** mania key counts; empty = any */
  keys: number[];
  srMin: number;
  srMax: number;
  /** empty = any */
  status: number[];
  played: "any" | "played" | "unplayed";
  showHidden: boolean;
}

export const DEFAULT_FILTER: FilterState = {
  text: "",
  mode: -1,
  keys: [],
  srMin: 0,
  srMax: Infinity,
  status: [],
  played: "any",
  showHidden: false,
};

export interface SetResult {
  set: number;
  /** matching difficulties, in display order (ruleset, then star rating) */
  maps: number[];
}

export interface FilterResult {
  sets: SetResult[];
  mapCount: number;
}

const DAY = 86_400_000;

function numValue(key: NumKey, m: MapRow, s: SetRow, now: number): number {
  switch (key) {
    case "sr": return m.sr;
    case "bpm": return m.bpm;
    case "length": return m.length / 1000;
    case "od": return m.od;
    case "hp": return m.hp;
    case "ar": return m.ar;
    case "cs": return m.cs;
    case "keys": return m.mode === 3 ? Math.round(m.cs) : NaN;
    case "objects": return m.objects;
    case "ln": return m.objects > 0 ? (m.holds / m.objects) * 100 : 0;
    case "nps": return m.length > 0 ? m.objects / (m.length / 1000) : 0;
    case "plays": return m.best?.plays ?? 0;
    case "acc": return (m.best?.acc ?? 0) * 100;
    case "added": return s.added ? (now - s.added) / DAY : Infinity;
    case "played": return m.played ? (now - m.played) / DAY : Infinity;
    case "year": return s.ranked ? new Date(s.ranked).getFullYear() : NaN;
    case "setid": return s.onlineId ?? -1;
    case "mapid": return m.onlineId ?? -1;
    case "peak": return m.peak ?? NaN;
  }
}

/**
 * Filters the library. `restrict` limits the candidate difficulties (e.g. a collection).
 */
export function filterLibrary(ix: LibIndex, f: FilterState, restrict?: Set<number>): FilterResult {
  const q = parseQuery(f.text);
  const { sets, maps } = ix.snap;
  const now = Date.now();
  const keySet = f.keys.length ? new Set(f.keys) : null;
  const statusSet = f.status.length ? new Set(f.status) : null;
  const out: SetResult[] = [];
  let mapCount = 0;

  for (let si = 0; si < sets.length; si++) {
    const set = sets[si];
    if (!set.maps.length) continue;
    const hay = ix.setHay[si];
    if (q.excluded.some((t) => hay.includes(t))) continue;
    // terms the set metadata already satisfies; the rest must match the difficulty name
    const pending = q.terms.filter((t) => !hay.includes(t));
    const fields = ix.setFields[si];

    let matched: number[] | null = null;
    for (const mi of set.maps) {
      if (restrict && !restrict.has(mi)) continue;
      const m = maps[mi];
      if (m.hidden && !f.showHidden) continue;
      if (f.mode >= 0 && m.mode !== f.mode) continue;
      if (keySet && (m.mode !== 3 || !keySet.has(Math.round(m.cs)))) continue;
      if (m.sr < f.srMin || m.sr > f.srMax) continue;
      if (statusSet && !statusSet.has(m.status)) continue;
      if (f.played === "played" && !m.played && !m.best) continue;
      if (f.played === "unplayed" && (m.played || m.best)) continue;
      if (pending.length) {
        const v = ix.mapVersion[mi];
        if (!pending.every((t) => v.includes(t))) continue;
      }
      if (q.excluded.length && q.excluded.some((t) => ix.mapVersion[mi].includes(t))) continue;
      if (!q.conds.every((c) => test(c, m, set, fields, ix.mapVersion[mi], now))) continue;
      (matched ??= []).push(mi);
    }
    if (matched) {
      out.push({ set: si, maps: matched });
      mapCount += matched.length;
    }
  }
  return { sets: out, mapCount };
}

function test(c: Cond, m: MapRow, s: SetRow, fields: LibIndex["setFields"][number], version: string, now: number): boolean {
  switch (c.key) {
    case "status": {
      const hit = c.values.includes(m.status);
      return c.op === "!=" ? !hit : hit;
    }
    case "mode": {
      const hit = c.values.includes(m.mode);
      return c.op === "!=" ? !hit : hit;
    }
    case "grade":
      return m.best ? cmpNum(gradeOrdinal(m.best.rank), c.op, c.value, 0) : c.op === "!=" || c.op === "<" || c.op === "<=";
    case "creator": return cmpStr(fields.creator, c.op, c.value);
    case "artist": return cmpStr(fields.artist, c.op, c.value);
    case "title": return cmpStr(fields.title, c.op, c.value);
    case "source": return cmpStr(fields.source, c.op, c.value);
    case "tags": return cmpStr(fields.tags, c.op, c.value);
    case "diff": return cmpStr(version, c.op, c.value);
    case "pattern": {
      const hit = !!m.patterns && ` ${m.patterns} `.includes(` ${c.value} `);
      return c.op === "!=" ? !hit : hit;
    }
    default: {
      const x = numValue(c.key, m, s, now);
      return !Number.isNaN(x) && cmpNum(x, c.op, c.value, c.step);
    }
  }
}

// ── sorting ────────────────────────────────────────────────────────────────

export type SetSort = "added" | "title" | "artist" | "creator" | "sr" | "bpm" | "length" | "ranked" | "played" | "peak";
export type MapSort = SetSort | "version" | "keys" | "od" | "hp" | "objects" | "ln" | "nps" | "grade";

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

function mapKey(key: MapSort, m: MapRow, s: SetRow): number | string {
  switch (key) {
    case "added": return s.added ?? 0;
    case "title": return s.title;
    case "artist": return s.artist;
    case "creator": return s.creator;
    case "version": return m.version;
    case "sr": return m.sr;
    case "bpm": return m.bpm;
    case "length": return m.length;
    case "ranked": return s.ranked ?? 0;
    case "played": return m.played ?? 0;
    case "keys": return m.mode * 100 + (m.mode === 3 ? m.cs : 0);
    case "od": return m.od;
    case "hp": return m.hp;
    case "objects": return m.objects;
    case "ln": return m.objects ? m.holds / m.objects : 0;
    case "nps": return m.length ? m.objects / m.length : 0;
    case "grade": return m.best ? gradeOrdinal(m.best.rank) * 1000 + m.best.acc : -10_000;
    case "peak": return m.peak ?? -1;
  }
}

function compare(a: number | string, b: number | string): number {
  return typeof a === "string" ? collator.compare(a, b as string) : (a as number) - (b as number);
}

/** Sorts set results in place. Numeric set keys use the best-matching difficulty. */
export function sortSets(ix: LibIndex, results: SetResult[], key: SetSort, desc: boolean): SetResult[] {
  const { sets, maps } = ix.snap;
  const dir = desc ? -1 : 1;
  const keyOf = (r: SetResult): number | string => {
    const s = sets[r.set];
    switch (key) {
      case "sr": case "bpm": case "length": case "played": case "peak": {
        let v = desc ? -Infinity : Infinity;
        for (const mi of r.maps) {
          const x = mapKey(key, maps[mi], s) as number;
          v = desc ? Math.max(v, x) : Math.min(v, x);
        }
        return v;
      }
      default:
        return mapKey(key, maps[r.maps[0]], s);
    }
  };
  const keyed = results.map((r) => ({ r, k: keyOf(r) }));
  keyed.sort((a, b) => compare(a.k, b.k) * dir || a.r.set - b.r.set);
  for (let i = 0; i < keyed.length; i++) results[i] = keyed[i].r;
  return results;
}

/** Flattens to difficulties and sorts them (table view). */
export function sortMaps(ix: LibIndex, results: SetResult[], key: MapSort, desc: boolean): number[] {
  const { sets, maps } = ix.snap;
  const dir = desc ? -1 : 1;
  const keyed: { mi: number; k: number | string }[] = [];
  for (const r of results) for (const mi of r.maps) keyed.push({ mi, k: mapKey(key, maps[mi], sets[r.set]) });
  keyed.sort((a, b) => compare(a.k, b.k) * dir || maps[a.mi].set - maps[b.mi].set || maps[a.mi].sr - maps[b.mi].sr);
  return keyed.map((x) => x.mi);
}

/** Human-readable summary of what the query understood, for the UI. */
export function describeQuery(q: ParsedQuery): string[] {
  return q.conds.map((c) => {
    const v = "values" in c ? c.values.join("/") : String(c.value);
    return `${c.key} ${c.op} ${v}`;
  });
}
