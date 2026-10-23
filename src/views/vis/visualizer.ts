/* visualizer.ts — the fullscreen player's Visualizer tab: one canvas, the chosen style (./styles)
 * drawn from a frame built here each animation frame.
 *
 * The song: lib/vis/analysis. The beat: the playing difficulty's timing points and kiai
 * (lib/vis/beat), at the song's time as you hear it (minus the output's latency, plus the offset
 * setting). The look: the cover's colours (lib/vis/palette), the accent, or a pair of your own,
 * gliding on a track change while the old cover fades out under the new one. A style change
 * crossfades too. Nothing moves while the song is paused once things have settled.
 */
import { thumbUrl } from "../../lib/api";
import { loadChart } from "../../lib/charts";
import { outputLatency } from "../../lib/eq";
import { t } from "../../lib/i18n";
import { DEFAULT_PREFS, setPrefs, store } from "../../lib/store";
import type { VisPrefs, VisStyle } from "../../lib/types";
import { Analysis } from "../../lib/vis/analysis";
import { beatAt, inKiai } from "../../lib/vis/beat";
import { css, hexRgb, mix, paletteOf, type Palette, type Rgb } from "../../lib/vis/palette";
import { player } from "../../player";
import { reduceMotion } from "../../ui/controls";
import { renderScale } from "../../ui/render-scale";
import { canvasFilters, soften } from "../../ui/soft-art";
import type { Art, Look, Style, VisFrame } from "./draw";
import { hifi } from "./styles/hifi";
import { ring } from "./styles/ring";
import { spectrum } from "./styles/spectrum";
import { stage } from "./styles/stage";
import { stars } from "./styles/stars";
import { wave } from "./styles/wave";

export const STYLES: { id: VisStyle; name: string; make: () => Style }[] = [
  { id: "spectrum", name: t("Spectrum"), make: spectrum },
  { id: "ring", name: t("Ring"), make: ring },
  { id: "wave", name: t("Wave"), make: wave },
  { id: "stars", name: t("Starfield"), make: stars },
  { id: "stage", name: t("Stage"), make: stage },
  { id: "hifi", name: "Hi-Fi", make: hifi },
];

/** "Your own" colours: two each */
export const OWN_COLORS: { a: string; b: string; name: string }[] = [
  { a: "#ff5f8f", b: "#ffb86b", name: t("Pink and orange") },
  { a: "#4fe3c1", b: "#3d8bff", name: t("Teal and blue") },
  { a: "#b8ff5c", b: "#2fd27a", name: t("Lime and green") },
  { a: "#ff6b5b", b: "#ffd36b", name: t("Red and yellow") },
  { a: "#a98bff", b: "#ff7ad9", name: t("Purple and pink") },
  { a: "#e9e9ee", b: "#8a8a96", name: t("White and grey") },
];

/** The visualizer's settings, with defaults for whatever an older save lacks. */
export function visPrefs(): VisPrefs {
  return { ...DEFAULT_PREFS.visualizer, ...store.prefs.visualizer };
}

export function setVis(patch: Partial<VisPrefs>): void {
  setPrefs({ visualizer: { ...visPrefs(), ...patch } });
}

const WHITE: Rgb = [255, 255, 255];
const lookOf = (p: Palette): Look => ({ a: p.a, b: p.b, ink: mix(p.a, WHITE, 0.7) });

/** Draws the cover over a w×h canvas, cropped to fit (`over` > 1 zooms in). */
function fit(c: CanvasRenderingContext2D, img: HTMLImageElement, w: number, h: number, over = 1): void {
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight) * over;
  c.drawImage(img, (w - img.naturalWidth * s) / 2, (h - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
}

/** A small blurred copy of the cover (`amount` 0–1, prefs `blur`); null at 0, where the cover is used as it is. */
function blurCopy(img: HTMLImageElement, amount: number): HTMLCanvasElement | null {
  const px = Math.round(24 * amount);
  if (px <= 0) return null;
  if (!canvasFilters) {
    // no canvas filters (WebKitGTK): blurred by hand, at half the size to keep that quick
    const blur = document.createElement("canvas");
    blur.width = 160;
    blur.height = 90;
    const b = blur.getContext("2d", { willReadFrequently: true })!;
    fit(b, img, 160, 90);
    return soften(b, 160, 90, px / 2, { saturate: 1.35, brightness: 1 }) ? blur : null;
  }
  const blur = document.createElement("canvas");
  blur.width = 320;
  blur.height = 180;
  const b = blur.getContext("2d")!;
  b.filter = `blur(${px}px) saturate(1.35)`;
  // zoomed in far enough that the blur's see-through edges fall outside
  fit(b, img, 320, 180, 1 + (4 * px) / 180);
  return blur;
}

/** The cover as an image, a blurred copy and its palette; null when it can't be read. */
async function loadArt(url: string, amount: number): Promise<{ art: Art; palette: Palette | null } | null> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  try {
    await img.decode();
  } catch {
    return null;
  }
  let palette: Palette | null = null;
  try {
    const small = document.createElement("canvas");
    small.width = 48;
    small.height = 27;
    const s = small.getContext("2d", { willReadFrequently: true })!;
    fit(s, img, 48, 27);
    palette = paletteOf(s.getImageData(0, 0, 48, 27).data);
  } catch (e) {
    console.warn("[vis] no palette", e);
  }
  return { art: { img, blur: blurCopy(img, amount) }, palette };
}

export class Visualizer {
  private readonly a = new Analysis();
  private style: Style;
  private styleId: VisStyle;
  private o: VisPrefs = visPrefs();
  private art: Art = { img: null, blur: null };
  /** the `blur` the current blurred copy was made with */
  private blurred: number;
  private prevArt: Art | null = null;
  private artMix = 1;
  private palette: Palette | null = null;
  private look: Look | null = null;
  private artJob = 0;
  private timing: { map: string; beats: number[]; kiai: number[] } | null = null;
  private meta = { title: "", artist: "", version: "" };
  private clock = 0;
  private lastBeat = Number.NaN;
  private kiai = 0;
  private flashT = 0;
  private lastFlash = 0;
  /** the previous style's last picture while the new one fades in */
  private fade: { snap: HTMLCanvasElement; k: number } | null = null;
  private accent = { at: -Infinity, a: [139, 124, 255] as Rgb, b: [201, 193, 255] as Rgb };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    /** asks for a frame when something arrives while nothing draws (a cover, the timing) */
    private readonly kick: () => void,
  ) {
    this.styleId = this.o.style;
    this.blurred = this.o.blur;
    this.style = (STYLES.find((s) => s.id === this.styleId) ?? STYLES[0]).make();
  }

  /** Picks up changed settings (a new style crossfades from the old one). */
  sync(): void {
    this.o = visPrefs();
    if (this.o.blur !== this.blurred) {
      this.blurred = this.o.blur;
      if (this.art.img instanceof HTMLImageElement) this.art = { ...this.art, blur: blurCopy(this.art.img, this.blurred) };
      this.kick();
    }
    if (this.o.style === this.styleId) return;
    const def = STYLES.find((s) => s.id === this.o.style) ?? STYLES[0];
    if (this.canvas.width && this.canvas.height && !reduceMotion()) {
      const snap = document.createElement("canvas");
      snap.width = this.canvas.width;
      snap.height = this.canvas.height;
      snap.getContext("2d")!.drawImage(this.canvas, 0, 0);
      this.fade = { snap, k: 1 };
    }
    this.styleId = def.id;
    this.style = def.make();
  }

  /** A new song or difficulty: its cover, words and timing. */
  setTrack(o: { bg: string | null; mapId: string | null; title: string; artist: string; version: string }): void {
    this.meta = { title: o.title, artist: o.artist, version: o.version };
    const job = ++this.artJob;
    const swap = (art: Art, palette: Palette | null) => {
      this.prevArt = this.art.img ? this.art : null;
      this.art = art;
      this.artMix = this.prevArt && !reduceMotion() ? 0 : 1;
      this.palette = palette;
      this.kick();
    };
    if (o.bg) {
      void loadArt(thumbUrl(o.bg, 1280), this.blurred).then((r) => {
        if (job !== this.artJob) return;
        if (r) swap(r.art, r.palette);
        else swap({ img: null, blur: null }, null);
      });
    } else swap({ img: null, blur: null }, null);
    if (!o.mapId) this.timing = null;
    else if (this.timing?.map !== o.mapId) {
      const map = o.mapId;
      this.timing = null;
      loadChart(map)
        .then((d) => {
          if (job !== this.artJob) return;
          this.timing = { map, beats: d.beats, kiai: d.kiai };
          this.kick();
        })
        .catch(() => {});
    }
    this.lastBeat = Number.NaN;
    this.a.reset();
  }

  private accentColors(): { a: Rgb; b: Rgb } {
    const now = performance.now();
    if (now - this.accent.at > 500) {
      const cs = getComputedStyle(document.documentElement);
      this.accent = { at: now, a: hexRgb(cs.getPropertyValue("--accent")), b: hexRgb(cs.getPropertyValue("--accent-ink")) };
    }
    return this.accent;
  }

  private targetLook(): Palette {
    const o = this.o;
    if (o.colors === "own") {
      const p = OWN_COLORS[o.own] ?? OWN_COLORS[0];
      return { a: hexRgb(p.a), b: hexRgb(p.b) };
    }
    if (o.colors === "cover" && this.palette) return this.palette;
    return this.accentColors();
  }

  /** Draws one frame into the canvas; `box` is the part between the bars. True while it still moves. */
  frame(dt: number, box: { top: number; bottom: number }): boolean {
    const c0 = this.canvas;
    const W = c0.clientWidth;
    const H = c0.clientHeight;
    if (!W || !H) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * renderScale();
    const bw = Math.round(W * dpr);
    const bh = Math.round(H * dpr);
    if (c0.width !== bw || c0.height !== bh) {
      c0.width = bw;
      c0.height = bh;
    }
    const c = c0.getContext("2d")!;
    const o = this.o;
    const playing = player.playing;
    const now = performance.now() / 1000;
    const reduce = reduceMotion();
    this.a.read(dt, now, playing, o.sensitivity, o.reaction);
    if (playing) this.clock += dt;

    // the beat, at the song's time as heard
    const rate = player.rate;
    const songMs = (player.audio.currentTime - outputLatency() * rate) * 1000 + o.offset;
    const tm = this.timing;
    const beat = tm ? beatAt(tm.beats, songMs) : null;
    const newBeat = !!beat && beat.key !== this.lastBeat;
    this.lastBeat = beat ? beat.key : Number.NaN;
    const pulse = beat ? (playing ? Math.exp(-(beat.phase * beat.length) / rate / 1000 / 0.12) * (beat.inBar === 0 ? 1 : 0.65) : 0) : this.a.kick;
    const amount = o.pulse * (reduce ? 0.3 : 1);
    const hit = Math.min(1, Math.max(pulse, this.a.kick * 0.8)) * amount;
    const kiaiOn = !!tm && o.kiai && playing && inKiai(tm.kiai, songMs);
    const target = kiaiOn ? 1 : 0;
    this.kiai += (target - this.kiai) * (1 - Math.exp(-dt / (target > this.kiai ? 0.25 : 0.6)));
    // flashes: a bar's first beat in kiai (under one a second at 150 BPM); without a beatmap strong kicks, twice a second at most
    if (!reduce && o.flashes !== "off" && playing) {
      if (beat && newBeat && beat.inBar === 0 && kiaiOn) this.flashT = 1;
      if (!beat && this.a.onset === "kick" && o.flashes === "full" && now - this.lastFlash > 0.5) {
        this.flashT = 0.8;
        this.lastFlash = now;
      }
    }
    const flash = this.flashT * (o.flashes === "full" ? 0.4 : o.flashes === "soft" ? 0.16 : 0);
    this.flashT *= Math.exp(-dt / 0.1);

    // colours glide to where they're going
    const goal = this.targetLook();
    const k = this.look ? 1 - Math.exp(-dt / 0.25) : 1;
    const a = this.look ? mix(this.look.a, goal.a, k) : goal.a;
    const b = this.look ? mix(this.look.b, goal.b, k) : goal.b;
    this.look = lookOf({ a, b });
    const settling = Math.abs(a[0] - goal.a[0]) + Math.abs(a[1] - goal.a[1]) + Math.abs(b[2] - goal.b[2]) > 1.5;
    if (this.artMix < 1) this.artMix = Math.min(1, this.artMix + dt / 0.5);

    const f: VisFrame = {
      c,
      W,
      H,
      x: 0,
      y: box.top,
      w: W,
      h: Math.max(1, H - box.top - box.bottom),
      dt,
      clock: this.clock,
      time: player.audio.currentTime / rate,
      playing,
      a: this.a,
      beat,
      newBeat,
      pulse,
      hit,
      kiai: this.kiai,
      flash,
      look: this.look,
      art: this.art,
      prevArt: this.prevArt,
      artMix: this.artMix,
      meta: this.meta,
      o,
    };
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.save();
    let moving = false;
    try {
      moving = this.style.draw(f);
    } catch (e) {
      console.error("[vis]", e);
    }
    c.restore();
    if (flash > 0.005) {
      c.fillStyle = css(mix(this.look.a, WHITE, 0.5), flash);
      c.fillRect(0, 0, W, H);
    }
    if (this.fade) {
      this.fade.k -= dt / 0.35;
      if (this.fade.k <= 0) this.fade = null;
      else {
        c.globalAlpha = this.fade.k;
        c.drawImage(this.fade.snap, 0, 0, W, H);
        c.globalAlpha = 1;
      }
    }
    return moving || this.a.moving || this.kiai > 0.01 || this.flashT > 0.01 || this.artMix < 1 || !!this.fade || settling;
  }
}
