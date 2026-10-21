/* pools.ts — map pools (src-tauri/src/pools.rs): kinds of slot with the mods they're played
 * with, the slots ("RC2", "TB"), and the difficulties in them. Presets for osu!mania tournaments
 * (RC LN HB SV EX TB, the RPRO bot's kinds) and the other rulesets (NM HD HR DT FM TB); the
 * player can make their own. A slot's numbers (star rating, pp) come from src-tauri/src/pp.rs at
 * the slot's mods.
 *
 * A slot can hold a difficulty that isn't in the library: its chart comes off the mirrors, the
 * slot keeps what it says (PoolOnline), and once the set is in the library the slot shows the
 * library's. */
import { api, asApiError } from "./api";
import { displayArtist, displayTitle } from "./format";
import { t } from "./i18n";
import { mapIndexOf } from "./history";
import { Emitter, events, store } from "./store";
import { toast } from "../ui/controls";

export interface PoolKind {
  /** one to four capital letters */
  code: string;
  count: number;
  mods: string[];
}

export interface PoolSlot {
  slot: string;
  /** the library difficulty in it (none: not in the library) */
  map?: string;
  md5?: string;
  onlineId?: number;
  note: string;
  /** not in the library: what its chart says */
  online?: PoolOnline;
}

/** A difficulty that isn't in the library, as its slot keeps it (src-tauri/src/pools.rs). */
export interface PoolOnline {
  beatmapId: number;
  setId?: number;
  title: string;
  titleUnicode?: string;
  artist: string;
  artistUnicode?: string;
  creator: string;
  version: string;
  mode: number;
  keys: number;
  /** ms */
  length: number;
  bpm: number;
  objects: number;
  holds: number;
  /** without mods */
  sr: number;
  category?: string;
}

export interface Pool {
  id: string;
  name: string;
  /** 0 osu!, 1 osu!taiko, 2 osu!catch, 3 osu!mania */
  mode: number;
  /** osu!mania: the key count */
  keys?: number;
  categories: PoolKind[];
  note: string;
  created: number;
  updated: number;
  /** the filled slots, in the pool's order */
  slots: PoolSlot[];
}

/** What a kind of slot is called, and its colour (content: the same kind looks the same everywhere). */
const KINDS: Record<string, { name: string; color: string }> = {
  RC: { name: t("Rice"), color: "#6ea8fe" },
  LN: { name: t("Long notes"), color: "#ff9f6b" },
  HB: { name: t("Hybrid"), color: "#b388ff" },
  SV: { name: t("Scroll speed changes"), color: "#5fd4a0" },
  EX: { name: t("Extra"), color: "#ffd166" },
  NM: { name: "No Mod", color: "#6ea8fe" },
  HD: { name: "Hidden", color: "#ffd166" },
  HR: { name: "Hard Rock", color: "#ff6b7a" },
  DT: { name: "Double Time", color: "#b388ff" },
  FM: { name: "Free Mod", color: "#5fd4a0" },
  TB: { name: t("Tiebreaker"), color: "#d6d6dc" },
};
/** colours for the player's own kinds */
const SPARE = ["#7fd1e8", "#f78fb3", "#c3e88d", "#f6b26b", "#a0a0ff", "#e8c07f"];

export function kindInfo(code: string): { name: string; color: string } {
  const known = KINDS[code];
  if (known) return known;
  let h = 0;
  for (const c of code) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { name: code, color: SPARE[h % SPARE.length] };
}

/** The kinds a new pool starts with, by ruleset. */
export function presetKinds(mode: number): PoolKind[] {
  if (mode === 3)
    return [
      { code: "RC", count: 4, mods: [] },
      { code: "LN", count: 3, mods: [] },
      { code: "HB", count: 2, mods: [] },
      { code: "SV", count: 1, mods: [] },
      { code: "EX", count: 1, mods: [] },
      { code: "TB", count: 1, mods: [] },
    ];
  return [
    { code: "NM", count: 4, mods: [] },
    { code: "HD", count: 2, mods: ["HD"] },
    { code: "HR", count: 2, mods: ["HR"] },
    { code: "DT", count: 3, mods: ["DT"] },
    { code: "FM", count: 2, mods: [] },
    { code: "TB", count: 1, mods: [] },
  ];
}

/** The slots of some kinds, in order ("RC1" … "RC4", "TB"): as pools.rs makes them. */
export function slotCodes(kinds: readonly PoolKind[]): string[] {
  return kinds.flatMap((k) => (k.count === 1 ? [k.code] : Array.from({ length: k.count }, (_, i) => `${k.code}${i + 1}`)));
}

/** The kind a slot is of. */
export function kindOfSlot(pool: Pool, slot: string): PoolKind | undefined {
  const code = slot.replace(/\d+$/, "");
  return pool.categories.find((k) => k.code === code);
}

/** The clock rate a kind's mods set. */
export const rateOf = (mods: readonly string[]): number => (mods.includes("DT") ? 1.5 : mods.includes("HT") ? 0.75 : 1);
/** …and the rest of them, as pp.rs takes them */
export const otherMods = (mods: readonly string[]): string[] => mods.filter((m) => m !== "DT" && m !== "HT");
/** "HDDT", or "" */
export const modText = (mods: readonly string[]): string => mods.join("");

export const poolSlot = (pool: Pool, slot: string): PoolSlot | undefined => pool.slots.find((s) => s.slot === slot);

/** A slot's difficulty as a snapshot index (when it's in the library). */
export function slotMapIdx(s: PoolSlot | undefined): number | undefined {
  return s?.map ? mapIndexOf(s.map) : undefined;
}

/** A slot's difficulty the same way, in the library or not. */
export interface SlotChart {
  /** the library's difficulty (snapshot index) */
  mapIdx?: number;
  /** not in the library */
  online?: PoolOnline;
  /** what pp.rs takes: the library's id, or "o" and osu!'s */
  ppId: string;
  title: string;
  artist: string;
  version: string;
  creator: string;
  /** a library background (for thumbUrl), else osu!'s set for its cover */
  bg?: string;
  setId?: number;
  beatmapId?: number;
  mode: number;
  /** ms, at 1× */
  length: number;
  bpm: number;
  objects: number;
  holds: number;
  category?: string;
}

export function slotChart(s: PoolSlot | undefined): SlotChart | undefined {
  if (!s) return undefined;
  const snap = store.snap;
  const i = slotMapIdx(s);
  if (i !== undefined && snap) {
    const m = snap.maps[i];
    const set = snap.sets[m.set];
    return {
      mapIdx: i,
      ppId: m.id,
      title: displayTitle(set, store.prefs.unicode),
      artist: displayArtist(set, store.prefs.unicode),
      version: m.version,
      creator: set.creator,
      bg: m.bg ?? set.bg,
      setId: set.onlineId ?? undefined,
      beatmapId: m.onlineId ?? s.onlineId,
      mode: m.mode,
      length: m.length,
      bpm: m.bpm,
      objects: m.objects,
      holds: m.holds,
      category: m.category,
    };
  }
  const o = s.online;
  if (!o) return undefined;
  const uni = store.prefs.unicode;
  return {
    online: o,
    ppId: `o${o.beatmapId}`,
    title: (uni && o.titleUnicode) || o.title,
    artist: (uni && o.artistUnicode) || o.artist,
    version: o.version,
    creator: o.creator,
    setId: o.setId,
    beatmapId: o.beatmapId,
    mode: o.mode,
    length: o.length,
    bpm: o.bpm,
    objects: o.objects,
    holds: o.holds,
    category: o.category,
  };
}

/** "osu!mania 4K", "osu!" */
export function poolRuleset(p: Pool): string {
  const name = ["osu!", "osu!taiko", "osu!catch", "osu!mania"][p.mode] ?? "osu!";
  return p.mode === 3 && p.keys ? `${name} ${p.keys}K` : name;
}

/** Whether a library difficulty can go into a pool (its ruleset, and key count in osu!mania). */
export function fitsPool(p: Pool, mapIdx: number): boolean {
  const m = store.snap?.maps[mapIdx];
  if (!m || m.mode !== p.mode) return false;
  return p.mode !== 3 || !p.keys || Math.round(m.cs) === p.keys;
}

// ── numbers ─────────────────────────────────────────────────────────────

export interface SlotNumbers {
  stars: number;
  /** pp for a perfect play */
  max: number;
}

const numbers = new Map<string, Promise<SlotNumbers | null>>();

/** A library difficulty's star rating and most pp at a kind's mods (kept for the session). */
export function slotNumbers(mapId: string, mods: readonly string[]): Promise<SlotNumbers | null> {
  const key = `${mapId}|${modText(mods)}`;
  let p = numbers.get(key);
  if (!p) {
    p = api.getPp(mapId, otherMods(mods), rateOf(mods), []).then(
      (s) => ({ stars: s.stars, max: s.max }),
      () => null,
    );
    numbers.set(key, p);
  }
  return p;
}

// ── out of Fumen ────────────────────────────────────────────────────────

/** A pool the way the RPRO bot takes it: "SLOT link" per line. Slots without osu!'s id are left
 * out (they're counted). */
export function rproText(p: Pool): { text: string; left: string[] } {
  const lines: string[] = [];
  const left: string[] = [];
  for (const code of slotCodes(p.categories)) {
    const s = poolSlot(p, code);
    if (!s) continue;
    const id = s.onlineId ?? (s.map ? store.snap?.maps[slotMapIdx(s) ?? -1]?.onlineId : undefined);
    if (id) lines.push(`${code} https://osu.ppy.sh/b/${id}`);
    else left.push(code);
  }
  return { text: lines.join("\n"), left };
}

// ── the list ────────────────────────────────────────────────────────────

export const poolEvents = new Emitter<{ pools: Pool[] }>();

let list: Pool[] = [];
let loaded = false;

export const pools = (): Pool[] => list;
export const poolById = (id: string): Pool | undefined => list.find((p) => p.id === id);
export const poolsLoaded = (): boolean => loaded;

let started = false;

export function initPools(): void {
  if (started) return;
  started = true;
  void loadPools();
  // a rescan can bring back (or take away) difficulties: the ids are looked up again
  events.on("library", () => void loadPools());
}

export async function loadPools(): Promise<void> {
  try {
    list = await api.getPools();
    loaded = true;
    poolEvents.emit("pools", list);
  } catch (e) {
    console.warn("[pools]", asApiError(e).message);
  }
}

/** Runs a change, then reloads; a failure is a toast (`fail`: "Couldn't …", translated). */
async function change<T>(run: () => Promise<T>, fail: string): Promise<T | undefined> {
  try {
    const out = await run();
    await loadPools();
    return out;
  } catch (e) {
    toast(`${fail} ${asApiError(e).message}`, { kind: "danger" });
    await loadPools();
    return undefined;
  }
}

export const createPool = (name: string, mode: number, keys: number | null, categories: PoolKind[]) =>
  change(() => api.createPool(name, mode, keys, categories), t("Couldn't make the pool."));
export const updatePool = (id: string, patch: { name?: string; categories?: PoolKind[]; note?: string }) =>
  change(() => api.updatePool(id, patch), t("Couldn't change the pool."));
export const deletePool = (id: string) => change(() => api.deletePool(id), t("Couldn't delete the pool."));
export const setPoolSlot = (id: string, slot: string, mapIdx: number) =>
  change(() => api.setPoolSlot(id, slot, store.snap!.maps[mapIdx].id), t("Couldn't put the map into the pool."));
/** osu!'s difficulty by link or number: the library's, or its chart off the mirrors. Throws (the
 * picker says why). */
export async function setPoolSlotOnline(id: string, slot: string, link: string): Promise<void> {
  try {
    await api.setPoolSlotOnline(id, slot, link);
  } finally {
    await loadPools();
  }
}
export const clearPoolSlot = (id: string, slot: string) => change(() => api.clearPoolSlot(id, slot), t("Couldn't take the map out."));
export const swapPoolSlots = (id: string, a: string, b: string) => change(() => api.swapPoolSlots(id, a, b), t("Couldn't move the map."));
export const setPoolSlotNote = (id: string, slot: string, note: string) => change(() => api.setPoolSlotNote(id, slot, note), t("Couldn't save the note."));
