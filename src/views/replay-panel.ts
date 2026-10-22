/* replay-panel.ts — replays beside the fullscreen playfield (every ruleset): who plays it
 * (autoplay, or one of lazer's scores on the difficulty that has a replay), and while a replay
 * plays, how it's going: the accuracy so far, the judgements so far, the latest hits on an error
 * bar with lazer's windows (osu!catch has no timing to show), and the misses — marked on the
 * density graph, one click away each.
 *
 * Logged in, the menu also finds the player's own scores on osu! (one request, when asked): their
 * replays come from osu! when picked, one at a time, and stay on this PC. Replays only, never
 * beatmap files.
 *
 * Picking a replay sets the score's rate and the mods Fumen draws (Mirror rebuilds the chart);
 * the judging (lib/replay) keeps the score's own rate, so watching it slower changes nothing.
 */
import { api, asApiError } from "../lib/api";
import { date, fixed, num, pct } from "../lib/format";
import { maniaWindows, ManiaReplay, MISS, playedNotes, unreplayed } from "../lib/replay";
import { CatchReplay, catchUnreplayed } from "../lib/catch-replay";
import { OsuReplay, osuOd, osuUnreplayed } from "../lib/osu-replay";
import { TaikoReplay, taikoOd, taikoUnreplayed } from "../lib/taiko-replay";
import { store } from "../lib/store";
import type { ChartData, OnlineReplayEntry, ReplayEntry } from "../lib/types";
import type { Mod } from "../lib/mods";
import { player } from "../player";
import { openMenu, toast, type MenuEntry } from "../ui/controls";
import { icon } from "../ui/icons";
import { ComboLine } from "../ui/flashlight";
import { fitCanvas } from "../ui/playfield";
import { CatchPlayfield } from "../ui/catch/playfield";
import { ManiaPlayfield } from "../ui/mania/playfield";
import { OsuPlayfield } from "../ui/osu/playfield";
import { TaikoPlayfield } from "../ui/taiko/playfield";
import { t, tn } from "../lib/i18n";

const DRAWN: readonly string[] = ["EZ", "HR", "HD", "FI", "FL", "MR"];
/** the rulesets */
const OSU = 0;
const TAIKO = 1;
const CATCH = 2;
const MANIA = 3;
const NAMES = ["Perfect", "Great", "Good", "Ok", "Meh", "Miss"];
/** OsuColour.ForHitResult */
const COLOURS = ["#99eeff", "#66ccff", "#b3d944", "#88b300", "#ffcc22", "#ed1121"];
/** how long a hit stays on the error bar, real ms */
const TICK_LIFE = 3000;
/** a miss is jumped to this much before it, song ms */
const LEAD = 2000;

/** what a replay is: lazer's (by its score id; `live`: a play that just happened, by its replay
 * file) or osu!'s (by osu!'s score id) */
type Entry = (ReplayEntry & { online?: false; live?: boolean }) | (Omit<OnlineReplayEntry, "id"> & { id: string; online: true; scoreId: number });

interface Playing {
  entry: Entry;
  frames: number[];
}

export class ReplayPanel {
  private mapId = "";
  private data: ChartData | null = null;
  private list: ReplayEntry[] | null = null;
  /** the player's scores on osu! (null until asked for) */
  private online: OnlineReplayEntry[] | null = null;
  private asking = false;
  private playing: Playing | null = null;
  private replay: ManiaReplay | TaikoReplay | OsuReplay | CatchReplay | null = null;
  /** the replay's combo (misses break it) */
  private combo: ComboLine | null = null;
  private misses: number[] = [];
  /** last text per field, so frames only touch the DOM on changes */
  private shown = new Map<string, string>();
  private job = 0;
  /** a replay to start once its difficulty's chart is in */
  private asked: { mapId: string; entry: Entry } | null = null;

  constructor(
    private root: HTMLElement,
    private field: () => unknown,
    private kick: () => void,
  ) {}

  static settingHtml(): string {
    return `
      <div class="fs-setting fs-replay-set" hidden>
        <span class="fs-k">${t("Played by")}</span>
        <button class="fs-skin fs-replay-pick" type="button" aria-label="${t("Who plays it")}"><span class="fs-replay-name">Autoplay</span>${icon("chevron-down")}</button>
        <span class="fs-replay-sub"></span>
      </div>`;
  }

  static panelHtml(): string {
    return `
      <div class="fs-replay" hidden>
        <div class="fs-replay-top">
          <div class="fs-stat fs-acc" data-tip="${t("Judged the way osu!lazer judges it now. Scores from before mid-2025 were judged with older hit windows, so they can come out a little different here.")}"><span class="fs-k">${t("Accuracy so far")}</span><b class="num" data-r="acc">–</b><span class="fs-s num" data-r="acc-sub"></span></div>
          <div class="fs-counts num" data-r="counts"></div>
        </div>
        <div class="fs-errors-box">
          <canvas class="fs-errors" aria-label="${t("Hit errors")}"></canvas>
          <div class="fs-errors-axis num"><span>${t("early")}</span><span data-r="err"></span><span>${t("late")}</span></div>
        </div>
        <div class="fs-miss-nav">
          <span class="fs-k">${t("Misses")}</span>
          <b class="num" data-r="misses">–</b>
          <span class="fs-miss-btns">
            <button class="icon-btn sm fs-miss-prev" type="button" data-tip="${t("The miss before")}" aria-label="${t("The miss before")}">${icon("chevron-left")}</button>
            <button class="icon-btn sm fs-miss-next" type="button" data-tip="${t("The next miss")}" aria-label="${t("The next miss")}">${icon("chevron-right")}</button>
          </span>
        </div>
      </div>`;
  }

  /** Plays `entry` once `mapId`'s chart is on the playfield. */
  ask(mapId: string, entry: ReplayEntry & { live?: boolean }): void {
    this.asked = { mapId, entry };
    if (this.data && this.mapId === mapId) this.chart(mapId, this.data);
  }

  /** The chart the playfield shows (null while it loads or for another ruleset). */
  chart(mapId: string, d: ChartData | null): void {
    if (mapId !== this.mapId) {
      this.mapId = mapId;
      this.list = null;
      this.online = null;
      this.stop(false);
      if (mapId) void this.loadList(mapId);
    }
    this.data = d;
    if (d && this.asked?.mapId === mapId) {
      const { entry } = this.asked;
      this.asked = null;
      void this.start(entry);
    }
    this.root.querySelector<HTMLElement>(".fs-replay-set")!.hidden = !(d && ((d.mode === MANIA && d.keys > 0) || (d.mode === TAIKO && d.taiko) || (d.mode === OSU && d.osu) || (d.mode === CATCH && d.catch)));
    if (d && this.playing) this.apply();
    this.render();
  }

  /** Every frame: the numbers so far and the error bar. */
  frame(time: number): void {
    const r = this.replay;
    if (!r) return;
    const s = r.stats(time);
    this.set("acc", s.judged ? pct(s.accuracy) : "–");
    this.set("acc-sub", s.judged ? t("{n} judged", { n: num(s.judged) }) : t("nothing judged yet"));
    this.set(
      "counts",
      r.results.map((i) => `<span style="--c:${COLOURS[i]}"><i>${("names" in r ? r.names[i] : undefined) ?? NAMES[i]}</i><b>${num(s.counts[i])}</b></span>`).join(""),
      true,
    );
    const before = this.misses.filter((m) => m <= time).length;
    this.set("misses", this.misses.length ? t("{shown} of {n}", { shown: num(before), n: num(this.misses.length) }) : t("none"));
    this.drawErrors(r, time);
  }

  /** The replay's combo at `time`; null while autoplay plays. */
  comboAt(time: number): number | null {
    return this.combo ? this.combo.at(time) : null;
  }

  /** Handles a click in the panel; true when it was one. */
  click(t: Element): boolean {
    const pick = t.closest<HTMLElement>(".fs-replay-pick");
    if (pick) {
      this.menu(pick);
      return true;
    }
    if (t.closest(".fs-miss-prev") || t.closest(".fs-miss-next")) {
      const now = player.audio.currentTime * 1000;
      const next = !!t.closest(".fs-miss-next");
      // the miss being looked at counts as passed
      const at = next ? this.misses.find((m) => m - LEAD > now + 50) : [...this.misses].reverse().find((m) => m - LEAD < now - 300);
      if (at !== undefined) {
        player.audio.currentTime = Math.max(0, at - LEAD) / 1000;
        this.kick();
      }
      return true;
    }
    return false;
  }

  private async loadList(mapId: string): Promise<void> {
    const job = ++this.job;
    const list = await api.replaysForMap(mapId).catch(() => [] as ReplayEntry[]);
    if (job !== this.job || mapId !== this.mapId) return;
    this.list = list;
    this.render();
  }

  private menu(anchor: HTMLElement): void {
    const list = this.list ?? [];
    const entries: MenuEntry[] = [
      { group: t("Played by") },
      { label: "Autoplay", checked: !this.playing, radio: "replay", action: () => this.stop(true) },
    ];
    if (list.length) entries.push({ group: t("Replays in osu!lazer") });
    for (const e of list) {
      const mods = e.mods.filter((m) => m !== "CL");
      entries.push({
        label: `${e.user ?? t("Someone")} · ${e.accuracy !== undefined ? pct(e.accuracy) : "–"}${mods.length ? ` · ${mods.join("")}` : ""}`,
        hint: e.date ? date(e.date) : undefined,
        checked: this.playing?.entry.id === e.id,
        radio: "replay",
        disabled: this.blocked(e.mods),
        action: () => void this.start(e),
      });
    }
    if (!list.length) entries.push({ label: this.list ? t("No replays of this difficulty in lazer") : t("Looking for replays…"), disabled: true });
    // the player's own scores on osu!
    entries.push({ group: t("Your scores on osu!") });
    if (this.online === null) {
      entries.push({
        label: this.asking ? t("Asking osu!…") : t("Find your replays on osu!"),
        icon: "search",
        disabled: this.asking,
        action: () => void this.askOsu(anchor),
      });
    } else if (!this.online.length) entries.push({ label: t("No other scores of yours on osu!"), disabled: true });
    for (const o of this.online ?? []) {
      const mods = o.mods.filter((m) => m !== "CL");
      const e: Entry = { ...o, id: `osu:${o.id}`, online: true, scoreId: o.id };
      entries.push({
        label: `${pct(o.accuracy)}${mods.length ? ` · ${mods.join("")}` : ""} · ${num(o.score)}`,
        hint: o.hasReplay ? (o.cached ? date(o.date) : `${date(o.date)} · ${t("download")}`) : t("no replay on osu!"),
        checked: this.playing?.entry.id === e.id,
        radio: "replay",
        disabled: !o.hasReplay || this.blocked(o.mods),
        action: () => void this.start(e),
      });
    }
    openMenu(anchor, entries, { minWidth: 340 });
  }

  /** Whether a score's mods keep it from being replayed here. */
  private blocked(mods: string[]): boolean {
    const mode = this.data?.mode;
    return (mode === OSU ? osuUnreplayed(mods) : mode === TAIKO ? taikoUnreplayed(mods) : mode === CATCH ? catchUnreplayed(mods) : unreplayed(mods)).length > 0;
  }

  /** The player's scores on osu! for this difficulty, then the menu again. */
  private async askOsu(anchor: HTMLElement): Promise<void> {
    const mapId = this.mapId;
    this.asking = true;
    try {
      const list = await api.onlineReplaysForMap(mapId);
      if (mapId !== this.mapId) return;
      this.online = list;
    } catch (err) {
      toast(t("Couldn't ask osu!: {error}", { error: asApiError(err).message }), { kind: "danger", timeout: 5000 });
      return;
    } finally {
      this.asking = false;
    }
    if (anchor.isConnected) this.menu(anchor);
  }

  private async start(e: Entry): Promise<void> {
    const job = ++this.job;
    let frames: number[];
    try {
      const r = e.online ? await api.getOnlineReplay(e.scoreId) : e.live ? await api.liveReplay(e.id) : await api.getReplay(e.id);
      if (e.online) {
        e.cached = true;
        const o = this.online?.find((x) => x.id === e.scoreId);
        if (o) o.cached = true;
      }
      if (r.mode !== this.data?.mode) throw new Error(t("This replay is of another ruleset."));
      frames = r.frames;
    } catch (err) {
      toast(t("Couldn't read the replay: {error}", { error: asApiError(err).message }), { kind: "danger", timeout: 5000 });
      return;
    }
    if (job !== this.job) return;
    this.playing = { entry: e, frames };
    // the score's rate and the mods the playfield draws (Mirror builds the chart again)
    player.setRate(e.rate ?? 1);
    player.setMods(e.mods.filter((m): m is Mod => DRAWN.includes(m)));
    this.apply();
    player.audio.currentTime = 0;
    if (!player.playing) player.toggle();
    this.kick();
  }

  /** Puts the replay on the playfield showing the chart now. */
  private apply(): void {
    const d = this.data;
    const p = this.playing;
    const field = this.field();
    const map = store.snap?.maps.find((m) => m.id === this.mapId);
    if (!d || !p || !map) return;
    if (field instanceof ManiaPlayfield) {
      const notes = playedNotes(d.notes, p.entry.mods);
      const replay = new ManiaReplay(notes, d.keys, p.frames, maniaWindows(map.od, p.entry.mods, p.entry.rate ?? 1));
      field.setPlay(replay, notes);
      this.replay = replay;
    } else if (field instanceof TaikoPlayfield && d.taiko) {
      const replay = new TaikoReplay(d.taiko, p.frames, taikoOd(map.od, p.entry.mods), p.entry.mods);
      field.setPlay(replay);
      this.replay = replay;
    } else if (field instanceof CatchPlayfield && d.catch) {
      const replay = new CatchReplay(field.chart, p.frames);
      field.setPlay(replay);
      this.replay = replay;
    } else if (field instanceof OsuPlayfield && d.osu) {
      // the playfield's chart has the score's Easy / Hard Rock / Mirror built in
      const replay = new OsuReplay(field.chart, p.frames, osuOd(map.od, p.entry.mods), p.entry.rate ?? 1);
      field.setPlay(replay);
      this.replay = replay;
    } else return;
    this.misses = this.replay.judgements.filter((j) => j.result === MISS).map((j) => j.time);
    const events: [number, number][] = this.replay.judgements.map((j) => [j.time, j.result === MISS ? -1 : 1]);
    if (this.replay instanceof OsuReplay) events.push(...this.replay.nestedCombo);
    this.combo = new ComboLine(events);
    this.shown.clear();
    this.renderMarks();
    this.render();
  }

  /** Back to autoplay. */
  private stop(redraw: boolean): void {
    this.job++;
    this.playing = null;
    this.replay = null;
    this.combo = null;
    this.misses = [];
    const field = this.field();
    if (field instanceof ManiaPlayfield || field instanceof TaikoPlayfield || field instanceof OsuPlayfield || field instanceof CatchPlayfield) field.setPlay(null);
    this.renderMarks();
    if (redraw) {
      this.render();
      this.kick();
    }
  }

  private render(): void {
    const el = this.root;
    const p = this.playing;
    el.querySelector(".fs-replay-name")!.textContent = p ? (p.entry.user ?? t("Someone")) : "Autoplay";
    const sub = el.querySelector(".fs-replay-sub")!;
    if (p) {
      const e = p.entry;
      const mods = e.mods.filter((m) => m !== "CL");
      sub.textContent = [e.accuracy !== undefined ? pct(e.accuracy) : "", mods.join(""), e.date ? date(e.date) : ""].filter(Boolean).join(" · ");
    } else sub.textContent = this.list === null ? "" : this.list.length ? tn(this.list.length, "{n} replay in lazer", "{n} replays in lazer") : t("no replays in lazer");
    el.querySelector<HTMLElement>(".fs-replay")!.hidden = !this.replay;
    el.querySelector<HTMLElement>(".fs-live")!.classList.toggle("has-replay", !!this.replay);
  }

  /** The misses on the density graph. */
  private renderMarks(): void {
    const box = this.root.querySelector<HTMLElement>(".fs-graph-marks")!;
    const total = (this.data?.analysis.end ?? 0) + 1000;
    box.innerHTML = this.replay && total > 1000 ? this.misses.map((m) => `<i style="left:${((m / total) * 100).toFixed(2)}%"></i>`).join("") : "";
  }

  private set(key: string, text: string, html = false): void {
    if (this.shown.get(key) === text) return;
    this.shown.set(key, text);
    const node = this.root.querySelector(`[data-r="${key}"]`);
    if (!node) return;
    if (html) node.innerHTML = text;
    else node.textContent = text;
  }

  /** The latest hits against lazer's windows (the best in the middle, the widest hit at the ends). */
  private drawErrors(r: ManiaReplay | TaikoReplay | OsuReplay | CatchReplay, time: number): void {
    const windows = r.barWindows();
    const box = this.root.querySelector<HTMLElement>(".fs-errors-box")!;
    box.hidden = !windows.length;
    if (!windows.length) return;
    const c = this.root.querySelector<HTMLCanvasElement>(".fs-errors")!;
    const fit = fitCanvas(c);
    if (!fit) return;
    const { ctx, w, h } = fit;
    const edge = windows[0][1];
    const mid = w / 2;
    const x = (off: number) => mid + (Math.max(-edge, Math.min(edge, off)) / edge) * (mid - 2);
    // the windows, widest first
    for (const [result, window] of windows) {
      ctx.fillStyle = COLOURS[result];
      ctx.globalAlpha = 0.22;
      const half = (window / edge) * (mid - 2);
      ctx.fillRect(mid - half, h / 2 - 2, half * 2, 4);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(255,255,255,.8)";
    ctx.fillRect(mid - 1, h / 2 - 9, 2, 18);
    // the hits of the last few seconds
    const js = r.judgements;
    const life = TICK_LIFE * player.rate;
    let sum = 0;
    let n = 0;
    let i = js.length - 1;
    while (i >= 0 && js[i].time > time) i--;
    for (; i >= 0 && time - js[i].time < life; i--) {
      const j = js[i];
      if (j.tail || !Number.isFinite(j.offset) || j.result === MISS) continue;
      ctx.globalAlpha = 1 - (time - j.time) / life;
      ctx.fillStyle = COLOURS[j.result];
      ctx.fillRect(x(j.offset) - 1, 4, 2, h - 8);
      sum += j.offset;
      n++;
    }
    ctx.globalAlpha = 1;
    // where they lean
    if (n) {
      const ax = x(sum / n);
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.moveTo(ax - 5, 0);
      ctx.lineTo(ax + 5, 0);
      ctx.lineTo(ax, 5);
      ctx.fill();
    }
    this.set("err", n ? t("{ms} ms on average", { ms: `${sum / n >= 0 ? "+" : "−"}${fixed(Math.abs(sum / n / (this.playing?.entry.rate ?? 1)), 1)}` }) : "");
  }
}

