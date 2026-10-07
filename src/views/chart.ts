/* chart.ts — one difficulty's chart, shown in an expanded difficulty row: note density over
 * time, an osu!mania playfield that follows the player, and what the patterns ask of you.
 *
 * The playfield follows the audio whenever this set is playing; otherwise it sits at a cursor
 * you move with the mouse wheel or by clicking the density graph. It only animates while the
 * song plays.
 */
import { api, asApiError } from "../lib/api";
import { duration, esc, num } from "../lib/format";
import { store } from "../lib/store";
import type { ChartData, PatternName } from "../lib/types";
import { player } from "../player";
import { icon } from "../ui/icons";

const cache = new Map<string, Promise<ChartData>>();

function loadChart(id: string): Promise<ChartData> {
  let p = cache.get(id);
  if (!p) {
    p = api.getChart(id);
    p.catch(() => cache.delete(id));
    cache.set(id, p);
    if (cache.size > 24) cache.delete(cache.keys().next().value!);
  }
  return p;
}

const PATTERNS: Record<PatternName, { label: string; hint: string }> = {
  stream: { label: "Stream", hint: "Single notes in quick succession" },
  jumpstream: { label: "Jumpstream", hint: "Streams with two-note chords mixed in" },
  handstream: { label: "Handstream", hint: "Streams with chords of three or more notes" },
  chordjack: { label: "Chordjack", hint: "Chords that keep hitting the same columns" },
  jacks: { label: "Jacks", hint: "The same column hit repeatedly" },
  ln: { label: "Long notes", hint: "Long notes held for most of the time" },
};

/** visible time above the judgement line, ms */
const SPANS = [700, 1000, 1400, 2000, 2800, 4000];
const FIELD_H = 440;
/** judgement line, px from the bottom of the playfield */
const JUDGE = 52;
const NOTE_H = 10;

/** Lane tones mirrored from the edges, like most mania skins: neutral / accent / centre. */
function laneTone(lane: number, keys: number): "n" | "a" | "c" {
  if (keys % 2 === 1 && lane === (keys - 1) / 2) return "c";
  return Math.min(lane, keys - 1 - lane) % 2 === 0 ? "n" : "a";
}

export class ChartPanel {
  readonly el: HTMLElement;
  private data: ChartData | null = null;
  private cursor = 0;
  private spanIdx = 3;
  private raf = 0;
  private offs: (() => void)[] = [];
  private dead = false;
  private field: HTMLCanvasElement | null = null;
  private graph: HTMLCanvasElement | null = null;
  private resize: ResizeObserver | null = null;
  private colors = { accent: "#8b7cff", ink: "#c9c1ff", read: 0 };
  /** longest hold, so holds that started above the window are still drawn */
  private maxHold = 0;
  private readonly audio: string | undefined;

  constructor(
    private setIdx: number,
    private mapIdx: number,
  ) {
    const snap = store.snap!;
    const map = snap.maps[mapIdx];
    const set = snap.sets[setIdx];
    this.audio = map.audio ?? set.audio;
    this.el = document.createElement("div");
    this.el.className = "chart";
    this.el.innerHTML = `
      <div class="chart-loading">
        <div class="skeleton" style="height:72px"></div>
        <div class="skeleton" style="height:44px;width:70%"></div>
        <div class="skeleton" style="height:120px"></div>
      </div>`;
    loadChart(map.id)
      .then((d) => !this.dead && this.render(d))
      .catch((e) => !this.dead && this.renderError(asApiError(e).message));
    this.offs.push(
      player.bus.on("state", () => this.syncLoop()),
      player.bus.on("track", () => this.syncLoop()),
    );
  }

  // ── time ──────────────────────────────────────────────────────────────

  /** This chart's song is the one in the player. */
  private following(): boolean {
    const np = player.now;
    return !!np && np.set === this.setIdx && np.audio === this.audio;
  }

  private time(): number {
    return this.following() ? player.audio.currentTime * 1000 : this.cursor;
  }

  /** The graph's time axis: the chart plus a second (an outro after the last note doesn't matter). */
  private total(): number {
    return this.data!.analysis.end + 1000;
  }

  private seek(ms: number): void {
    const t = Math.max(0, Math.min(this.total(), ms));
    if (this.following()) player.audio.currentTime = t / 1000;
    else this.cursor = t;
    this.draw();
  }

  // ── rendering ─────────────────────────────────────────────────────────

  private renderError(message: string): void {
    this.el.innerHTML = `<div class="chart-error">${icon("alert")}<span>Couldn't read this chart. ${esc(message)}</span></div>`;
  }

  private render(d: ChartData): void {
    this.data = d;
    const a = d.analysis;
    const snap = store.snap!;
    const map = snap.maps[this.mapIdx];
    const set = snap.sets[this.setIdx];
    const preview = (map.audio ? map.preview : undefined) ?? set.preview ?? -1;
    this.cursor = preview >= 0 ? preview : a.start;
    for (let i = 2; i < d.notes.length; i += 3) this.maxHold = Math.max(this.maxHold, d.notes[i]);

    const mania = d.mode === 3 && d.keys > 0;
    const fieldW = Math.min(d.keys * 44, 420);
    const stats: [string, string, string][] = [
      ["Peak", a.npsPeak.toFixed(1), "notes/s"],
      ["Average", a.npsAvg.toFixed(1), "notes/s"],
      ["Longest burst", a.longestBurst ? duration(a.longestBurst) : "–", "without a breather"],
    ];
    if (mania) {
      stats.push(["Long notes", `${Math.round(a.lnTime * 100)}%`, "of the time held"], ["Jacks", `${Math.round(a.jackRatio * 100)}%`, "of rows"]);
    } else {
      stats.push(["Objects", num(a.notes), `${num(a.holds)} with a length`]);
    }

    this.el.innerHTML = `
      <div class="chart-grid${mania ? "" : " no-field"}">
        ${
          mania
            ? `<div class="chart-field" style="--field-w:${fieldW}px">
                <canvas class="field-canvas" width="${fieldW}" height="${FIELD_H}" aria-label="Chart preview"></canvas>
                <div class="field-time num"></div>
                <div class="field-zoom">
                  <button class="icon-btn sm" type="button" data-zoom="1" data-tip="Show more" aria-label="Show more">${icon("minus")}</button>
                  <button class="icon-btn sm" type="button" data-zoom="-1" data-tip="Show less" aria-label="Show less">${icon("plus")}</button>
                </div>
              </div>`
            : ""
        }
        <div class="chart-side">
          <div class="chart-graph">
            <canvas class="graph-canvas" height="72" aria-label="Note density"></canvas>
            ${mania ? `<div class="graph-window"></div>` : ""}
            <div class="graph-head"></div>
            <div class="graph-tip num"></div>
          </div>
          <div class="graph-axis num"><span>0:00</span><span class="graph-hint">Notes per second${d.kiai.length ? " · kiai shaded" : ""}</span><span>${duration(this.total())}</span></div>
          <div class="chart-stats">
            ${stats.map(([k, v, s]) => `<div class="cstat"><span class="cstat-k">${k}</span><b class="num">${v}</b><span class="cstat-s">${s}</span></div>`).join("")}
          </div>
          ${mania ? this.maniaBlocks(d) : `<p class="chart-note">Pattern analysis covers osu!mania for now.</p>`}
          <div class="chart-actions">
            <button class="btn btn-sm chart-play" type="button">${icon("play", "ic-play")}${icon("pause", "ic-pause")}<span>Play from here</span></button>
            <span class="chart-help">${mania ? "Scroll the playfield or click the graph to move through the song." : "Click the graph to move through the song."}</span>
          </div>
        </div>
      </div>`;

    this.field = this.el.querySelector(".field-canvas");
    this.graph = this.el.querySelector(".graph-canvas");
    this.bind();
    this.resize = new ResizeObserver(() => this.drawGraph());
    this.resize.observe(this.el.querySelector(".chart-graph")!);
    this.drawGraph();
    this.syncLoop();
  }

  private maniaBlocks(d: ChartData): string {
    const a = d.analysis;
    const shown = a.patterns.filter((p) => p.share >= 0.005);
    const patterns = shown.length
      ? shown
          .map(
            (p) => `<div class="pat-row" data-tip="${esc(PATTERNS[p.pattern].hint)}">
              <span class="pat-name">${PATTERNS[p.pattern].label}</span>
              <div class="bar"><i style="width:${(p.share * 100).toFixed(1)}%"></i></div>
              <span class="pat-val num">${Math.round(p.share * 100)}%</span>
            </div>`,
          )
          .join("")
      : `<p class="chart-note">Light throughout: no pattern stands out.</p>`;

    const rows = a.chords.reduce((s, n) => s + n, 0) || 1;
    const chordNames = ["Singles", "Jumps", "Hands", "Quads+"];
    const chords = a.chords.map((n, i) => ({ name: chordNames[i], share: n / rows, i })).filter((c) => c.share > 0);

    const max = Math.max(1, ...a.lanes);
    const keys = d.keys;
    const half = Math.floor(keys / 2);
    const left = a.lanes.slice(0, half).reduce((s, n) => s + n, 0);
    const right = a.lanes.slice(keys - half).reduce((s, n) => s + n, 0);
    const centre = keys % 2 ? a.lanes[half] : 0;
    const hands = left + right || 1;
    const all = a.notes || 1;

    return `
      <div class="chart-cols">
        <section class="chart-block">
          <div class="label-caps">Patterns</div>
          ${patterns}
        </section>
        <section class="chart-block">
          <div class="label-caps">Chords</div>
          <div class="stack">${chords.map((c) => `<i class="stack-${c.i}" style="flex:${c.share}" data-tip="${c.name}: ${Math.round(c.share * 100)}%"></i>`).join("")}</div>
          <div class="stack-legend">${chords.map((c) => `<span><i class="stack-${c.i}"></i>${c.name} <b class="num">${Math.round(c.share * 100)}%</b></span>`).join("")}</div>
          <div class="label-caps lanes-label">Columns</div>
          <div class="lanes" style="--keys:${keys}">
            ${a.lanes.map((n, i) => `<i class="tone-${laneTone(i, keys)}" style="height:${Math.max(4, (n / max) * 100)}%" data-tip="Column ${i + 1}: ${num(n)} notes"></i>`).join("")}
          </div>
          ${
            keys > 1
              ? `<div class="hands num">Left hand <b>${Math.round((left / hands) * 100)}%</b> · right hand <b>${Math.round((right / hands) * 100)}%</b>${centre ? ` · middle column ${Math.round((centre / all) * 100)}% of all notes` : ""}</div>`
              : ""
          }
        </section>
      </div>`;
  }

  // ── drawing ───────────────────────────────────────────────────────────

  private readColors(): void {
    const now = performance.now();
    if (now - this.colors.read < 400) return;
    const cs = getComputedStyle(document.documentElement);
    this.colors = { accent: cs.getPropertyValue("--accent").trim() || "#8b7cff", ink: cs.getPropertyValue("--accent-ink").trim() || "#c9c1ff", read: now };
  }

  private toneColor(tone: "n" | "a" | "c"): string {
    return tone === "n" ? "#e9e9ee" : tone === "a" ? this.colors.accent : this.colors.ink;
  }

  private draw(): void {
    this.drawField();
    this.drawHead();
  }

  private drawField(): void {
    const c = this.field;
    const d = this.data;
    if (!c || !d) return;
    this.readColors();
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth || +c.width;
    const H = FIELD_H;
    if (c.width !== Math.round(W * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const keys = d.keys;
    const laneW = W / keys;
    const judgeY = H - JUDGE;
    const span = SPANS[this.spanIdx];
    const pxPerMs = judgeY / span;
    const t = this.time();
    const tTop = t + span;
    const tBottom = t - JUDGE / pxPerMs;
    const y = (ms: number) => judgeY - (ms - t) * pxPerMs;

    // columns
    ctx.fillStyle = "rgba(255,255,255,.045)";
    for (let i = 1; i < keys; i++) ctx.fillRect(Math.round(i * laneW), 0, 1, H);

    // bar lines
    ctx.fillStyle = "rgba(255,255,255,.08)";
    const b = d.beats;
    for (let i = 0; i < b.length; i += 3) {
      const t0 = b[i];
      const measure = b[i + 1] * (b[i + 2] || 4);
      const until = i + 3 < b.length ? b[i + 3] : Infinity;
      if (measure < 50 || t0 > tTop || until < tBottom) continue;
      for (let k = Math.max(0, Math.ceil((tBottom - t0) / measure)); ; k++) {
        const tm = t0 + k * measure;
        if (tm > tTop || tm >= until) break;
        ctx.fillRect(0, Math.round(y(tm)), W, 1);
      }
    }

    // keys under the judgement line light up while a note is being hit
    const lit = new Array<boolean>(keys).fill(false);
    const n = d.notes;
    let lo = lowerBound(n, tBottom - this.maxHold);
    const radius = Math.min(4, NOTE_H / 2);
    for (; lo < n.length && n[lo] <= tTop; lo += 3) {
      const start = n[lo];
      const lane = n[lo + 1];
      const len = n[lo + 2];
      const end = start + len;
      if (end < tBottom) continue;
      if (lane < 0 || lane >= keys) continue;
      const x = lane * laneW;
      const color = this.toneColor(laneTone(lane, keys));
      const passed = end < t - 30;
      if (Math.abs(start - t) < 70 || (len > 0 && start <= t && end >= t)) lit[lane] = true;
      ctx.globalAlpha = passed ? 0.22 : 1;
      if (len > 0) {
        const bodyW = laneW * 0.62;
        const top = y(end);
        const bottom = y(start);
        ctx.fillStyle = color;
        ctx.globalAlpha = passed ? 0.12 : 0.38;
        ctx.fillRect(x + (laneW - bodyW) / 2, top, bodyW, Math.max(0, bottom - top));
        ctx.globalAlpha = passed ? 0.22 : 0.9;
        roundRect(ctx, x + (laneW - bodyW) / 2, top - 3, bodyW, 6, 3);
        ctx.globalAlpha = passed ? 0.22 : 1;
      }
      ctx.fillStyle = color;
      roundRect(ctx, x + 3, y(start) - NOTE_H / 2, laneW - 6, NOTE_H, radius);
    }
    ctx.globalAlpha = 1;

    // judgement line + keys
    for (let i = 0; i < keys; i++) {
      ctx.fillStyle = lit[i] ? this.toneColor(laneTone(i, keys)) : "rgba(255,255,255,.06)";
      ctx.globalAlpha = lit[i] ? 0.35 : 1;
      roundRect(ctx, i * laneW + 3, judgeY + 10, laneW - 6, JUDGE - 18, 6);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.colors.accent;
    ctx.fillRect(0, judgeY - 1, W, 2);

    const label = this.el.querySelector<HTMLElement>(".field-time");
    if (label) label.textContent = duration(Math.max(0, t));
  }

  private drawGraph(): void {
    const c = this.graph;
    const d = this.data;
    if (!c || !d) return;
    this.readColors();
    const a = d.analysis;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth;
    const H = 72;
    if (!W) return;
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const total = this.total();
    const x = (ms: number) => (ms / total) * W;

    ctx.fillStyle = "rgba(255,255,255,.035)";
    for (let i = 0; i < d.breaks.length; i += 2) ctx.fillRect(x(d.breaks[i]), 0, x(d.breaks[i + 1]) - x(d.breaks[i]), H);
    ctx.fillStyle = this.colors.accent;
    ctx.globalAlpha = 0.12;
    for (let i = 0; i < d.kiai.length; i += 2) ctx.fillRect(x(d.kiai[i]), 0, x(d.kiai[i + 1]) - x(d.kiai[i]), H);

    const max = Math.max(1, ...a.density);
    const barW = x(1000);
    const gap = barW > 4 ? 1 : 0;
    ctx.globalAlpha = 0.85;
    for (let i = 0; i < a.density.length; i++) {
      const v = a.density[i];
      if (!v) continue;
      const h = Math.max(2, (v / max) * (H - 6));
      ctx.fillRect(x(a.start + i * 1000), H - h, Math.max(1, barW - gap), h);
    }
    ctx.globalAlpha = 1;
    this.drawHead();
  }

  /** Playhead and the playfield's visible window on the graph. */
  private drawHead(): void {
    if (!this.data) return;
    const total = this.total();
    const t = this.time();
    const f = Math.min(1, Math.max(0, t / total));
    this.el.querySelector<HTMLElement>(".graph-head")?.style.setProperty("left", `${f * 100}%`);
    const win = this.el.querySelector<HTMLElement>(".graph-window");
    if (win) {
      win.style.left = `${f * 100}%`;
      win.style.width = `${(SPANS[this.spanIdx] / total) * 100}%`;
    }
    const playing = this.following() && player.playing;
    const btn = this.el.querySelector<HTMLElement>(".chart-play");
    if (btn) {
      btn.classList.toggle("is-playing", playing);
      btn.querySelector("span")!.textContent = playing ? "Pause" : "Play from here";
    }
  }

  // ── playback loop ─────────────────────────────────────────────────────

  private syncLoop(): void {
    const run = !!this.data && this.following() && player.playing && this.el.isConnected;
    if (run && !this.raf) {
      const frame = () => {
        this.draw();
        this.raf = requestAnimationFrame(frame);
      };
      this.raf = requestAnimationFrame(frame);
    } else if (!run && this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    if (!run) this.draw();
  }

  // ── input ─────────────────────────────────────────────────────────────

  private bind(): void {
    const graphEl = this.el.querySelector<HTMLElement>(".chart-graph")!;
    const tip = this.el.querySelector<HTMLElement>(".graph-tip")!;
    const at = (e: PointerEvent) => {
      const r = graphEl.getBoundingClientRect();
      return { f: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), x: e.clientX - r.left };
    };
    let dragging = false;
    graphEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      dragging = true;
      graphEl.setPointerCapture(e.pointerId);
      this.seek(at(e).f * this.total());
    });
    graphEl.addEventListener("pointermove", (e) => {
      const { f, x } = at(e);
      const ms = f * this.total();
      const a = this.data!.analysis;
      const nps = a.density[Math.floor((ms - a.start) / 1000)] ?? 0;
      tip.textContent = `${duration(ms)} · ${nps} notes/s`;
      tip.style.left = `${x}px`;
      if (dragging) this.seek(ms);
    });
    const end = () => (dragging = false);
    graphEl.addEventListener("pointerup", end);
    graphEl.addEventListener("pointercancel", end);

    this.field?.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        // wheel up pulls the chart down: forward in time
        this.seek(this.time() - e.deltaY * (SPANS[this.spanIdx] / 900));
      },
      { passive: false },
    );

    this.el.addEventListener("click", (e) => {
      const t = e.target as Element;
      const z = t.closest<HTMLElement>("[data-zoom]");
      if (z) {
        this.spanIdx = Math.max(0, Math.min(SPANS.length - 1, this.spanIdx + +z.dataset.zoom!));
        this.draw();
        return;
      }
      if (t.closest(".chart-play")) {
        if (this.following() && player.playing) player.toggle();
        else player.playSet(this.setIdx, this.mapIdx, undefined, { at: this.time() / 1000 });
      }
    });
  }

  destroy(): void {
    this.dead = true;
    cancelAnimationFrame(this.raf);
    this.resize?.disconnect();
    this.offs.forEach((f) => f());
    this.el.remove();
  }
}

/** First index (multiple of 3) whose time is ≥ t in a flat [time, lane, length] array. */
function lowerBound(notes: number[], t: number): number {
  let lo = 0;
  let hi = notes.length / 3;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid * 3] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo * 3;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}
