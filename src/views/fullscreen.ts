/* fullscreen.ts — the player in fullscreen, with two views you switch at the top:
 *
 *  - Visualizer: the song's art, big, with frequency bars from the audio itself.
 *  - Playfield: the playing difficulty's playfield (any ruleset), in your lazer skin
 *    (or any other you pick here), scrolling like lazer does for you (mania: your lazer scroll
 *    speed and direction; rate mods included), with the mods you pick (Easy, Hard Rock, Hidden,
 *    Fade In, Flashlight, Mirror: lib/mods), played by lazer's autoplay with the beatmap's hitsounds
 *    (its own samples first, then the skin's; only here, at their own volume), next to what
 *    matters while you watch it: notes per second right now, the pattern of this second, BPM,
 *    notes so far, and the density graph. The numbers about the whole chart stay in the set
 *    page's panel. Practice mode (./practice) loops a part of it, a little faster each time
 *    round, with a metronome. Every ruleset can be played by one of lazer's replays instead of
 *    autoplay (./replay-panel), judged as lazer does, with the accuracy and hit errors as it goes.
 *
 * Esc leaves; Space plays/pauses; ←/→ seek 5 s; F3/F4 lower/raise the scroll speed as in lazer.
 * Nothing animates while the song is paused.
 */
import { thumbUrl } from "../lib/api";
import { bpmAt, loadChart, lowerBound, PATTERNS, SCROLL_SPEED_MAX, SCROLL_SPEED_MIN, scrollSpeed, scrollTime, scrollUp } from "../lib/charts";
import { readBars, startAnalyser } from "../lib/eq";
import { hitsounds } from "../lib/hitsounds";
import { bpm, displayArtist, displayTitle, duration, esc, keysOrMode, num, srChip } from "../lib/format";
import { currentSkin, loadSkin, loadSkinList, loadSkinSounds } from "../lib/skin/skins";
import { activeMods, adjustDifficulty, chartMods, chartModsKey, MOD_NAMES, modEffect, modsFor, starsKnown, toggleMod, type Mod } from "../lib/mods";
import { setPrefs, store } from "../lib/store";
import type { ChartData, SkinList } from "../lib/types";
import { dragSlider, player } from "../player";
import { attachSegIndicator, openMenu, reduceMotion, type MenuEntry } from "../ui/controls";
import { icon } from "../ui/icons";
import { ArgonRenderer } from "../ui/mania/argon";
import { createRenderer, ManiaPlayfield } from "../ui/mania/playfield";
import type { Renderer } from "../ui/mania/stage";
import { TaikoPlayfield, type TaikoRenderer } from "../ui/taiko/playfield";
import { createTaikoRenderer } from "../ui/taiko/renderers";
import { OsuPlayfield, type OsuRenderer } from "../ui/osu/playfield";
import { createOsuRenderer } from "../ui/osu/renderers";
import { CatchPlayfield, type CatchRenderer } from "../ui/catch/playfield";
import { createCatchRenderer } from "../ui/catch/renderers";
import { AccentColors, drawDensity, fitCanvas } from "../ui/playfield";
import { rateClick, rateControlHtml, starsAtRate, syncRateControl } from "../ui/rate";
import type { PatternName } from "../lib/types";
import { PracticePanel } from "./practice";
import { CORE_PATTERNS } from "../lib/dan";
import type { CorePattern } from "../lib/types";
import { ReplayPanel } from "./replay-panel";

export type FullscreenMode = "visual" | "field";

const BARS = 72;

/** the rulesets the playfield shows: all of them */
const PLAYABLE = new Set([0, 1, 2, 3]);
const PLAYABLE_NAMES = "osu!, osu!taiko, osu!catch and osu!mania";
const taikoChart = (d: ChartData): boolean => d.mode === 1 && !!d.taiko;
const osuChart = (d: ChartData): boolean => d.mode === 0 && !!d.osu;
const catchChart = (d: ChartData): boolean => d.mode === 2 && !!d.catch;

const NO_SKINS: SkinList = { skins: [], selected: null, classic: [], retro: [], triangles: [], argon: [], argonPro: [] };

class Fullscreen {
  private el: HTMLElement | null = null;
  private isOpen = false;
  private mode: FullscreenMode = "visual";
  private raf = 0;
  private lastFrame = 0;
  private offs: (() => void)[] = [];
  private colors = new AccentColors();
  /** where the window controls live outside the overlay */
  private wcHome: HTMLElement | null = null;

  // visualizer
  private levels = new Float32Array(BARS);
  private shown = new Float32Array(BARS);
  private eq = false;

  // playfield
  private mapId = "";
  /** the mods the chart was built with (lib/mods chartModsKey) */
  private chartKey = "";
  private data: ChartData | null = null;
  private field: ManiaPlayfield | TaikoPlayfield | OsuPlayfield | CatchPlayfield | null = null;
  /** lazer's skins (loaded once per import) */
  private skins: SkinList | null = null;
  /** bumped on every skin / chart change, so late renderers are dropped */
  private skinJob = 0;
  private graphDrawn = "";
  /** last text written per live field, so frames only touch the DOM when something changed */
  private live = new Map<Element, string>();
  private practice!: PracticePanel;
  private replays!: ReplayPanel;

  get open(): boolean {
    return this.isOpen;
  }

  askPractice(mapId: string, pattern?: PatternName | null): void {
    this.mount();
    this.practice.ask({ mapId, pattern });
  }

  show(mode?: FullscreenMode): void {
    if (!player.now) return;
    this.mount();
    this.setMode(mode ?? store.prefs.fullscreenMode, !!mode);
    if (this.isOpen) return;
    const el = this.el!;
    this.isOpen = true;
    el.hidden = false;
    document.body.classList.add("fs-open");
    // the window's own controls move into the overlay while it's open (it covers the title bar)
    const wc = document.querySelector<HTMLElement>(".win-controls");
    if (wc) {
      this.wcHome = wc.parentElement;
      el.querySelector(".fs-top-r")!.append(wc);
    }
    requestAnimationFrame(() => el.classList.add("on"));
    this.eq = startAnalyser();
    this.subscribe();
    this.onTrack();
    this.syncSounds();
    el.querySelector<HTMLElement>(".fs-exit")!.focus({ preventScroll: true });
  }

  hide(): void {
    if (!this.isOpen) return;
    const el = this.el!;
    this.isOpen = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.offs.forEach((f) => f());
    this.offs = [];
    this.syncSounds();
    el.classList.remove("on");
    document.body.classList.remove("fs-open");
    const wc = el.querySelector<HTMLElement>(".win-controls");
    if (wc && this.wcHome) this.wcHome.append(wc);
    setTimeout(() => !this.isOpen && (el.hidden = true), reduceMotion() ? 0 : 240);
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
      <header class="fs-top" data-tauri-drag-region>
        <div class="fs-now" data-tauri-drag-region><div class="fs-now-title" data-tauri-drag-region></div><div class="fs-now-sub" data-tauri-drag-region></div></div>
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
            ${ReplayPanel.settingHtml()}
            <div class="fs-live">
              <div class="fs-stat"><span class="fs-k">Notes per second</span><b class="num" data-live="nps">–</b><span class="fs-s num" data-live="peak"></span></div>
              <div class="fs-stat fs-stat-pattern"><span class="fs-k">This second</span><b data-live="pattern">–</b><span class="fs-s" data-live="pattern-sub"></span></div>
              <div class="fs-stat"><span class="fs-k">BPM</span><b class="num" data-live="bpm">–</b><span class="fs-s num" data-live="bpm-sub"></span></div>
              <div class="fs-stat"><span class="fs-k">Notes</span><b class="num" data-live="count">–</b><span class="fs-s num" data-live="count-sub"></span></div>
            </div>
            ${ReplayPanel.panelHtml()}
            <div class="fs-graph">
              <canvas aria-label="Note density"></canvas>
              <div class="fs-graph-loop" hidden></div>
              <div class="fs-graph-marks" aria-hidden="true"></div>
              <div class="graph-head"></div>
            </div>
            <div class="fs-axis num"><span>0:00</span><span>Notes per second</span><span data-live="graph-end"></span></div>
            ${PracticePanel.html()}
            <div class="fs-setting fs-setting-speed">
              <span class="fs-k">Scroll speed</span>
              <div class="fs-speed">
                <button class="icon-btn sm" type="button" data-speed="-1" data-tip="Slower (F3)" aria-label="Slower scroll">${icon("minus")}</button>
                <b class="num fs-speed-val"></b>
                <button class="icon-btn sm" type="button" data-speed="1" data-tip="Faster (F4)" aria-label="Faster scroll">${icon("plus")}</button>
              </div>
              <span class="fs-speed-sub num"></span>
            </div>
            <div class="fs-setting">
              <span class="fs-k">Skin</span>
              <button class="fs-skin" type="button" aria-label="Skin"><span class="fs-skin-name"></span>${icon("chevron-down")}</button>
              <span class="fs-skin-sub"></span>
            </div>
            <div class="fs-setting">
              <span class="fs-k">Hitsounds</span>
              <div class="fs-hs">
                <div class="pb-vol fs-hs-vol" role="slider" aria-label="Hitsound volume" aria-valuemin="0" aria-valuemax="100" tabindex="0"><div class="pb-vol-fill"></div></div>
                <b class="num fs-hs-val"></b>
              </div>
              <span class="fs-hs-sub"></span>
            </div>
            <div class="fs-setting">
              <span class="fs-k">Mods</span>
              <div class="fs-mods" role="group" aria-label="Mods"></div>
              <span class="fs-mods-sub"></span>
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
    this.practice = new PracticePanel(el, () => this.kick());
    this.replays = new ReplayPanel(el, () => this.field, () => this.kick());
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
    this.syncSounds();
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
      player.bus.on("mods", () => this.onMods()),
    );
  }

  // ── now playing ───────────────────────────────────────────────────────

  private onTrack(): void {
    const np = player.now;
    const snap = store.snap;
    if (!np || !snap) {
      this.hide();
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
    this.renderMods();
    this.renderDiff();
    this.renderSpeed();
    this.renderSkin();
    this.renderHitsounds();
    this.practice.render();
    this.live.clear();
    this.kick();
  }

  // ── mods ──────────────────────────────────────────────────────────────

  private onMods(): void {
    if (!this.el) return;
    this.renderMods();
    this.renderDiff();
    const np = player.now;
    const snap = store.snap;
    if (np && snap && this.mode === "field") {
      const map = snap.maps[np.map];
      // the ones that change the chart need it built again; the playfield draws the rest
      if (PLAYABLE.has(map.mode) && chartModsKey(chartMods(player.mods, map.mode)) !== this.chartKey) this.loadField();
      else this.field?.setMods(activeMods(player.mods, map.mode));
    }
    this.kick();
  }

  /** The ruleset's mods as toggles, the ones on lit. */
  private renderMods(): void {
    const el = this.el;
    const np = player.now;
    if (!el || !np || !store.snap) return;
    const mode = store.snap.maps[np.map].mode;
    const on = activeMods(player.mods, mode);
    const box = el.querySelector<HTMLElement>(".fs-mods")!;
    const list = modsFor(mode);
    const key = `${mode}:${list.join()}`;
    if (box.dataset.list !== key) {
      box.dataset.list = key;
      box.innerHTML = list
        .map((m) => `<button class="chip-toggle fs-mod" type="button" data-mod="${m}" aria-pressed="false" aria-label="${esc(MOD_NAMES[m])}" data-tip="${esc(MOD_NAMES[m])} · ${esc(modEffect(m, mode))}">${m}</button>`)
        .join("");
    }
    box.querySelectorAll<HTMLElement>("[data-mod]").forEach((b) => {
      const active = on.includes(b.dataset.mod as Mod);
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", String(active));
    });
    const sub = el.querySelector(".fs-mods-sub")!;
    sub.innerHTML = on.length
      ? `<button class="fs-speed-reset fs-mods-reset" type="button">no mods</button>${starsKnown(on, mode) ? "" : " · no star rating with them"}`
      : "";
  }

  private clickMod(m: Mod): void {
    const np = player.now;
    if (!np || !store.snap) return;
    player.setMods(toggleMod(player.mods, m, store.snap.maps[np.map].mode));
  }

  // ── playfield data ────────────────────────────────────────────────────

  /** The difficulty the playfield shows: the playing one. */
  private loadField(): void {
    const np = player.now;
    const snap = store.snap;
    if (!np || !snap) return;
    const map = snap.maps[np.map];
    this.renderDiff();
    if (!PLAYABLE.has(map.mode)) {
      this.mapId = "";
      this.data = null;
      this.field = null;
      hitsounds.clear();
      this.practice.chart("", null);
      this.replays.chart("", null);
      this.syncSounds();
      this.renderHitsounds();
      this.showEmpty(map.mode);
      return;
    }
    const mods = chartMods(player.mods, map.mode);
    const key = chartModsKey(mods);
    if (this.mapId === map.id && this.chartKey === key && this.data) return;
    // only the mods changed: the chart stays up until the new one is in
    const same = this.mapId === map.id && !!this.field;
    this.mapId = map.id;
    this.chartKey = key;
    if (!same) {
      this.data = null;
      this.field = null;
      hitsounds.clear();
      this.practice.chart(map.id, null);
      this.replays.chart(map.id, null);
      this.syncSounds();
      this.renderHitsounds();
      this.showEmpty(null, "Loading the chart…");
    }
    const job = ++this.skinJob;
    loadChart(map.id, mods)
      .then(async (d) => {
        const renderer = await this.rendererFor(d);
        if (this.mapId !== map.id || this.chartKey !== key || job !== this.skinJob) return;
        this.data = d;
        // the pattern of the second is ManiaMapAnalyser's; the other rulesets have none
        this.el!.querySelector<HTMLElement>(".fs-stat-pattern")!.hidden = d.mode !== 3;
        const canvas = this.el!.querySelector<HTMLCanvasElement>(".fs-pf")!;
        this.field = osuChart(d)
          ? new OsuPlayfield(canvas, d, renderer as OsuRenderer)
          : catchChart(d)
            ? new CatchPlayfield(canvas, d, renderer as CatchRenderer)
            : taikoChart(d)
            ? new TaikoPlayfield(canvas, d, renderer as TaikoRenderer)
            : new ManiaPlayfield(canvas, d, renderer as Renderer);
        this.field.setMods(activeMods(player.mods, map.mode));
        this.practice.chart(map.id, d);
        this.replays.chart(map.id, d);
        this.renderSpeed();
        this.showEmpty(null);
        this.syncSounds();
        // the same beatmap's hitsounds are already in
        if (!same) void this.loadSounds();
        this.graphDrawn = "";
        this.live.clear();
        this.kick();
      })
      .catch(() => this.mapId === map.id && this.showEmpty(null, "Couldn't read this chart."));
  }

  // ── skins ─────────────────────────────────────────────────────────────

  /** The renderer for the current skin and the chart's ruleset; mania: argon if the skin can't be read. */
  private async rendererFor(d: ChartData): Promise<Renderer | TaikoRenderer | OsuRenderer | CatchRenderer> {
    // cached until the next import
    this.skins = await loadSkinList().catch(() => this.skins);
    this.renderSkin();
    const entry = currentSkin(this.skins);
    const list = this.skins ?? NO_SKINS;
    try {
      const skin = await loadSkin(entry, list);
      if (osuChart(d)) return await createOsuRenderer(skin, list, d);
      if (catchChart(d)) return await createCatchRenderer(skin, list);
      return taikoChart(d) ? await createTaikoRenderer(skin, list) : await createRenderer(skin, d.keys);
    } catch (e) {
      console.warn("[skin]", entry.name, e);
      if (osuChart(d)) return createOsuRenderer({ entry, chain: [], own: null }, list, d);
      if (catchChart(d)) return createCatchRenderer({ entry, chain: [], own: null }, list);
      if (!taikoChart(d)) return new ArgonRenderer(d.keys);
      return createTaikoRenderer({ entry, chain: [], own: null }, list);
    }
  }

  private renderSkin(): void {
    const el = this.el;
    if (!el) return;
    const skin = currentSkin(this.skins);
    const lazer = this.skins?.skins.find((s) => s.id === this.skins?.selected);
    el.querySelector(".fs-skin-name")!.textContent = skin.name;
    const sub = el.querySelector(".fs-skin-sub")!;
    if (!lazer || skin.id === lazer.id) sub.textContent = lazer ? "from lazer" : "";
    else sub.innerHTML = `<button class="fs-speed-reset fs-skin-reset" type="button">back to lazer's ${esc(lazer.name)}</button>`;
  }

  private async setSkin(id: string | null): Promise<void> {
    // picking lazer's own skin means following lazer again
    setPrefs({ playfieldSkin: id === this.skins?.selected ? null : id });
    this.renderSkin();
    const field = this.field;
    if (!field) return;
    const job = ++this.skinJob;
    const renderer = await this.rendererFor(field.data);
    if (job !== this.skinJob || this.field !== field) return;
    if (field instanceof OsuPlayfield) field.setRenderer(renderer as OsuRenderer);
    else if (field instanceof CatchPlayfield) field.setRenderer(renderer as CatchRenderer);
    else if (field instanceof TaikoPlayfield) field.setRenderer(renderer as TaikoRenderer);
    else field.setRenderer(renderer as Renderer);
    this.kick();
    void this.loadSounds();
  }

  // ── hitsounds ─────────────────────────────────────────────────────────

  /** Hitsounds play while the playfield shows a chart. */
  private syncSounds(): void {
    const on = this.isOpen && this.mode === "field" && !!this.field;
    hitsounds.setActive(on);
    this.practice?.setActive(on);
  }

  /** The playing chart's hitsounds, with the playfield skin's samples. */
  private async loadSounds(): Promise<void> {
    if (!this.field) return;
    const id = this.mapId;
    const entry = currentSkin(this.skins);
    const chain = await loadSkinSounds(entry, this.skins ?? NO_SKINS).catch((e) => {
      console.warn("[hitsounds] skin", entry.name, e);
      return null;
    });
    if (!chain || !this.field || this.mapId !== id) return;
    await hitsounds.load(this.mapId, chain, entry.id);
    this.renderHitsounds();
  }

  private renderHitsounds(): void {
    const el = this.el;
    if (!el) return;
    const v = store.prefs.hitsoundVolume;
    const slider = el.querySelector<HTMLElement>(".fs-hs-vol")!;
    slider.style.setProperty("--v", `${v * 100}%`);
    slider.setAttribute("aria-valuenow", String(Math.round(v * 100)));
    el.querySelector(".fs-hs-val")!.textContent = v === 0 ? "Off" : `${Math.round(v * 100)} %`;
    const custom = this.field ? hitsounds.custom : null;
    el.querySelector(".fs-hs-sub")!.textContent = custom === null ? "" : custom > 0 ? "the beatmap's own samples, then the skin's" : "from the skin";
  }

  private setHitsoundVolume(v: number): void {
    setPrefs({ hitsoundVolume: Math.round(Math.max(0, Math.min(1, v)) * 100) / 100 });
    this.renderHitsounds();
  }

  private skinMenu(anchor: HTMLElement): void {
    const list = this.skins;
    if (!list?.skins.length) {
      openMenu(anchor, [{ group: "Skins" }, { label: "Import your lazer library to see its skins", disabled: true }], { minWidth: 300 });
      return;
    }
    const cur = currentSkin(list).id;
    // like lazer's list: its own skins first, then yours
    const ordered = [...list.skins.filter((s) => s.protected), ...list.skins.filter((s) => !s.protected)];
    const entries: MenuEntry[] = [{ group: "osu!lazer skins" }];
    for (const s of ordered) {
      entries.push({
        label: s.name,
        hint: s.id === list.selected ? "in lazer" : undefined,
        checked: s.id === cur,
        action: () => void this.setSkin(s.id),
      });
    }
    openMenu(anchor, entries, { minWidth: 320 });
  }

  /** Message in place of the playfield: a ruleset it doesn't show (with a way to pick a difficulty it does), loading, errors. */
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
    const maps = this.playableMaps();
    box.innerHTML = `
      ${icon("lanes-duo")}
      <div class="fs-empty-title">The playfield shows ${PLAYABLE_NAMES}</div>
      <p>${maps.length ? "This difficulty is for another ruleset. Pick one of the set's difficulties it shows:" : "This set has no difficulty it shows."}</p>
      ${maps.length ? `<div class="fs-empty-list">${maps.map((mi) => this.diffButton(mi)).join("")}</div>` : ""}`;
  }

  private playableMaps(): number[] {
    const snap = store.snap!;
    const np = player.now!;
    return snap.sets[np.set].maps.filter((mi) => PLAYABLE.has(snap.maps[mi].mode) && !snap.maps[mi].hidden);
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
    const known = starsKnown(player.mods, m.mode);
    const sr = !known ? undefined : this.data && this.mapId === m.id ? starsAtRate(m.sr, this.data.stars) : player.rate === 1 ? m.sr : undefined;
    // as lazer's song select shows them: with the mods, AR and OD at the rate
    const d = adjustDifficulty({ cs: m.cs, ar: m.ar, od: m.od, hp: m.hp }, player.mods, m.mode, player.rate);
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const parts = [keysOrMode(m), ...(m.mode === 0 || m.mode === 2 ? [`CS ${r1(d.cs)}`, `AR ${r1(d.ar)}`] : []), `OD ${r1(d.od)}`, `HP ${r1(d.hp)}`];
    el.querySelector(".fs-diff")!.innerHTML = `
      ${sr !== undefined ? srChip(sr, "lg", icon("star-fill")) : ""}
      <span class="fs-diff-name"><b>${esc(m.version)}</b><span>${esc(parts.join(" · "))}</span></span>
      ${this.playableMaps().length > 1 ? icon("chevron-down") : ""}`;
  }

  private renderSpeed(): void {
    const el = this.el;
    if (!el) return;
    // osu!taiko scrolls at the speed the chart sets, osu!catch at its AR, osu! doesn't scroll;
    // there's nothing to pick
    const fixed = !(this.field instanceof ManiaPlayfield);
    el.querySelector<HTMLElement>(".fs-setting-speed")!.hidden = fixed;
    if (fixed) return;
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
    this.practice.frame(player.audio.currentTime * 1000);
    const r = player.rate;
    const t = player.audio.currentTime * 1000;

    if (!(field instanceof ManiaPlayfield)) field.draw(t, r);
    else field.draw(t, scrollTime(scrollSpeed().speed) * r, scrollUp(), r);
    this.replays.frame(t);

    // live numbers
    const a = d.analysis;
    const n = d.notes;
    // notes per second: the notes of the second around now, in real time
    const half = 500 * r;
    const nps = (lowerBound(n, t + half) - lowerBound(n, t - half)) / 3;
    this.set("nps", nps.toFixed(0));
    this.set("peak", `peak ${(a.npsPeak * r).toFixed(1)}`);
    // ManiaMapAnalyser's pattern of this second (its report names the chart the same way)
    const rep = d.report;
    let win: string | null = null;
    if (rep?.seconds && rep.labels) {
      const i = rep.seconds[Math.floor((t - (rep.start ?? a.start)) / 1000)] ?? -1;
      const name = i >= 0 ? rep.labels[i] : null;
      win = name ? (CORE_PATTERNS[name as CorePattern]?.label ?? name) : null;
    } else {
      const sec = Math.floor((t - a.start) / 1000);
      win = a.windows?.[sec] ? PATTERNS[a.windows[sec]!].label : null;
    }
    const label = t < a.start ? "Intro" : t > a.end ? "Outro" : (win ?? "Light");
    this.set("pattern", label);
    this.set("pattern-sub", t < a.start || t > a.end ? "no notes" : win ? "ManiaMapAnalyser" : "not much going on");
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
      if (t.closest(".fs-exit")) return this.hide();
      if (t.closest(".fs-play")) return player.toggle();
      if (t.closest(".fs-prev")) return player.prev();
      if (t.closest(".fs-next")) return player.next();
      if (this.practice.click(t)) return;
      if (this.replays.click(t)) return;
      if (rateClick(t)) return;
      const mod = t.closest<HTMLElement>(".fs-mod[data-mod]");
      if (mod) return this.clickMod(mod.dataset.mod as Mod);
      if (t.closest(".fs-mods-reset")) return player.setMods([]);
      const speed = t.closest<HTMLElement>("[data-speed]");
      if (speed) return this.changeSpeed(+speed.dataset.speed!);
      if (t.closest(".fs-skin-reset")) return void this.setSkin(null);
      const skin = t.closest<HTMLElement>(".fs-skin");
      if (skin) return this.skinMenu(skin);
      if (t.closest(".fs-speed-reset")) {
        setPrefs({ scrollSpeed: null });
        this.renderSpeed();
        return this.kick();
      }
      const pick = t.closest<HTMLElement>(".fs-pick[data-map]");
      if (pick) return player.selectMap(+pick.dataset.map!);
      const diff = t.closest<HTMLElement>(".fs-diff");
      if (diff && this.playableMaps().length > 1) this.diffMenu(diff);
    });

    // hitsound volume
    const hs = el.querySelector<HTMLElement>(".fs-hs-vol")!;
    dragSlider(hs, (f) => this.setHitsoundVolume(f));
    hs.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowRight" || e.key === "ArrowUp" ? 0.05 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -0.05 : 0;
      if (!step) return;
      e.preventDefault();
      e.stopPropagation();
      this.setHitsoundVolume(store.prefs.hitsoundVolume + step);
    });
    hs.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.setHitsoundVolume(store.prefs.hitsoundVolume + ((e as WheelEvent).deltaY < 0 ? 0.05 : -0.05));
      },
      { passive: false },
    );

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
    this.practice.bindGraph(graph, (ms) => {
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
            this.hide();
            break;
          case "F3":
          case "F4":
            e.preventDefault();
            if (this.mode === "field" && this.field instanceof ManiaPlayfield) this.changeSpeed(e.key === "F3" ? -1 : 1);
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
    const entries: MenuEntry[] = [{ group: "Difficulties" }];
    for (const mi of this.playableMaps()) {
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
  fullscreen.show(mode);
}

/** Plays a difficulty in the fullscreen playfield looping its hardest part (of `pattern`, osu!mania), at `rate`. */
export function practiceChart(mapIdx: number, opts: { rate?: number; pattern?: PatternName | null } = {}): void {
  const snap = store.snap;
  const m = snap?.maps[mapIdx];
  if (!m) return;
  fullscreen.askPractice(m.id, opts.pattern);
  if (player.now?.set === m.set) player.selectMap(mapIdx);
  else player.playSet(m.set, mapIdx);
  if (opts.rate) player.setRate(opts.rate);
  openFullscreen("field");
}
