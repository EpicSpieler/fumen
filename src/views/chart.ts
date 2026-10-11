/* chart.ts — one difficulty's numbers, shown in an expanded difficulty row: note density over
 * time, key numbers, and what the patterns ask of you. The osu!mania playfield itself opens in
 * fullscreen ("Open playfield").
 *
 * For osu!mania the dan rating and the pattern report come from Fumen's port of ManiaMapAnalyser
 * by Leo_Black (MIT; src-tauri/src/mma): Azusa's dan for 4K rice, Sunny's star rating on the dan
 * tables otherwise, and its pattern clusters merged per core pattern.
 *
 * The graph's playhead follows the audio whenever this set is playing; otherwise it sits at a
 * cursor you set by clicking the graph.
 *
 * The rate (HT, DT or anything from 0.5× to 2×) is the player's: the song plays at it, and the
 * numbers, times and star rating here are shown at it. osu!mania star ratings for every rate
 * come with the chart from Fumen's own calculator; 1× shows lazer's value.
 */
import { asApiError } from "../lib/api";
import { danAt, loadChart } from "../lib/charts";
import { CORE_PATTERNS, danReadings, MODE_LABEL, patternGroups, SV_AMOUNT } from "../lib/dan";
import { bpm, duration, esc, num, srChip } from "../lib/format";
import { store } from "../lib/store";
import type { ChartData, DanRating } from "../lib/types";
import { player } from "../player";
import { attachSegIndicator } from "../ui/controls";
import { icon } from "../ui/icons";
import { AccentColors, drawDensity, laneTone } from "../ui/playfield";
import { rateClick, rateControlHtml, starsAtRate, syncRateControl } from "../ui/rate";
import { openFullscreen } from "./fullscreen";
import { MapPlays } from "./plays";

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
  /** bumped per dan request, so a late answer for another rate is dropped */
  private danJob = 0;
  /** the dan card's last content, kept while the next rate's dan loads */
  private danHtml = "";
  private plays: MapPlays | null = null;

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
    this.el.innerHTML = `<div class="chart-error">${icon("alert")}<span>Couldn't read this chart. ${esc(message)}</span></div><div class="chart-plays"></div>`;
    this.mountPlays();
  }

  /** "Your plays" (it doesn't need the chart). */
  private mountPlays(): void {
    this.plays?.destroy();
    this.plays = new MapPlays(this.mapIdx);
    this.el.querySelector(".chart-plays")!.appendChild(this.plays.el);
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
        <div class="chart-stats${mania ? " has-dan" : ""}">${this.statsHtml(d)}</div>
        ${mania ? this.maniaBlocks(d) : `<p class="chart-note">Pattern analysis covers osu!mania for now.</p>`}
        <div class="chart-plays"></div>
        <div class="chart-actions">
          ${mania ? `<button class="btn btn-primary btn-sm chart-field" type="button">${icon("fullscreen")}<span>Open playfield</span></button>` : ""}
          <button class="btn btn-sm chart-play" type="button">${icon("play", "ic-play")}${icon("pause", "ic-pause")}<span>Play from here</span></button>
          <span class="chart-help">Click the graph to move through the song.</span>
        </div>
      </div>`;

    this.mountPlays();
    this.graph = this.el.querySelector(".graph-canvas");
    attachSegIndicator(this.el.querySelector(".rate-presets")!);
    this.renderRate();
    this.renderDan();
    this.bind();
    this.resize = new ResizeObserver(() => this.drawGraph());
    this.resize.observe(this.el.querySelector(".chart-graph")!);
    this.drawGraph();
    this.syncLoop();
  }

  /** Key numbers at the current rate (the dan card fills in by `renderDan`). */
  private statsHtml(d: ChartData): string {
    const a = d.analysis;
    const r = player.rate;
    const dan =
      d.mode === 3 && d.keys > 0
        ? `<div class="cstat cstat-dan is-loading" data-tip="Estimated dan (course tier), from ManiaMapAnalyser by Leo_Black: Azusa for 4K rice, Sunny's star rating on the dan tables otherwise. A guide, not a verdict.">${this.danHtml || `<span class="cstat-k">Dan</span><b>–</b><span class="cstat-s">&nbsp;</span>`}</div>`
        : "";
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
    return dan + stats.map(([k, v, s]) => `<div class="cstat"><span class="cstat-k">${k}</span><b class="num">${v}</b><span class="cstat-s">${s}</span></div>`).join("");
  }

  /** The dan at the current rate (1× comes with the chart, other rates are asked for). */
  private renderDan(): void {
    const d = this.data;
    if (!d || d.mode !== 3 || !d.keys) return;
    const job = ++this.danJob;
    const rate = player.rate;
    const map = store.snap!.maps[this.mapIdx];
    const fill = (dan: DanRating | null, failed = false) => {
      if (job !== this.danJob || this.dead) return;
      this.danHtml = this.danCard(d, dan, failed, rate);
      const el = this.el.querySelector(".cstat-dan");
      if (!el) return;
      el.innerHTML = this.danHtml;
      el.classList.remove("is-loading");
    };
    danAt(map.id, d, rate).then(
      (dan) => fill(dan),
      () => fill(null, true),
    );
  }

  private danCard(d: ChartData, dan: DanRating | null, failed: boolean, rate: number): string {
    const k = `<span class="cstat-k">Dan${rate !== 1 ? ` at ${rate.toFixed(2)}×` : ""}</span>`;
    if (!dan) {
      const why = failed ? "couldn't be rated" : [4, 6, 7, 10].includes(d.keys) ? "too short to rate" : `no dan tables for ${d.keys}K`;
      return `${k}<b>–</b><span class="cstat-s">${why}</span>`;
    }
    const { main, other, otherKind } = danReadings(dan, d.report);
    const sub = other
      ? `${otherKind}: ${esc(other)}`
      : dan.by === "azusa" && dan.value !== undefined
        ? `Azusa <span class="num">${dan.value.toFixed(2)}</span>`
        : `Sunny <span class="num">${dan.sunny.toFixed(2)}★</span>`;
    return `${k}<b class="dan-main">${esc(main)}</b><span class="cstat-s">${sub}</span>`;
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
    this.renderDan();
    for (const el of this.el.querySelectorAll<HTMLElement>(".pat-bpm[data-bpm]")) el.textContent = String(Math.round(+el.dataset.bpm! * player.rate));
    this.el.querySelector(".axis-end")!.textContent = duration(this.total() / player.rate);
  }

  /** ManiaMapAnalyser's pattern report: category, kind of chart, and the core patterns by the
   * time they cover, with their speed (at the rate) and the specific patterns inside. */
  private patternsHtml(d: ChartData): string {
    const rep = d.report;
    const groups = rep ? patternGroups(rep) : [];
    const head = rep
      ? `<div class="pat-tags"><b>${esc(rep.category)}</b><span>${MODE_LABEL[rep.mode]}</span>${rep.svAmount >= SV_AMOUNT ? `<span data-tip="Scroll speed changes for ${Math.round(rep.svAmount / 1000)} s of the chart">SV</span>` : ""}</div>`
      : "";
    const top = `<div class="pat-head"><div class="label-caps">Patterns</div>${head}</div>`;
    if (!groups.length) return `${top}<p class="chart-note">Light throughout: no pattern stands out.</p>`;
    const max = Math.max(1, ...groups.map((g) => g.amount));
    const r = player.rate;
    const rows = groups
      .map((g) => {
        const info = CORE_PATTERNS[g.pattern];
        const spec = g.specific
          .filter(([, s]) => s >= 0.01)
          .slice(0, 3)
          .map(([n, s]) => `${esc(n)} <span class="num">${Math.round(s * 100)}%</span>`)
          .join(" · ");
        const speed = g.bpm
          ? `<span class="pat-val num">${g.mixed ? "~" : ""}<span class="pat-bpm" data-bpm="${g.bpm}">${Math.round(g.bpm * r)}</span> BPM</span>`
          : `<span class="pat-val"></span>`;
        return `<div class="pat-item" data-tip="${esc(info.hint)}${g.mixed ? " (mixed speeds, around this one)" : ""}">
              <div class="pat-row">
                <span class="pat-name">${info.label}</span>
                <div class="bar"><i style="width:${((g.amount / max) * 100).toFixed(1)}%"></i></div>
                ${speed}
              </div>
              ${spec ? `<div class="pat-spec">${spec}</div>` : ""}
            </div>`;
      })
      .join("");
    return top + rows;
  }

  private maniaBlocks(d: ChartData): string {
    const a = d.analysis;

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
          ${this.patternsHtml(d)}
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
    this.plays?.destroy();
    cancelAnimationFrame(this.raf);
    this.resize?.disconnect();
    this.offs.forEach((f) => f());
    this.el.remove();
  }
}
