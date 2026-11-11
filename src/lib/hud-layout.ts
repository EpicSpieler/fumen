/* hud-layout.ts — where the live overlay's parts sit (src/obs/hud.ts, docs/OBS.md). Skins put
 * their own numbers in different places, so each part goes where the skin leaves room: pinned at
 * a point of the source (0–1 of its width and height) by one of its corners, edges or its middle,
 * at a size of its own. Arranged in Fumen (views/hud-editor.ts); the page follows at once. */

export type HudPartId = "bar" | "title" | "stars" | "combo" | "hp" | "acc" | "pp" | "lines" | "vis";

/** words keep their shape and grow as a whole; a line stretches across (its width is set); an
 * area has its width and height set */
export type HudShape = "words" | "line" | "area";

export const HUD_PARTS: readonly { id: HudPartId; shape: HudShape }[] = [
  { id: "bar", shape: "line" },
  { id: "title", shape: "words" },
  { id: "stars", shape: "words" },
  { id: "combo", shape: "words" },
  { id: "hp", shape: "line" },
  { id: "acc", shape: "words" },
  { id: "pp", shape: "words" },
  { id: "lines", shape: "words" },
  { id: "vis", shape: "area" },
];

export const shapeOf = (id: HudPartId): HudShape => HUD_PARTS.find((p) => p.id === id)?.shape ?? "words";

/** which of a part's points is pinned: 0 its left (top) edge, 0.5 its middle, 1 its right (bottom) */
export type Pin = 0 | 0.5 | 1;

export interface HudPart {
  on: boolean;
  /** the pinned point, 0–1 of the source's width and height */
  x: number;
  y: number;
  ax: Pin;
  ay: Pin;
  /** 1 = as made (a rem is 1/67.5 of the source's height) */
  size: number;
  /** lines and areas: how wide, 0–1 of the source's width */
  w: number;
  /** areas: how tall, 0–1 of the source's height */
  h: number;
}

export type HudLayout = Record<HudPartId, HudPart>;

export interface HudPrefs {
  layout: HudLayout;
}

/** A place on the source, 0–1 of its width and height. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** the margin along the source's edges: 3 rem, 48 px at 1080p */
export const MARGIN_X = 48 / 1920;
export const MARGIN_Y = 48 / 1080;
export const SIZE_MIN = 0.4;
export const SIZE_MAX = 3;

const part = (x: number, y: number, ax: Pin, ay: Pin, o: Partial<HudPart> = {}): HudPart => ({ on: true, x, y, ax, ay, size: 1, w: 0.16, h: 0.12, ...o });

/** Where everything sits at first: the progress along the top edge, the map in the corners above,
 * the combo with its health on the left, accuracy and pp on the right, the lamps along the floor.
 * The middle stays free (mania's columns, osu!'s playfield). */
export const DEFAULT_HUD: HudLayout = {
  bar: part(0, 0, 0, 0, { w: 1 }),
  title: part(MARGIN_X, 0.03, 0, 0),
  stars: part(1 - MARGIN_X, 0.03, 1, 0),
  combo: part(MARGIN_X, 0.69, 0, 1),
  hp: part(MARGIN_X, 0.715, 0, 0, { w: 0.14 }),
  lines: part(MARGIN_X, 0.745, 0, 0),
  acc: part(1 - MARGIN_X, 0.69, 1, 1),
  pp: part(1 - MARGIN_X, 0.77, 1, 1),
  vis: part(0, 1, 0, 1, { w: 1, h: 0.135 }),
};

export const DEFAULT_HUD_PREFS: HudPrefs = { layout: DEFAULT_HUD };

const num = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const pin = (v: unknown, d: Pin): Pin => (v === 0 || v === 0.5 || v === 1 ? v : d);

/** The overlay's settings from whatever was stored (missing or broken parts as they start). */
export function hudPrefs(v: unknown): HudPrefs {
  const o = (v && typeof v === "object" ? v : {}) as Partial<{ layout: Partial<Record<HudPartId, Partial<HudPart>>> }>;
  const given = (o.layout && typeof o.layout === "object" ? o.layout : {}) as Partial<Record<HudPartId, Partial<HudPart>>>;
  const layout = {} as HudLayout;
  for (const { id } of HUD_PARTS) {
    const d = DEFAULT_HUD[id];
    const g = (given[id] && typeof given[id] === "object" ? given[id] : {}) as Partial<HudPart>;
    layout[id] = {
      on: typeof g.on === "boolean" ? g.on : d.on,
      x: num(g.x, 0, 1, d.x),
      y: num(g.y, 0, 1, d.y),
      ax: pin(g.ax, d.ax),
      ay: pin(g.ay, d.ay),
      size: num(g.size, SIZE_MIN, SIZE_MAX, d.size),
      w: num(g.w, 0.02, 1, d.w),
      h: num(g.h, 0.02, 1, d.h),
    };
  }
  return { layout };
}

/** Where a part is, from its own measured size (words) or its set one (lines' width, areas). */
export function rectOf(p: HudPart, shape: HudShape, measured: { w: number; h: number }): Rect {
  const w = shape === "words" ? measured.w : p.w;
  const h = shape === "area" ? p.h : measured.h;
  return { x: p.x - p.ax * w, y: p.y - p.ay * h, w, h };
}

/** The pins that suit a place: a part grows away from the edge it's nearest to (in the middle
 * third it stays centred), and down from the top half, up from the bottom one. */
export function pinsFor(r: Rect): { ax: Pin; ay: Pin } {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return { ax: cx < 1 / 3 ? 0 : cx > 2 / 3 ? 1 : 0.5, ay: cy < 0.5 ? 0 : 1 };
}

/** `p` moved to `r` (what the editor shows), pinned the way that place suits. */
export function placeAt(p: HudPart, shape: HudShape, r: Rect): HudPart {
  const { ax, ay } = pinsFor(r);
  const out: HudPart = { ...p, ax, ay, x: r.x + ax * r.w, y: r.y + ay * r.h };
  if (shape !== "words") out.w = r.w;
  if (shape === "area") out.h = r.h;
  return out;
}

export interface Snapped {
  /** how far to move to sit on a guide (0 when none is near) */
  dx: number;
  dy: number;
  /** the guides it sits on, 0–1 across (x) and down (y) */
  gx: number | null;
  gy: number | null;
}

/** The lines a part snaps to: the edges, the margins, the middle, and the other parts' edges and middles. */
export function guides(others: readonly Rect[]): { x: number[]; y: number[] } {
  const x = [0, MARGIN_X, 0.5, 1 - MARGIN_X, 1];
  const y = [0, MARGIN_Y, 0.5, 1 - MARGIN_Y, 1];
  for (const o of others) {
    x.push(o.x, o.x + o.w / 2, o.x + o.w);
    y.push(o.y, o.y + o.h / 2, o.y + o.h);
  }
  return { x, y };
}

function nearest(edges: number[], lines: number[], within: number): { d: number; at: number } | null {
  let best: { d: number; at: number } | null = null;
  for (const e of edges)
    for (const l of lines) {
      const d = l - e;
      if (Math.abs(d) <= within && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: l };
    }
  return best;
}

/** How `r` moves to sit on the nearest guide within `within` (0–1 of the width, of the height):
 * its left edge, middle or right edge on one across, its top, middle or bottom on one down. */
export function snapRect(r: Rect, lines: { x: number[]; y: number[] }, within: { x: number; y: number }): Snapped {
  const sx = nearest([r.x, r.x + r.w / 2, r.x + r.w], lines.x, within.x);
  const sy = nearest([r.y, r.y + r.h / 2, r.y + r.h], lines.y, within.y);
  return { dx: sx?.d ?? 0, dy: sy?.d ?? 0, gx: sx?.at ?? null, gy: sy?.at ?? null };
}

/** One edge being dragged (`at`, 0–1) onto the nearest guide within `within`. */
export function snapEdge(at: number, lines: number[], within: number): { at: number; guide: number | null } {
  const s = nearest([at], lines, within);
  return s ? { at: s.at, guide: s.at } : { at, guide: null };
}
