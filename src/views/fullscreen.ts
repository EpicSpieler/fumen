/* fullscreen.ts — the player in fullscreen, with two views you switch at the top:
 *
 *  - Visualizer: the song's art, big, with frequency bars from the audio itself.
 *  - Playfield: the playing difficulty's osu!mania playfield at full height, scrolling like lazer
 *    does for you (your lazer scroll speed and direction, rate mods included), next to what matters
 *    while you watch it: notes per second right now, the pattern of this second, BPM, notes so
 *    far, and the density graph. The numbers about the whole chart stay in the set page's panel.
 *
 * Esc leaves; Space plays/pauses; ←/→ seek 5 s; F3/F4 lower/raise the scroll speed as in lazer.
 * Nothing animates while the song is paused.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri, thumbUrl } from "../lib/api";
import { bpmAt, loadChart, lowerBound, PATTERNS, SCROLL_SPEED_MAX, SCROLL_SPEED_MIN, scrollSpeed, scrollTime, scrollUp } from "../lib/charts";
import { readBars, startAnalyser } from "../lib/eq";
import { bpm, displayArtist, displayTitle, duration, esc, keysOrMode, num, srChip } from "../lib/format";
import { setPrefs, store } from "../lib/store";
import type { ChartData } from "../lib/types";
import { dragSlider, player } from "../player";
import { attachSegIndicator, openMenu, reduceMotion, type MenuEntry } from "../ui/controls";
import { icon } from "../ui/icons";
import { AccentColors, drawDensity, fitCanvas, Playfield } from "../ui/playfield";
import { rateClick, rateControlHtml, starsAtRate, syncRateControl } from "../ui/rate";

export type FullscreenMode = "visual" | "field";

const BARS = 72;

class Fullscreen {
  private el: HTMLElement | null = null;
  private isOpen = false;
  private mode: FullscreenMode = "visual";
  private raf = 0;
  private lastFrame = 0;
  private offs: (() => void)[] = [];
  private colors = new AccentColors();
  /** we put the window into fullscreen, so we take it out again */
  private ownsWindowFullscreen = false;

  // visualizer
  private levels = new Float32Array(BARS);
  private shown = new Float32Array(BARS);
  private eq = false;

  // playfield
  private mapId = "";
  private data: ChartData | null = null;
  private field: Playfield | null = null;
  private graphDrawn = "";
  /** last text written per live field, so frames only touch the DOM when something changed */
  private live = new Map<Element, string>();

  get open(): boolean {
    return this.isOpen;
  }

  async show(mode?: FullscreenMode): Promise<void> {
    if (!player.now) return;
    this.mount();
    this.setMode(mode ?? store.prefs.fullscreenMode, !!mode);
    if (this.isOpen) return;
    const el = this.el!;
    this.isOpen = true;
    el.hidden = false;
    document.body.classList.add("fs-open");
    requestAnimationFrame(() => el.classList.add("on"));
    this.eq = startAnalyser();
    this.subscribe();
    this.onTrack();
    el.querySelector<HTMLElement>(".fs-exit")!.focus({ preventScroll: true });
    if (isTauri) {
      try {
        const win = getCurrentWindow();
        if (!(await win.isFullscreen())) {
          await win.setFullscreen(true);
          this.ownsWindowFullscreen = true;
        }
      } catch (e) {
        console.warn("[fullscreen] window", e);
      }
    }
  }

  async hide(): Promise<void> {
    if (!this.isOpen) return;
    const el = this.el!;
    this.isOpen = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.offs.forEach((f) => f());
    this.offs = [];
    el.classList.remove("on");
    document.body.classList.remove("fs-open");
    setTimeout(() => !this.isOpen && (el.hidden = true), reduceMotion() ? 0 : 240);
    if (this.ownsWindowFullscreen) {
      this.ownsWindowFullscreen = false;
      try {
        await getCurrentWindow().setFullscreen(false);
      } catch {
        /* the window is already back */
      }
    }
  }

  // ── structure ─────────────────────────────────────────────────────────

  private mount(): void {
    if (this.el) return;
    const el = document.createElement("div");
    el.className = "fs";
    el.hidden = true;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Now playing, fullscreen");
    el.innerHTML = `
      <div class="fs-bg" aria-hidden="true"><img alt="" /></div>
      <header class="fs-top">
        <div class="fs-now"><div class="fs-now-title"></div><div class="fs-now-sub"></div></div>
        <div class="seg-pill fs-modes" role="tablist" aria-label="View">
          <button type="button" role="tab" data-mode="visual">Visualizer</button>
          <button type="button" role="tab" data-mode="field">Playfield</button>
        </div>
        <div class="fs-top-r">
          <button class="icon-btn fs-exit" type="button" data-tip="Leave fullscreen" aria-label="Leave fullscreen">${icon("fullscreen-exit")}</button>
        </div>
      </header>
      <main class="fs-body">
        <section class="fs-visual">
          <div class="fs-art"><img alt="" /></div>
          <div class="fs-meta">
            <div class="fs-title"></div>
            <div class="fs-artist"></div>
            <div class="fs-version"></div>
          </div>
          <canvas class="fs-eq" aria-hidden="true"></canvas>
        </section>
        <section class="fs-field">
          <div class="fs-stage">
            <canvas class="fs-pf" aria-label="Playfield"></canvas>
            <div class="fs-empty" hidden></div>
          </div>
          <aside class="fs-info">
            <button class="fs-diff" type="button" aria-label="Difficulty"></button>
            <div class="fs-live">
              <div class="fs-stat"><span class="fs-k">Notes per second</span><b class="num" data-live="nps">–</b><span class="fs-s num" data-live="peak"></span></div>
              <div class="fs-stat"><span class="fs-k">This second</span><b data-live="pattern">–</b><span class="fs-s" data-live="pattern-sub"></span></div>
              <div class="fs-stat"><span class="fs-k">BPM</span><b class="num" data-live="bpm">–</b><span class="fs-s num" data-live="bpm-sub"></span></div>
              <div class="fs-stat"><span class="fs-k">Notes</span><b class="num" data-live="count">–</b><span class="fs-s num" data-live="count-sub"></span></div>
            </div>
            <div class="fs-graph">
              <canvas aria-label="Note density"></canvas>
              <div class="graph-head"></div>
            </div>
            <div class="fs-axis num"><span>0:00</span><span>Notes per second</span><span data-live="graph-end"></span></div>
            <div class="fs-setting">
              <span class="fs-k">Scroll speed</span>
              <div class="fs-speed">
                <button class="icon-btn sm" type="button" data-speed="-1" data-tip="Slower (F3)" aria-label="Slower scroll">${icon("minus")}</button>
                <b class="num fs-speed-val"></b>
                <button class="icon-btn sm" type="button" data-speed="1" data-tip="Faster (F4)" aria-label="Faster scroll">${icon("plus")}</button>
              </div>
              <span class="fs-speed-sub num"></span>
            </div>
            <div class="fs-setting">
              <span class="fs-k">Rate</span>
              <div class="fs-rate-ctl">${rateControlHtml()}</div>
            </div>
          </aside>
        </section>
      </main>
      <footer class="fs-bar">
        <div class="pb-seek fs-seek" role="slider" aria-label="Seek" tabindex="0">
          <div class="pb-seek-track"><div class="pb-seek-fill"></div></div>
          <div class="pb-seek-head"></div>
          <div class="pb-seek-tip num"></div>
        </div>
        <div class="fs-row">
          <span class="fs-time num"><span data-live="cur">0:00</span> / <span data-live="dur">0:00</span><span class="fs-rate" data-live="rate"></span></span>
          <div class="fs-ctrl">
            <button class="pb-btn pb-skip pb-prev fs-prev" type="button" data-tip="Previous" aria-label="Previous">${icon("skip-back")}</button>
            <button class="pb-play fs-play" type="button" aria-label="Play"></button>
            <button class="pb-btn pb-skip pb-next fs-next" type="button" data-tip="Next" aria-label="Next">${icon("skip-forward")}</button>
          </div>
          <span></span>
        </div>
      </footer>`;
    document.body.appendChild(el);
    this.el = el;
    attachSegIndicator(el.querySelector(".fs-modes")!);
    attachSegIndicator(el.querySelector(".rate-presets")!);
    el.querySelectorAll("img").forEach((img) => {
      img.addEventListener("load", () => img.classList.add("loaded"));
      img.addEventListener("error", () => img.classList.remove("loaded"));
    });
    this.bind();
  }

  private setMode(mode: FullscreenMode, remember = true): void {
    this.mode = mode;
    const el = this.el!;
    el.dataset.mode = mode;
    el.querySelectorAll<HTMLElement>(".fs-modes [data-mode]").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === mode);
      b.setAttribute("aria-selected", String(b.dataset.mode === mode));
    });
    if (remember && store.prefs.fullscreenMode !== mode) setPrefs({ fullscreenMode: mode });
    this.graphDrawn = "";
    this.live.clear();
    if (mode === "field") this.loadField();
    this.kick();
  }

  private subscribe(): void {
    const a = player.audio;
    const kick = () => this.kick();
    a.addEventListener("seeked", kick);
    a.addEventListener("durationchange", kick);
    window.addEventListener("resize", kick);
    this.offs.push(
      () => a.removeEventListener("seeked", kick),
      () => a.removeEventListener("durationchange", kick),
      () => window.removeEventListener("resize", kick),
      player.bus.on("track", () => this.onTrack()),
      player.bus.on("state", () => this.kick()),
      player.bus.on("rate", () => this.onRate()),
    );
  }

  // ── now playing ───────────────────────────────────────────────────────

  private onTrack(): void {
    const np = player.now;
    const snap = store.snap;
    if (!np || !snap) {
      void this.hide();
      return;
    }
    const el = this.el!;
    const set = snap.sets[np.set];
    const map = snap.maps[np.map];
    const unicode = store.prefs.unicode;
    const title = displayTitle(set, unicode);
    const artist = displayArtist(set, unicode);
    el.querySelector(".fs-now-title")!.textContent = title;
    el.querySelector(".fs-now-sub")!.textContent = `${artist}${map ? ` · ${map.version}` : ""}`;
    el.querySelector(".fs-title")!.textContent = title;
    el.querySelector(".fs-artist")!.textContent = artist;
    el.querySelector(".fs-version")!.textContent = map ? `${map.version} · mapped by ${set.creator}` : `mapped by ${set.creator}`;
    for (const [sel, size] of [[".fs-bg img", 360], [".fs-art img", 1280]] as const) {
      const img = el.querySelector<HTMLImageElement>(sel)!;
      img.classList.remove("loaded");
      if (np.bg) img.src = thumbUrl(np.bg, size);
      else img.removeAttribute("src");
    }
    el.querySelector(".fs-art")!.classList.toggle("img-missing", !np.bg);
    this.live.clear();
    this.graphDrawn = "";
    if (this.mode === "field") this.loadField();
    this.onRate();
  }

  private onRate(): void {
    if (!this.el) return;
    syncRateControl(this.el);
    this.renderDiff();
    this.renderSpeed();
    this.live.clear();
    this.kick();
  }

  // ── playfield data ────────────────────────────────────────────────────

  /** The difficulty the playfield shows: the playing one. */
  private loadField(): void {
    const np = player.now;
    const snap = store.snap;
    if (!np || !snap) return;
    const map = snap.maps[np.map];
    this.renderDiff();
    if (map.mode !== 3) {
      this.mapId = "";
      this.data = null;
      this.field = null;
      this.showEmpty(map.mode);
      return;
    }
    if (this.mapId === map.id && this.data) return;
    this.mapId = map.id;
    this.data = null;
    this.field = null;
    this.showEmpty(null, "Loading the chart…");
    loadChart(map.id)
      .then((d) => {
        if (this.mapId !== map.id) return;
        this.data = d;
        this.field = new Playfield(this.el!.querySelector(".fs-pf")!, d);
        this.showEmpty(null);
        this.graphDrawn = "";
        this.live.clear();
        this.kick();
      })
      .catch(() => this.mapId === map.id && this.showEmpty(null, "Couldn't read this chart."));
  }

  /** Message in place of the playfield: not mania (with a way to pick a mania difficulty), loading, errors. */
  private showEmpty(mode: number | null, text?: string): void {
    const el = this.el!;
    const box = el.querySelector<HTMLElement>(".fs-empty")!;
    const canvas = el.querySelector<HTMLElement>(".fs-pf")!;
    const show = mode !== null || !!text;
    box.hidden = !show;
    canvas.style.visibility = show ? "hidden" : "";
    // the numbers beside it belong to a chart; without one they'd be the previous chart's
    const info = el.querySelector<HTMLElement>(".fs-info")!;
    info.classList.toggle("dim", show && mode === null);
    info.classList.toggle("off", mode !== null);
    if (!show) return;
    this.clearLive();
    if (text) {
      box.innerHTML = `<p>${esc(text)}</p>`;
      return;
    }
    const maniaMaps = this.maniaMaps();
    box.innerHTML = `
      ${icon("lanes-duo")}
      <div class="fs-empty-title">The playfield is for osu!mania</div>
      <p>${maniaMaps.length ? "This difficulty isn't one. Pick one of the set's osu!mania difficulties:" : "This set has no osu!mania difficulty."}</p>
      ${maniaMaps.length ? `<div class="fs-empty-list">${maniaMaps.map((mi) => this.diffButton(mi)).join("")}</div>` : ""}`;
  }

  private maniaMaps(): number[] {
    const snap = store.snap!;
    const np = player.now!;
    return snap.sets[np.set].maps.filter((mi) => snap.maps[mi].mode === 3 && !snap.maps[mi].hidden);
  }

  private diffButton(mi: number): string {
    const m = store.snap!.maps[mi];
    return `<button class="fs-pick" type="button" data-map="${mi}">${srChip(m.sr)}<span>${esc(m.version)}</span><i>${esc(keysOrMode(m))}</i></button>`;
  }

  private renderDiff(): void {
    const el = this.el;
    const np = player.now;
    if (!el || !np || !store.snap) return;
    const m = store.snap.maps[np.map];
    const sr = this.data && this.mapId === m.id ? starsAtRate(m.sr, this.data.stars) : player.rate === 1 ? m.sr : undefined;
    el.querySelector(".fs-diff")!.innerHTML = `
      ${sr !== undefined ? srChip(sr, "lg", icon("star-fill")) : ""}
      <span class="fs-diff-name"><b>${esc(m.version)}</b><span>${esc(keysOrMode(m))} · OD ${Math.round(m.od * 10) / 10} · HP ${Math.round(m.hp * 10) / 10}</span></span>
      ${this.maniaMaps().length > 1 ? icon("chevron-down") : ""}`;
  }

  private renderSpeed(): void {
    const el = this.el;
    if (!el) return;
    const s = scrollSpeed();
    el.querySelector(".fs-speed-val")!.textContent = fmtSpeed(s.speed);
    el.querySelector<HTMLButtonElement>("[data-speed='-1']")!.disabled = s.speed <= SCROLL_SPEED_MIN;
    el.querySelector<HTMLButtonElement>("[data-speed='1']")!.disabled = s.speed >= SCROLL_SPEED_MAX;
    const ms = `${num(Math.round(scrollTime(s.speed)))} ms`;
    el.querySelector(".fs-speed-sub")!.innerHTML = s.fromLazer
      ? `${ms} · from lazer${scrollUp() ? " · scrolling up" : ""}`
      : `${ms} · <button class="fs-speed-reset" type="button">back to lazer's ${fmtSpeed(s.lazer)}</button>`;
  }

  private changeSpeed(step: number): void {
    const s = scrollSpeed();
    const next = Math.round(Math.max(SCROLL_SPEED_MIN, Math.min(SCROLL_SPEED_MAX, s.speed + step)) * 10) / 10;
    // landing on lazer's own value means following lazer again
    setPrefs({ scrollSpeed: next === s.lazer ? null : next });
    this.renderSpeed();
    this.kick();
  }

  // ── frames ────────────────────────────────────────────────────────────

  private kick(): void {
    if (this.isOpen && !this.raf) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private frame(now: number): void {
    this.raf = 0;
    if (!this.isOpen) return;
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 1 / 60;
    let again = player.playing;
    this.transport();
    if (this.mode === "visual") again = this.drawEq(dt) || again;
    else this.drawField();
    if (again) {
      this.lastFrame = now;
      this.kick();
    } else this.lastFrame = 0;
  }

  /** Empties the playfield's live numbers and graph. */
  private clearLive(): void {
    const el = this.el!;
    for (const key of ["nps", "pattern", "bpm", "count"]) this.set(key, "–");
    for (const key of ["peak", "pattern-sub", "bpm-sub", "count-sub", "graph-end"]) this.set(key, "");
    const graph = el.querySelector<HTMLCanvasElement>(".fs-graph canvas")!;
    graph.getContext("2d")?.clearRect(0, 0, graph.width, graph.height);
    el.querySelector<HTMLElement>(".fs-graph .graph-head")!.style.left = "0%";
    this.graphDrawn = "";
  }

  /** Writes text only when it changed. */
  private set(key: string, text: string, html = false): void {
    const node = this.el!.querySelector(`[data-live="${key}"]`);
    if (!node || this.live.get(node) === text) return;
    this.live.set(node, text);
    if (html) node.innerHTML = text;
    else node.textContent = text;
  }

  private transport(): void {
    const el = this.el!;
    const a = player.audio;
    const d = Number.isFinite(a.duration) ? a.duration : 0;
    const t = a.currentTime || 0;
    const r = player.rate;
    el.classList.toggle("playing", player.playing);
    el.querySelector(".fs-play")!.setAttribute("aria-label", player.playing ? "Pause" : "Play");
    const seek = el.querySelector<HTMLElement>(".fs-seek")!;
    if (!seek.classList.contains("dragging")) {
      seek.style.setProperty("--p", d > 0 ? `${(t / d) * 100}%` : "0%");
      this.set("cur", duration((t * 1000) / r));
    }
    this.set("dur", duration((d * 1000) / r));
    this.set("rate", r === 1 ? "" : `${r.toFixed(2)}×`);
  }

  private drawEq(dt: number): boolean {
    const c = this.el!.querySelector<HTMLCanvasElement>(".fs-eq")!;
    const fit = fitCanvas(c);
    if (!fit) return false;
    const { ctx, w, h } = fit;
    if (!(player.playing && this.eq && readBars(this.levels))) this.levels.fill(0);
    let moving = false;
    for (let i = 0; i < BARS; i++) {
      const target = this.levels[i];
      const cur = this.shown[i];
      // rise quickly, fall slowly, like a level meter
      const next = target > cur ? cur + (target - cur) * Math.min(1, dt * 30) : Math.max(target, cur - dt * 1.4);
      this.shown[i] = next;
      if (next > 0.004) moving = true;
    }
    const slot = w / BARS;
    const bw = Math.max(2, slot * 0.66);
    ctx.fillStyle = this.colors.update().accent;
    for (let i = 0; i < BARS; i++) {
      const v = this.shown[i];
      const bh = Math.max(3, v * h);
      ctx.globalAlpha = 0.3 + 0.65 * v;
      ctx.beginPath();
      ctx.roundRect(i * slot + (slot - bw) / 2, h - bh, bw, bh, Math.min(bw / 2, 4));
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    return moving;
  }

  private drawField(): void {
    const el = this.el!;
    const d = this.data;
    const field = this.field;
    if (!d || !field) return;
    const r = player.rate;
    const t = player.audio.currentTime * 1000;

    // the playfield is as wide as lazer's for this many keys at this height
    const stage = el.querySelector<HTMLElement>(".fs-stage")!;
    const colW = Math.max(40, Math.min(96, stage.clientHeight * 0.085));
    stage.style.setProperty("--pf-w", `${Math.round(colW * d.keys)}px`);
    field.draw(t, scrollTime(scrollSpeed().speed) * r, scrollUp());

    // live numbers
    const a = d.analysis;
    const n = d.notes;
    // notes per second: the notes of the second around now, in real time
    const half = 500 * r;
    const nps = (lowerBound(n, t + half) - lowerBound(n, t - half)) / 3;
    this.set("nps", nps.toFixed(0));
    this.set("peak", `peak ${(a.npsPeak * r).toFixed(1)}`);
    const sec = Math.floor((t - a.start) / 1000);
    const label = t < a.start ? "Intro" : t > a.end ? "Outro" : (a.windows?.[sec] ? PATTERNS[a.windows[sec]!].label : "Light");
    this.set("pattern", label);
    this.set("pattern-sub", t < a.start || t > a.end ? "no notes" : a.windows?.[sec] ? "pattern" : "not much going on");
    const beat = bpmAt(d.beats, t) * r;
    this.set("bpm", beat ? bpm(beat) : "–");
    this.set("bpm-sub", r === 1 ? "" : `${bpm(beat / r)} × ${r.toFixed(2)}`);
    this.set("count", num(lowerBound(n, t + 1) / 3));
    this.set("count-sub", `of ${num(n.length / 3)}`);

    // graph (redrawn when its size or chart changes) + playhead
    const graph = el.querySelector<HTMLCanvasElement>(".fs-graph canvas")!;
    const total = a.end + 1000;
    const key = `${this.mapId}:${graph.clientWidth}x${graph.clientHeight}`;
    if (key !== this.graphDrawn) {
      drawDensity(graph, d, total, this.colors);
      this.graphDrawn = key;
    }
    this.set("graph-end", duration(total / r));
    el.querySelector<HTMLElement>(".fs-graph .graph-head")!.style.left = `${Math.min(100, Math.max(0, (t / total) * 100))}%`;
  }

  // ── input ─────────────────────────────────────────────────────────────

  private bind(): void {
    const el = this.el!;
    el.addEventListener("click", (e) => {
      const t = e.target as Element;
      const mode = t.closest<HTMLElement>(".fs-modes [data-mode]");
      if (mode) return this.setMode(mode.dataset.mode as FullscreenMode);
      if (t.closest(".fs-exit")) return void this.hide();
      if (t.closest(".fs-play")) return player.toggle();
      if (t.closest(".fs-prev")) return player.prev();
      if (t.closest(".fs-next")) return player.next();
      if (rateClick(t)) return;
      const speed = t.closest<HTMLElement>("[data-speed]");
      if (speed) return this.changeSpeed(+speed.dataset.speed!);
      if (t.closest(".fs-speed-reset")) {
        setPrefs({ scrollSpeed: null });
        this.renderSpeed();
        return this.kick();
      }
      const pick = t.closest<HTMLElement>(".fs-pick[data-map]");
      if (pick) return player.selectMap(+pick.dataset.map!);
      const diff = t.closest<HTMLElement>(".fs-diff");
      if (diff && this.maniaMaps().length > 1) this.diffMenu(diff);
    });

    // seeking: the bar, and the density graph
    const seek = el.querySelector<HTMLElement>(".fs-seek")!;
    const tip = el.querySelector<HTMLElement>(".fs-seek .pb-seek-tip")!;
    const timeAt = (f: number) => duration((f * (Number.isFinite(player.audio.duration) ? player.audio.duration : 0) * 1000) / player.rate);
    dragSlider(seek, (f, done) => {
      seek.style.setProperty("--p", `${f * 100}%`);
      this.set("cur", timeAt(f));
      if (done) player.seek(f);
    });
    seek.addEventListener("pointermove", (e) => {
      const r = seek.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      tip.textContent = timeAt(f);
      tip.style.setProperty("--x", `${e.clientX - r.left}px`);
    });
    const graph = el.querySelector<HTMLElement>(".fs-graph")!;
    graph.addEventListener("pointerdown", (e) => {
      if (!this.data || e.button !== 0) return;
      const r = graph.getBoundingClientRect();
      const ms = ((e.clientX - r.left) / r.width) * (this.data.analysis.end + 1000);
      player.audio.currentTime = Math.max(0, ms / 1000);
      this.kick();
    });

    // wheel over the playfield moves through the song, like the panel's playfield did
    el.querySelector(".fs-stage")!.addEventListener(
      "wheel",
      (e) => {
        if (!this.data) return;
        e.preventDefault();
        const span = scrollTime(scrollSpeed().speed) * player.rate;
        player.audio.currentTime = Math.max(0, player.audio.currentTime - ((e as WheelEvent).deltaY * span) / 900 / 1000);
        this.kick();
      },
      { passive: false },
    );

    window.addEventListener(
      "keydown",
      (e) => {
        if (!this.isOpen || document.querySelector(".menu")) return;
        switch (e.key) {
          case "Escape":
            e.preventDefault();
            e.stopPropagation();
            void this.hide();
            break;
          case "F3":
          case "F4":
            e.preventDefault();
            if (this.mode === "field") this.changeSpeed(e.key === "F3" ? -1 : 1);
            break;
          case "ArrowLeft":
          case "ArrowRight": {
            if ((e.target as Element).closest("[role='slider'], input")) return;
            e.preventDefault();
            const d = player.audio.duration;
            const to = player.audio.currentTime + (e.key === "ArrowLeft" ? -5 : 5);
            player.audio.currentTime = Math.max(0, Number.isFinite(d) ? Math.min(d, to) : to);
            this.kick();
            break;
          }
        }
      },
      true,
    );
  }

  private diffMenu(anchor: HTMLElement): void {
    const snap = store.snap!;
    const now = player.now!.map;
    const entries: MenuEntry[] = [{ group: "osu!mania difficulties" }];
    for (const mi of this.maniaMaps()) {
      const m = snap.maps[mi];
      entries.push({ label: `${m.version} · ${m.sr.toFixed(2)} stars · ${keysOrMode(m)}`, checked: mi === now, radio: "diff", action: () => player.selectMap(mi) });
    }
    openMenu(anchor, entries, { minWidth: 300 });
  }
}

const fmtSpeed = (s: number): string => (Number.isInteger(s) ? String(s) : s.toFixed(1));

const fullscreen = new Fullscreen();

/** Opens the fullscreen player (in `mode`, or the one used last). */
export function openFullscreen(mode?: FullscreenMode): void {
  void fullscreen.show(mode);
}
