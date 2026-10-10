/* chart.ts — one difficulty's numbers, shown in an expanded difficulty row: note density over
 * time, key numbers, and what the patterns ask of you. The osu!mania playfield itself opens in
 * fullscreen ("Open playfield").
 *
 * The graph's playhead follows the audio whenever this set is playing; otherwise it sits at a
 * cursor you set by clicking the graph.
 *
 * The rate (HT, DT or anything from 0.5× to 2×) is the player's: the song plays at it, and the
 * numbers, times and star rating here are shown at it. osu!mania star ratings for every rate
 * come with the chart from Fumen's own calculator; 1× shows lazer's value.
 */
import { asApiError } from "../lib/api";
import { loadChart, PATTERNS } from "../lib/charts";
import { bpm, duration, esc, num, srChip } from "../lib/format";
import { store } from "../lib/store";
import type { ChartData } from "../lib/types";
import { player } from "../player";
import { attachSegIndicator } from "../ui/controls";
import { icon } from "../ui/icons";
import { AccentColors, drawDensity, laneTone } from "../ui/playfield";
import { rateClick, rateControlHtml, starsAtRate, syncRateControl } from "../ui/rate";
import { openFullscreen } from "./fullscreen";

export class ChartPanel {
  readonly el: HTMLElement;
  private data: ChartData | null = null;
  private cursor = 0;
  private raf = 0;
  private offs: (() => void)[] = [];
  private dead = false;
  private graph: HTMLCanvasElement | null = null;
  private resize: ResizeObserver | null = null;
  private colors = new AccentColors();
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
      player.bus.on("rate", () => this.onRate()),
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
    this.drawHead();
  }

  /** Plays this difficulty from the cursor (or keeps playing where it is). */
  private play(): void {
    if (this.following()) {
      if (player.now!.map !== this.mapIdx) player.selectMap(this.mapIdx);
      if (!player.playing) player.toggle();
    } else player.playSet(this.setIdx, this.mapIdx, undefined, { at: this.time() / 1000 });
  }

  // ── rendering ─────────────────────────────────────────────────────────

  private renderError(message: string): void {
    this.el.innerHTML = `<div class="chart-error">${icon("alert")}<span>Couldn't read this chart. ${esc(message)}</span></div>`;
  }

  private render(d: ChartData): void {
    this.data = d;
    // the song starts at the beginning, so the cursor does too
    this.cursor = 0;
    const mania = d.mode === 3 && d.keys > 0;

    this.el.innerHTML = `
      <div class="chart-grid">
        <div class="chart-rate">
          ${rateControlHtml()}
          <div class="rate-info num"></div>
        </div>
        <div class="chart-graph">
          <canvas class="graph-canvas" aria-label="Note density"></canvas>
          <div class="graph-head"></div>
          <div class="graph-tip num"></div>
        </div>
        <div class="graph-axis num"><span>0:00</span><span class="graph-hint">Notes per second${d.kiai.length ? " · kiai shaded" : ""}</span><span class="axis-end">${duration(this.total() / player.rate)}</span></div>
        <div class="chart-stats">${this.statsHtml(d)}</div>
        ${mania ? this.maniaBlocks(d) : `<p class="chart-note">Pattern analysis covers osu!mania for now.</p>`}
        <div class="chart-actions">
          ${mania ? `<button class="btn btn-primary btn-sm chart-field" type="button">${icon("fullscreen")}<span>Open playfield</span></button>` : ""}
          <button class="btn btn-sm chart-play" type="button">${icon("play", "ic-play")}${icon("pause", "ic-pause")}<span>Play from here</span></button>
          <span class="chart-help">Click the graph to move through the song.</span>
        </div>
      </div>`;

    this.graph = this.el.querySelector(".graph-canvas");
    attachSegIndicator(this.el.querySelector(".rate-presets")!);
    this.renderRate();
    this.bind();
    this.resize = new ResizeObserver(() => this.drawGraph());
    this.resize.observe(this.el.querySelector(".chart-graph")!);
    this.drawGraph();
    this.syncLoop();
  }

  /** Key numbers at the current rate. */
  private statsHtml(d: ChartData): string {
    const a = d.analysis;
    const r = player.rate;
    const stats: [string, string, string][] = [
      ["Peak", (a.npsPeak * r).toFixed(1), "notes/s"],
      ["Average", (a.npsAvg * r).toFixed(1), "notes/s"],
      ["Longest burst", a.longestBurst ? duration(a.longestBurst / r) : "–", "without a breather"],
    ];
    if (d.mode === 3 && d.keys > 0) {
      stats.push(["Long notes", `${Math.round(a.lnTime * 100)}%`, "of the time held"], ["Jacks", `${Math.round(a.jackRatio * 100)}%`, "of rows"]);
    } else {
      stats.push(["Objects", num(a.notes), `${num(a.holds)} with a length`]);
    }
    return stats.map(([k, v, s]) => `<div class="cstat"><span class="cstat-k">${k}</span><b class="num">${v}</b><span class="cstat-s">${s}</span></div>`).join("");
  }

  /** Rate controls plus star rating, length and BPM at the rate. */
  private renderRate(): void {
    const d = this.data!;
    const r = player.rate;
    const map = store.snap!.maps[this.mapIdx];
    syncRateControl(this.el);
    const sr = starsAtRate(map.sr, d.stars);
    const tip = r === 1 ? "Star rating" : `Star rating at ${r.toFixed(2)}×, calculated by Fumen`;
    this.el.querySelector(".rate-info")!.innerHTML = [
      sr !== undefined ? `<span data-tip="${tip}">${srChip(sr, "lg", icon("star-fill"))}</span>` : "",
      `<span data-tip="Length">${duration(map.length / r)}</span>`,
      `<span>${bpm(map.bpm * r)} BPM</span>`,
    ].join("");
  }

  private onRate(): void {
    if (!this.data) return;
    this.renderRate();
    this.el.querySelector(".chart-stats")!.innerHTML = this.statsHtml(this.data);
    this.el.querySelector(".axis-end")!.textContent = duration(this.total() / player.rate);
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

  private drawGraph(): void {
    if (!this.graph || !this.data) return;
    drawDensity(this.graph, this.data, this.total(), this.colors);
    this.drawHead();
  }

  /** Playhead on the graph, and the play button's state. */
  private drawHead(): void {
    if (!this.data) return;
    const f = Math.min(1, Math.max(0, this.time() / this.total()));
    this.el.querySelector<HTMLElement>(".graph-head")?.style.setProperty("left", `${f * 100}%`);
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
        this.drawHead();
        this.raf = requestAnimationFrame(frame);
      };
      this.raf = requestAnimationFrame(frame);
    } else if (!run && this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    if (!run) this.drawHead();
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
      const nps = (a.density[Math.floor((ms - a.start) / 1000)] ?? 0) * player.rate;
      tip.textContent = `${duration(ms / player.rate)} · ${Math.round(nps * 10) / 10} notes/s`;
      tip.style.left = `${x}px`;
      if (dragging) this.seek(ms);
    });
    const end = () => (dragging = false);
    graphEl.addEventListener("pointerup", end);
    graphEl.addEventListener("pointercancel", end);

    this.el.addEventListener("click", (e) => {
      const t = e.target as Element;
      if (rateClick(t)) return;
      if (t.closest(".chart-field")) {
        this.play();
        openFullscreen("field");
        return;
      }
      if (t.closest(".chart-play")) {
        if (this.following() && player.playing) player.toggle();
        else this.play();
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
