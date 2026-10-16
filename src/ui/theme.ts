/* theme.ts — accent colour, ambient background and themes.
 *
 * - The accent comes from content (the beatmap background on screen or playing) or is fixed.
 *   Every source colour is clamped in HSL so it works as a surface AND as text.
 * - --accent / --accent-ink are registered with @property, so changes glide (.9s).
 * - Ambient: the current content image heavily blurred behind the app, crossfading on change.
 */
import { t } from "../lib/i18n";
import { DEFAULT_ACCENT, store } from "../lib/store";

export const ACCENT_PRESETS = [
  { label: t("Violet"), color: "#8b7cff" },
  { label: t("Magenta"), color: "#e040fb" },
  { label: t("Pink"), color: "#ff66aa" },
  { label: t("Coral"), color: "#ff7a5c" },
  { label: t("Amber"), color: "#f0a63a" },
  { label: t("Lime"), color: "#8bd450" },
  { label: t("Teal"), color: "#39c5bb" },
  { label: t("Sky"), color: "#4fa8ff" },
];

// ── colour maths ───────────────────────────────────────────────────────────
type RGB = [number, number, number];

function hexToRgb(hex: string): RGB | null {
  const h = hex.trim().replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const v = parseInt(n, 16);
  if (!Number.isFinite(v) || n.length !== 6) return null;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function rgbToHsl(r: number, g: number, b: number): RGB {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h * 360, s, l];
}

function hslToRgb(h: number, s: number, l: number): RGB {
  h = (((h % 360) + 360) % 360) / 360;
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (s === 0) return [l * 255, l * 255, l * 255].map(Math.round) as RGB;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)].map((v) => Math.round(v * 255)) as RGB;
}

const toHex = (rgb: number[]): string => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));

function luminance([r, g, b]: RGB): number {
  const f = (c: number) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Bounded accent variants from any source colour. `light`: for the light theme, where the ink
 * (accent as text) has to be dark instead of light. */
export function deriveAccent(color: string, light = false): { accent: string; ink: string; onAccent: string } {
  const rgb = hexToRgb(color) ?? hexToRgb(DEFAULT_ACCENT)!;
  const [h, s0, l0] = rgbToHsl(...rgb);
  const s = clamp(s0, 0.55, 0.92);
  const l = clamp(l0, 0.56, 0.68);
  const accent = hslToRgb(h, s, l);
  const ink = light ? hslToRgb(h, clamp(s, 0.55, 0.9), clamp(l - 0.2, 0.38, 0.46)) : hslToRgb(h, clamp(s, 0.5, 0.85), clamp(l + 0.18, 0.76, 0.85));
  return { accent: toHex(accent), ink: toHex(ink), onAccent: luminance(accent) > 0.32 ? "#0b0c0e" : "#ffffff" };
}

// ── accent ─────────────────────────────────────────────────────────────────
let contentAccent: string | null = null;

function applyAccent(color: string): void {
  const light = store.prefs.theme === "light";
  const a = deriveAccent(color, light);
  const root = document.documentElement.style;
  // the ink on the dark stages the light theme keeps (the fullscreen player)
  root.setProperty("--accent-ink-dark", light ? deriveAccent(color).ink : a.ink);
  root.setProperty("--accent", a.accent);
  root.setProperty("--accent-ink", a.ink);
  root.setProperty("--on-accent", a.onAccent);
}

function refreshAccent(): void {
  const p = store.prefs;
  applyAccent(p.accentMode === "dynamic" && contentAccent ? contentAccent : p.accent || DEFAULT_ACCENT);
}

/** Average colour of an image, weighted by saturation (otherwise everything averages to grey-brown). */
const colorCache = new Map<string, string | null>();
export function colorFromImage(url: string): Promise<string | null> {
  if (colorCache.has(url)) return Promise.resolve(colorCache.get(url)!);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => {
      try {
        const N = 48;
        const c = document.createElement("canvas");
        c.width = N;
        c.height = N;
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0, N, N);
        const d = ctx.getImageData(0, 0, N, N).data;
        let r = 0;
        let g = 0;
        let b = 0;
        let w = 0;
        for (let i = 0; i < d.length; i += 4) {
          const R = d[i];
          const G = d[i + 1];
          const B = d[i + 2];
          const mx = Math.max(R, G, B);
          const mn = Math.min(R, G, B);
          const sat = mx === 0 ? 0 : (mx - mn) / mx;
          if ((mx < 30 || mx > 245) && sat < 0.18) continue;
          const wt = sat * sat + 0.02;
          r += R * wt;
          g += G * wt;
          b += B * wt;
          w += wt;
        }
        const out = w > 0 ? toHex([r / w, g / w, b / w].map((v) => Math.round(clamp(v, 0, 255)))) : null;
        colorCache.set(url, out);
        resolve(out);
      } catch {
        colorCache.set(url, null);
        resolve(null);
      }
    };
    img.onerror = () => {
      colorCache.set(url, null);
      resolve(null);
    };
    img.src = url;
  });
}

// ── ambient ────────────────────────────────────────────────────────────────
let ambientUrl: string | null = null;

function ambientRoot(): HTMLElement {
  let el = document.getElementById("ambient");
  if (!el) {
    el = document.createElement("div");
    el.id = "ambient";
    el.className = "ambient";
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = `<div class="ambient-scrim"></div>`;
    document.body.prepend(el);
  }
  return el;
}

function setAmbient(url: string | null): void {
  if (url === ambientUrl) return;
  ambientUrl = url;
  const root = ambientRoot();
  if (!store.prefs.ambient || !url) {
    root.querySelectorAll(".ambient-art").forEach((n) => n.classList.remove("on"));
    return;
  }
  const img = new Image();
  img.decoding = "async";
  img.className = "ambient-art";
  img.alt = "";
  img.onload = () => {
    if (ambientUrl !== url) return;
    root.insertBefore(img, root.querySelector(".ambient-scrim"));
    requestAnimationFrame(() => requestAnimationFrame(() => img.classList.add("on")));
    const layers = [...root.querySelectorAll(".ambient-art")];
    layers.slice(0, -1).forEach((n) => n.classList.remove("on"));
    setTimeout(() => [...root.querySelectorAll(".ambient-art")].slice(0, -1).forEach((n) => n.remove()), 1000);
  };
  img.src = url;
}

/**
 * Reports the image that currently "owns" the screen (set page background, playing track).
 * Drives ambient + dynamic accent; `null` falls back to the fixed accent.
 */
let contentToken = 0;
export function setContentArt(url: string | null): void {
  setAmbient(url);
  const token = ++contentToken;
  if (!url) {
    contentAccent = null;
    refreshAccent();
    return;
  }
  colorFromImage(url).then((c) => {
    if (token !== contentToken) return;
    contentAccent = c;
    refreshAccent();
  });
}

export function applyAppearance(): void {
  const p = store.prefs;
  const root = document.documentElement;
  root.dataset.theme = p.theme;
  root.classList.toggle("reduce-motion", p.reduceMotion);
  refreshAccent();
  document.body.classList.toggle("ambient-off", !p.ambient);
  if (!p.ambient) {
    document.getElementById("ambient")?.querySelectorAll(".ambient-art").forEach((n) => n.classList.remove("on"));
  } else if (ambientUrl) {
    const u = ambientUrl;
    ambientUrl = null;
    setAmbient(u);
  }
}
