/* pool-export.ts — a pool out of Fumen: one row per slot (empty ones too) with what a sheet
 * needs, as CSV (a file, Excel's way: UTF-8 with a BOM), as tab-separated text (copied, pastes
 * into Google Sheets and Excel as columns), and as JSON (everything, for tools and bots). The
 * numbers are the pool page's: star rating and most pp at the slot's mods from pp.rs, length and
 * BPM at the rate. The RPRO bot's own format is rproText in pools.ts. */
import { kindInfo, kindOfSlot, modText, poolRuleset, poolSlot, rateOf, slotChart, slotCodes, slotNumbers, type Pool } from "./pools";

export interface ExportRow {
  slot: string;
  kind: string;
  /** "HDDT", or "" */
  mods: string;
  beatmapId?: number;
  setId?: number;
  md5?: string;
  artist: string;
  title: string;
  version: string;
  creator: string;
  /** at the slot's mods */
  stars?: number;
  /** at the slot's rate */
  bpm?: number;
  /** seconds, at the slot's rate */
  length?: number;
  /** pp for a perfect play at the slot's mods */
  maxPp?: number;
  inLibrary: boolean;
  note: string;
}

/** Every slot of a pool in order, its numbers worked out. `stars`: the fallback when pp.rs can't
 * (the pool page's quick ones). */
export async function exportRows(p: Pool, stars: (slot: string) => number | undefined): Promise<ExportRow[]> {
  return Promise.all(
    slotCodes(p.categories).map(async (code): Promise<ExportRow> => {
      const k = kindOfSlot(p, code)!;
      const s = poolSlot(p, code);
      const c = slotChart(s);
      const base = { slot: code, kind: k.code, mods: modText(k.mods), note: s?.note ?? "" };
      if (!s || !c) return { ...base, beatmapId: s?.onlineId, md5: s?.md5, artist: "", title: "", version: "", creator: "", inLibrary: false };
      const r = rateOf(k.mods);
      const n = await slotNumbers(c.ppId, k.mods);
      return {
        ...base,
        beatmapId: c.beatmapId,
        setId: c.setId,
        md5: s.md5,
        artist: c.artist,
        title: c.title,
        version: c.version,
        creator: c.creator,
        stars: round(n?.stars ?? stars(code), 2),
        bpm: c.bpm ? round(c.bpm * r, 1) : undefined,
        length: c.length ? Math.round(c.length / r / 1000) : undefined,
        maxPp: n ? round(n.max, 0) : undefined,
        inLibrary: c.mapIdx !== undefined,
      };
    }),
  );
}

function round(v: number | undefined, digits: number): number | undefined {
  if (v === undefined || !Number.isFinite(v)) return undefined;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

const link = (r: ExportRow): string => (r.beatmapId ? `https://osu.ppy.sh/b/${r.beatmapId}` : "");
const clock = (secs: number | undefined): string => (secs === undefined ? "" : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`);

/** the columns, in English (a sheet's headings are its own business) */
const COLUMNS: [string, (r: ExportRow) => string | number | undefined][] = [
  ["Slot", (r) => r.slot],
  ["Mods", (r) => r.mods],
  ["Artist", (r) => r.artist],
  ["Title", (r) => r.title],
  ["Difficulty", (r) => r.version],
  ["Mapper", (r) => r.creator],
  ["Stars", (r) => r.stars],
  ["BPM", (r) => r.bpm],
  ["Length", (r) => clock(r.length)],
  ["Max pp", (r) => r.maxPp],
  ["Beatmap ID", (r) => r.beatmapId],
  ["Link", link],
  ["Note", (r) => r.note],
];

/** A CSV field: quoted when it has to be; a leading = + - @ is kept as text (no formulas). */
function csvField(v: string | number | undefined): string {
  if (v === undefined) return "";
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: ExportRow[]): string {
  const lines = [COLUMNS.map(([h]) => h), ...rows.map((r) => COLUMNS.map(([, get]) => get(r)))];
  // the BOM tells Excel it's UTF-8 (titles in Japanese and the like)
  return "﻿" + lines.map((l) => l.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/** Tab-separated, for pasting into a sheet: tabs and line breaks inside a field become spaces. */
export function toTsv(rows: ExportRow[]): string {
  const field = (v: string | number | undefined) => {
    const s = v === undefined ? "" : String(v).replace(/[\t\r\n]+/g, " ");
    return typeof v === "string" && /^[=+\-@]/.test(s) ? `'${s}` : s;
  };
  return [COLUMNS.map(([h]) => h), ...rows.map((r) => COLUMNS.map(([, get]) => get(r)))].map((l) => l.map(field).join("\t")).join("\n");
}

/** Everything about the pool, for tools. */
export function toJson(p: Pool, rows: ExportRow[], app: string): string {
  return JSON.stringify(
    {
      name: p.name,
      ruleset: poolRuleset(p),
      mode: p.mode,
      ...(p.mode === 3 && p.keys ? { keys: p.keys } : {}),
      kinds: p.categories.map((k) => ({ code: k.code, name: kindInfo(k.code).name, slots: k.count, mods: k.mods })),
      slots: rows.map((r) => ({
        slot: r.slot,
        kind: r.kind,
        mods: kindOfSlot(p, r.slot)?.mods ?? [],
        ...(r.beatmapId ? { beatmapId: r.beatmapId, link: link(r) } : {}),
        ...(r.setId ? { beatmapsetId: r.setId } : {}),
        ...(r.md5 ? { md5: r.md5 } : {}),
        ...(r.title ? { artist: r.artist, title: r.title, difficulty: r.version, mapper: r.creator } : {}),
        ...(r.stars !== undefined ? { stars: r.stars } : {}),
        ...(r.bpm !== undefined ? { bpm: r.bpm } : {}),
        ...(r.length !== undefined ? { length: r.length } : {}),
        ...(r.maxPp !== undefined ? { maxPp: r.maxPp } : {}),
        ...(r.title ? { inLibrary: r.inLibrary } : {}),
        ...(r.note ? { note: r.note } : {}),
      })),
      exported: new Date().toISOString(),
      app,
    },
    null,
    2,
  );
}

/** A file name from a pool's name: "RPRO Cup · Qualifiers" → "RPRO Cup - Qualifiers". */
export function fileName(name: string, ext: string): string {
  const base = name.replace(/[·•]/g, "-").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 100) || "pool";
  return `${base}.${ext}`;
}
