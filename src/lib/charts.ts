/* charts.ts — chart data shared by the chart panel and the fullscreen playfield: small caches (charts, dans at rates),
 * pattern names, lookups over the flat note/timing arrays, and lazer's scroll speed. */
import { api } from "./api";
import { chartModsKey, type ChartMods } from "./mods";
import { store } from "./store";
import type { ChartData, DanRating, PatternName } from "./types";
import { t } from "./i18n";

const cache = new Map<string, Promise<ChartData>>();

/** A difficulty's chart, with the mods that change it (Easy, Hard Rock, Mirror) if any. */
export function loadChart(id: string, mods?: ChartMods): Promise<ChartData> {
  const modKey = mods ? chartModsKey(mods) : "";
  const key = modKey ? `${id}+${modKey}` : id;
  let p = cache.get(key);
  if (!p) {
    p = api.getChart(id, modKey ? mods : undefined);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    if (cache.size > 24) cache.delete(cache.keys().next().value!);
  }
  return p;
}

const danCache = new Map<string, Promise<DanRating | null>>();

/** The dan at a clock rate: 1× comes with the chart, other rates are asked for once each. */
export function danAt(mapId: string, d: ChartData, rate: number): Promise<DanRating | null> {
  if (Math.abs(rate - 1) < 1e-6) return Promise.resolve(d.dan ?? null);
  const key = `${mapId}@${rate.toFixed(2)}`;
  let p = danCache.get(key);
  if (!p) {
    p = api.getDan(mapId, rate);
    p.catch(() => danCache.delete(key));
    danCache.set(key, p);
    if (danCache.size > 200) danCache.delete(danCache.keys().next().value!);
  }
  return p;
}

export const PATTERNS: Record<PatternName, { label: string; hint: string }> = {
  stream: { label: "Stream", hint: t("Single notes in quick succession") },
  jumpstream: { label: "Jumpstream", hint: t("Streams with two-note chords mixed in") },
  handstream: { label: "Handstream", hint: t("Streams with chords of three or more notes") },
  chordjack: { label: "Chordjack", hint: t("Chords that keep hitting the same columns") },
  jacks: { label: "Jacks", hint: t("The same column hit repeatedly") },
  ln: { label: t("Long notes"), hint: t("Long notes held for most of the time") },
};

/** First index (multiple of 3) whose time is ≥ t in a flat [time, lane, length] array. */
export function lowerBound(notes: number[], t: number): number {
  let lo = 0;
  let hi = notes.length / 3;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid * 3] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo * 3;
}

/** BPM of the timing section at `t` (song ms), from the flat [time, beat length, meter] array. */
export function bpmAt(beats: number[], t: number): number {
  let len = beats[1] ?? 0;
  for (let i = 0; i < beats.length && beats[i] <= t; i += 3) len = beats[i + 1];
  return len > 0 ? 60_000 / len : 0;
}

// ── scroll speed, as lazer has it ─────────────────────────────────────────

export const SCROLL_SPEED_MIN = 1;
export const SCROLL_SPEED_MAX = 40;
/** lazer's default when it has never been changed */
const LAZER_DEFAULT_SPEED = 8;

/** lazer: at scroll speed `s`, a note takes 11485 / s ms (of real time) from the top of the
 * playfield to the judgement line; rate mods scale it with the music. */
export const scrollTime = (speed: number): number => 11485 / speed;

export function scrollSpeed(): { speed: number; lazer: number; fromLazer: boolean } {
  const lazer = store.snap?.mania?.scrollSpeed ?? LAZER_DEFAULT_SPEED;
  const own = store.prefs.scrollSpeed;
  return own == null ? { speed: lazer, lazer, fromLazer: true } : { speed: own, lazer, fromLazer: false };
}

/** lazer's "Up" scroll direction: notes rise towards a judgement line at the top. */
export const scrollUp = (): boolean => store.snap?.mania?.scrollDirection === "Up";
