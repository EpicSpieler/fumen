/* pool-showcase.ts — a pool as one picture to post (Discord, a tournament's sheet): its name and
 * numbers, the star ratings slot by slot, and every slot with its map's art, star rating and most
 * pp at its mods. Drawn on a canvas in Fumen's dark look (whatever the app's theme), at twice the
 * size it's laid out in.
 *
 * Library backgrounds come through fumen:// (which lets a canvas read them); osu!'s covers don't
 * (assets.ppy.sh doesn't allow it), so a map that isn't in the library gets its kind's colour. */
import { thumbUrl } from "../lib/api";
import { duration, fixed, num, srColor, srInk } from "../lib/format";
import { t } from "../lib/i18n";
import type { ExportRow } from "../lib/pool-export";
import { kindInfo, kindOfSlot, modText, poolRuleset, poolSlot, slotChart, slotCodes, type Pool } from "../lib/pools";

/** layout width (px) and how many pixels a layout pixel is */
const W = 1000;
const SCALE = 2;
const PAD = 40;
const CARD_H = 72;
const GAP = 10;
const ART_W = 128;

const C = {
  bg: "#0f0f13",
  card: "rgba(255, 255, 255, 0.045)",
  bars: "rgba(255, 255, 255, 0.03)",
  t1: "#f3f3f6",
  t2: "rgba(255, 255, 255, 0.72)",
  t3: "rgba(255, 255, 255, 0.5)",
  t4: "rgba(255, 255, 255, 0.3)",
};

function font(): string {
  return getComputedStyle(document.body).fontFamily || "sans-serif";
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
    setTimeout(() => resolve(img.complete && img.naturalWidth ? img : null), 8000);
  });
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number | [number, number, number, number]): void {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

/** Text cut to a width with an ellipsis. */
function fit(g: CanvasRenderingContext2D, text: string, max: number): string {
  if (g.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.measureText(text.slice(0, mid) + "…").width <= max) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + "…";
}

/** A code chip like the pool page's ("RC2"): its kind's colour, faint behind. Returns its width. */
function chip(g: CanvasRenderingContext2D, text: string, color: string, x: number, y: number, h = 22, family = font()): number {
  g.font = `700 11px ${family}`;
  const w = Math.max(38, g.measureText(text).width + 16);
  g.fillStyle = color;
  g.globalAlpha = 0.16;
  roundRect(g, x, y, w, h, 7);
  g.fill();
  g.globalAlpha = 1;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, x + w / 2, y + h / 2 + 0.5);
  g.textAlign = "left";
  return w;
}

/** The pool as a picture. `rows`: its numbers (exportRows). */
export async function drawShowcase(p: Pool, rows: ExportRow[]): Promise<HTMLCanvasElement> {
  await document.fonts.ready;
  const family = font();
  const codes = slotCodes(p.categories);
  const byCode = new Map(rows.map((r) => [r.slot, r]));
  const half = (W - PAD * 2 - GAP) / 2;

  // the height: head, bars, then each kind's head and its cards two by two
  const HEAD = 96;
  const BARS = 96;
  let height = PAD + HEAD + BARS + 24;
  for (const k of p.categories) height += 34 + Math.ceil(k.count / 2) * (CARD_H + GAP) + 14;
  height += 30 + PAD - 14;

  // the art, all at once
  const art = new Map<string, HTMLImageElement | null>();
  await Promise.all(
    codes.map(async (code) => {
      const c = slotChart(poolSlot(p, code));
      if (c?.bg) art.set(code, await loadImage(thumbUrl(c.bg, 320)));
    }),
  );

  const canvas = document.createElement("canvas");
  canvas.width = W * SCALE;
  canvas.height = Math.ceil(height * SCALE);
  const g = canvas.getContext("2d")!;
  g.scale(SCALE, SCALE);
  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, height);
  g.textBaseline = "alphabetic";

  // ── head ──
  let y = PAD;
  const stars = rows.map((r) => r.stars).filter((v): v is number => v !== undefined);
  const length = rows.reduce((s, r) => s + (r.length ?? 0), 0);
  g.fillStyle = C.t1;
  g.font = `700 30px ${family}`;
  g.fillText(fit(g, p.name, W - PAD * 2 - 120), PAD, y + 30);
  g.fillStyle = C.t3;
  g.font = `500 14px ${family}`;
  const sub = [
    poolRuleset(p),
    t("{n} of {total} slots", { n: num(rows.filter((r) => r.title).length), total: num(codes.length) }),
    stars.length ? `${fixed(Math.min(...stars), 2)}–${fixed(Math.max(...stars), 2)}★` : "",
    length ? t("{time} in all", { time: duration(length * 1000) }) : "",
  ]
    .filter(Boolean)
    .join("  ·  ");
  g.fillText(sub, PAD, y + 58);
  g.font = `700 14px ${family}`;
  g.fillStyle = C.t4;
  g.textAlign = "right";
  g.fillText("Fumen", W - PAD, y + 26);
  g.textAlign = "left";
  y += HEAD;

  // ── star ratings slot by slot ──
  g.fillStyle = C.bars;
  roundRect(g, PAD, y, W - PAD * 2, BARS, 14);
  g.fill();
  const lo = stars.length ? Math.min(...stars) : 0;
  const hi = stars.length ? Math.max(...stars) : 1;
  const floor = Math.max(0, lo - Math.max(0.6, (hi - lo) * 0.35));
  const inner = W - PAD * 2 - 28;
  const bw = (inner - (codes.length - 1) * 4) / codes.length;
  codes.forEach((code, i) => {
    const color = kindInfo(kindOfSlot(p, code)!.code).color;
    const x = PAD + 14 + i * (bw + 4);
    const v = byCode.get(code)?.stars;
    const top = y + 12;
    const bottom = y + BARS - 24;
    const h = v === undefined ? 0 : Math.max(0.08, (v - floor) / Math.max(0.01, hi - floor)) * (bottom - top);
    if (v === undefined) {
      g.strokeStyle = color;
      g.globalAlpha = 0.45;
      g.lineWidth = 1;
      roundRect(g, x + 0.5, bottom - 4 + 0.5, bw - 1, 3, 2);
      g.stroke();
      g.globalAlpha = 1;
    } else {
      g.fillStyle = color;
      g.globalAlpha = 0.85;
      roundRect(g, x, bottom - h, bw, h, [4, 4, 2, 2]);
      g.fill();
      g.globalAlpha = 1;
    }
    g.fillStyle = C.t3;
    g.font = `600 10px ${family}`;
    g.textAlign = "center";
    g.fillText(fit(g, code, bw + 2), x + bw / 2, y + BARS - 9);
    g.textAlign = "left";
  });
  y += BARS + 24;

  // ── the kinds and their slots ──
  for (const k of p.categories) {
    const info = kindInfo(k.code);
    const cw = chip(g, k.code, info.color, PAD, y, 22, family);
    g.fillStyle = C.t1;
    g.font = `650 15px ${family}`;
    g.textBaseline = "middle";
    g.fillText(info.name, PAD + cw + 10, y + 11.5);
    const mx = PAD + cw + 10 + g.measureText(info.name).width + 10;
    g.font = `500 13px ${family}`;
    g.fillStyle = C.t3;
    g.fillText(k.mods.length ? modText(k.mods) : t("No mods"), mx, y + 11.5);
    const own = (k.count === 1 ? [k.code] : Array.from({ length: k.count }, (_, i) => `${k.code}${i + 1}`)).map((c) => byCode.get(c)?.stars).filter((v): v is number => v !== undefined);
    if (own.length) {
      g.textAlign = "right";
      g.fillText(own.length === 1 ? `${fixed(own[0], 2)}★` : `${fixed(Math.min(...own), 2)}–${fixed(Math.max(...own), 2)}★`, W - PAD, y + 11.5);
      g.textAlign = "left";
    }
    g.textBaseline = "alphabetic";
    y += 34;

    const slots = k.count === 1 ? [k.code] : Array.from({ length: k.count }, (_, i) => `${k.code}${i + 1}`);
    slots.forEach((code, i) => {
      const x = PAD + (i % 2) * (half + GAP);
      const cy = y + Math.floor(i / 2) * (CARD_H + GAP);
      drawCard(g, family, x, cy, half, code, info.color, byCode.get(code), art.get(code) ?? null);
    });
    y += Math.ceil(k.count / 2) * (CARD_H + GAP) + 14;
  }

  // ── foot ──
  g.font = `500 11px ${family}`;
  g.fillStyle = C.t4;
  g.fillText(new Date().toLocaleDateString(), PAD, height - PAD + 10);
  g.textAlign = "right";
  g.fillText("fumen.dertesti.dev", W - PAD, height - PAD + 10);
  g.textAlign = "left";
  return canvas;
}

function drawCard(g: CanvasRenderingContext2D, family: string, x: number, y: number, w: number, code: string, color: string, r: ExportRow | undefined, img: HTMLImageElement | null): void {
  g.fillStyle = C.card;
  roundRect(g, x, y, w, CARD_H, 12);
  g.fill();

  // the art (cover-cropped), else the kind's colour
  g.save();
  roundRect(g, x, y, ART_W, CARD_H, [12, 0, 0, 12]);
  g.clip();
  if (img) {
    const s = Math.max(ART_W / img.naturalWidth, CARD_H / img.naturalHeight);
    const iw = img.naturalWidth * s;
    const ih = img.naturalHeight * s;
    g.drawImage(img, x + (ART_W - iw) / 2, y + (CARD_H - ih) / 2, iw, ih);
  } else {
    const grad = g.createLinearGradient(x, y, x + ART_W, y + CARD_H);
    grad.addColorStop(0, color);
    grad.addColorStop(1, C.bg);
    g.globalAlpha = r?.title ? 0.35 : 0.12;
    g.fillStyle = grad;
    g.fillRect(x, y, ART_W, CARD_H);
    g.globalAlpha = 1;
  }
  g.restore();

  // the slot's code over the art's corner
  g.save();
  g.fillStyle = "rgba(0, 0, 0, 0.55)";
  g.font = `700 11px ${family}`;
  const cw = Math.max(34, g.measureText(code).width + 14);
  roundRect(g, x + 8, y + 8, cw, 20, 6);
  g.fill();
  g.fillStyle = color;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(code, x + 8 + cw / 2, y + 18.5);
  g.restore();

  const tx = x + ART_W + 14;
  const right = x + w - 14;
  if (!r?.title) {
    g.fillStyle = C.t4;
    g.font = `500 13px ${family}`;
    g.fillText(t("empty"), tx, y + CARD_H / 2 + 4);
    return;
  }

  // the star rating, and the most pp under it
  g.font = `700 12px ${family}`;
  let sw = 0;
  if (r.stars !== undefined) {
    const text = fixed(r.stars, 2);
    sw = g.measureText(text).width + 16;
    g.fillStyle = srColor(r.stars);
    roundRect(g, right - sw, y + 12, sw, 20, 10);
    g.fill();
    g.fillStyle = srInk(r.stars);
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, right - sw / 2, y + 22.5);
    g.textAlign = "left";
    g.textBaseline = "alphabetic";
  }
  if (r.maxPp !== undefined) {
    g.textAlign = "right";
    g.font = `500 11px ${family}`;
    g.fillStyle = C.t3;
    const ppw = g.measureText("pp").width;
    g.fillText("pp", right, y + 54);
    g.font = `650 13px ${family}`;
    g.fillStyle = C.t1;
    g.fillText(num(r.maxPp), right - ppw - 3, y + 54);
    g.textAlign = "left";
  }

  const textW = right - tx - Math.max(sw, 56) - 12;
  g.fillStyle = C.t1;
  g.font = `650 14px ${family}`;
  g.fillText(fit(g, r.title, textW), tx, y + 24);
  g.fillStyle = C.t3;
  g.font = `500 12px ${family}`;
  g.fillText(fit(g, `${r.artist} · ${r.version} · ${r.creator}`, textW), tx, y + 42);
  const facts = [r.length !== undefined ? duration(r.length * 1000) : "", r.bpm ? `${num(Math.round(r.bpm))} BPM` : "", r.mods].filter(Boolean).join(" · ");
  g.fillStyle = C.t4;
  g.font = `500 11px ${family}`;
  g.fillText(fit(g, facts, textW), tx, y + 59);
}

/** The picture as PNG bytes. */
export function pngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a)), reject) : reject(new Error("no image"))), "image/png"),
  );
}
