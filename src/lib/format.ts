/* Formatting + osu! domain colours. Colours here are *content* (difficulty, grade), not decoration. */
import type { MapRow, SetRow } from "./types";

export const MODE_LABEL = ["osu!", "osu!taiko", "osu!catch", "osu!mania"] as const;
export const MODE_SHORT = ["osu!", "taiko", "catch", "mania"] as const;

export const modeLabel = (mode: number, ruleset?: string): string =>
  MODE_LABEL[mode as 0 | 1 | 2 | 3] ?? ruleset ?? "Custom";

export const STATUS_LABEL: Record<number, string> = {
  [-4]: "Modified",
  [-3]: "Local",
  [-2]: "Graveyard",
  [-1]: "WIP",
  0: "Pending",
  1: "Ranked",
  2: "Approved",
  3: "Qualified",
  4: "Loved",
};
export const statusLabel = (s: number): string => STATUS_LABEL[s] ?? "Local";

const nf = new Intl.NumberFormat("en-GB");
export const num = (n: number): string => nf.format(n);

export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export const bpm = (v: number): string => (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1));
export const stars = (sr: number): string => sr.toFixed(2);
export const pct = (v: number, digits = 2): string => `${(v * 100).toFixed(digits)}%`;

/** "7K" for mania, the ruleset name otherwise. */
export function keysOrMode(map: MapRow): string {
  return map.mode === 3 ? `${Math.round(map.cs)}K` : MODE_SHORT[map.mode as 0] ?? map.ruleset ?? "?";
}

/** Long-note share for mania; slider share elsewhere. */
export const holdRatio = (map: MapRow): number => (map.objects > 0 ? map.holds / map.objects : 0);

/** Average notes per second over the drain length. */
export const nps = (map: MapRow): number => (map.length > 0 ? map.objects / (map.length / 1000) : 0);

const rtf = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });
export function relativeTime(ms: number, now = Date.now()): string {
  const diff = (ms - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return "just now";
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["minute", 60],
    ["hour", 3600],
    ["day", 86400],
    ["week", 604800],
    ["month", 2629800],
    ["year", 31557600],
  ];
  let unit: Intl.RelativeTimeFormatUnit = "minute";
  let size = 60;
  for (const [u, s] of units) if (abs >= s) [unit, size] = [u, s];
  return rtf.format(Math.round(diff / size), unit);
}

const df = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
export const date = (ms: number): string => df.format(new Date(ms));

export function displayTitle(set: SetRow, unicode: boolean): string {
  return (unicode && set.titleUnicode) || set.title || set.titleUnicode || "Untitled";
}
export function displayArtist(set: SetRow, unicode: boolean): string {
  return (unicode && set.artistUnicode) || set.artist || set.artistUnicode || "Unknown artist";
}

// ── star rating colour (osu! difficulty spectrum, gamma-correct interpolation) ──
const SR_DOMAIN = [0.1, 1.25, 2, 2.5, 3.3, 4.2, 4.9, 5.8, 6.7, 7.7, 9];
const SR_RANGE = ["#4290fb", "#4fc0ff", "#4fffd5", "#7cff4f", "#f6f05c", "#ff8068", "#ff4e6f", "#c645b8", "#6563de", "#18158e", "#000000"].map(
  (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)),
);
const srCache = new Map<number, string>();

export function srColor(sr: number): string {
  if (sr < 0.1) return "#aaaaaa";
  if (sr >= 9) return "#000000";
  const key = Math.round(sr * 100);
  const hit = srCache.get(key);
  if (hit) return hit;
  let i = 0;
  while (i < SR_DOMAIN.length - 2 && sr > SR_DOMAIN[i + 1]) i++;
  const t = (sr - SR_DOMAIN[i]) / (SR_DOMAIN[i + 1] - SR_DOMAIN[i]);
  const g = 2.2;
  const c = SR_RANGE[i].map((a, k) => {
    const b = SR_RANGE[i + 1][k];
    const v = Math.pow(Math.pow(a / 255, g) * (1 - t) + Math.pow(b / 255, g) * t, 1 / g) * 255;
    return Math.round(v).toString(16).padStart(2, "0");
  });
  const out = `#${c.join("")}`;
  srCache.set(key, out);
  return out;
}

/** Text colour on a star-rating chip. */
export const srInk = (sr: number): string => (sr >= 6.5 ? "#ffd966" : "rgba(0, 0, 0, .78)");

/** Star-rating chip. Very high ratings are near-black, so they get a faint ring on dark surfaces. */
export function srChip(sr: number, extraClass = "", prefix = ""): string {
  const cls = `sr-chip${extraClass ? " " + extraClass : ""}${sr >= 7.7 ? " deep" : ""}`;
  return `<span class="${cls}" style="--c:${srColor(sr)};--ink:${srInk(sr)}">${prefix}${stars(sr)}</span>`;
}

// ── grades ──
const RANKS: Record<number, { label: string; color: string; silver?: boolean }> = {
  [-1]: { label: "F", color: "#ff5a5a" },
  0: { label: "D", color: "#ff5a5a" },
  1: { label: "C", color: "#ff8e5d" },
  2: { label: "B", color: "#e3b130" },
  3: { label: "A", color: "#88da20" },
  4: { label: "S", color: "#02b5c3" },
  5: { label: "S", color: "#c5d5dc", silver: true },
  6: { label: "SS", color: "#de31ae" },
  7: { label: "SS", color: "#d6d6e0", silver: true },
};
export const rankInfo = (rank: number) => RANKS[rank] ?? RANKS[-1];

export const esc = (s: string | number | undefined | null): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
