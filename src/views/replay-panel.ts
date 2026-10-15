/* replay-panel.ts — replays beside the fullscreen playfield (osu!mania): who plays it (autoplay,
 * or one of lazer's scores on the difficulty that has a replay), and while a replay plays, how
 * it's going: the accuracy so far, the judgements so far, the latest hits on an error bar with
 * lazer's windows, and the misses — marked on the density graph, one click away each.
 *
 * Logged in, the menu also finds the player's own scores on osu! (one request, when asked): their
 * replays come from osu! when picked, one at a time, and stay on this PC. Replays only, never
 * beatmap files.
 *
 * Picking a replay sets the score's rate and the mods Fumen draws (Mirror rebuilds the chart);
 * the judging (lib/replay) keeps the score's own rate, so watching it slower changes nothing.
 */
import { api, asApiError } from "../lib/api";
import { date, num, pct } from "../lib/format";
import { maniaWindows, ManiaReplay, MISS, playedNotes, unreplayed } from "../lib/replay";
import { store } from "../lib/store";
import type { ChartData, OnlineReplayEntry, ReplayEntry } from "../lib/types";
import type { Mod } from "../lib/mods";
import { player } from "../player";
import { openMenu, toast, type MenuEntry } from "../ui/controls";
import { icon } from "../ui/icons";
import { fitCanvas } from "../ui/playfield";
import { ManiaPlayfield } from "../ui/mania/playfield";

const DRAWN: readonly string[] = ["EZ", "HR", "HD", "FI", "FL", "MR"];
const NAMES = ["Perfect", "Great", "Good", "Ok", "Meh", "Miss"];
/** OsuColour.ForHitResult */
const COLOURS = ["#99eeff", "#66ccff", "#b3d944", "#88b300", "#ffcc22", "#ed1121"];
/** how long a hit stays on the error bar, real ms */
const TICK_LIFE = 3000;
/** a miss is jumped to this much before it, song ms */
const LEAD = 2000;

/** what a replay is: lazer's (by its score id) or osu!'s (by osu!'s score id) */
type Entry = (ReplayEntry & { online?: false }) | (Omit<OnlineReplayEntry, "id"> & { id: string; online: true; scoreId: number });

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
  private replay: ManiaReplay | null = null;
  private misses: number[] = [];
  /** last text per field, so frames only touch the DOM on changes */
  private shown = new Map<string, string>();
  private job = 0;

  constructor(
    private root: HTMLElement,
    private field: () => unknown,
    private kick: () => void,
  ) {}

  static settingHtml(): string {
    return `
      <div class="fs-setting fs-replay-set" hidden>
        <span class="fs-k">Played by</span>
        <button class="fs-skin fs-replay-pick" type="button" aria-label="Who plays it"><span class="fs-replay-name">Autoplay</span>${icon("chevron-down")}</button>
        <span class="fs-replay-sub"></span>
      </div>`;
  }

  static panelHtml(): string {
    return `
      <div class="fs-replay" hidden>
        <div class="fs-replay-top">
          <div class="fs-stat fs-acc" data-tip="Judged the way osu!lazer judges osu!mania now. Scores from before mid-2025 were judged with older hit windows, so they can come out a little different here."><span class="fs-k">Accuracy so far</span><b class="num" data-r="acc">–</b><span class="fs-s num" data-r="acc-sub"></span></div>
          <div class="fs-counts num" data-r="counts"></div>
        </div>
        <div class="fs-errors-box">
          <canvas class="fs-errors" aria-label="Hit errors"></canvas>
          <div class="fs-errors-axis num"><span>early</span><span data-r="err"></span><span>late</span></div>
        </div>
        <div class="fs-miss-nav">
          <span class="fs-k">Misses</span>
          <b class="num" data-r="misses">–</b>
          <span class="fs-miss-btns">
            <button class="icon-btn sm fs-miss-prev" type="button" data-tip="The miss before" aria-label="The miss before">${icon("chevron-left")}</button>
            <button class="icon-btn sm fs-miss-next" type="button" data-tip="The next miss" aria-label="The next miss">${icon("chevron-right")}</button>
          </span>
        </div>
      </div>`;
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
    this.root.querySelector<HTMLElement>(".fs-replay-set")!.hidden = !(d && d.mode === 3 && d.keys > 0);
    if (d && this.playing) this.apply();
    this.render();
  }

  /** Every frame: the numbers so far and the error bar. */
  frame(t: number): void {
    const r = this.replay;
    if (!r) return;
    const s = r.stats(t);
    this.set("acc", s.judged ? pct(s.accuracy) : "–");
    this.set("acc-sub", s.judged ? `${num(s.judged)} judged` : "nothing judged yet");
    this.set(
      "counts",
      s.counts.map((n, i) => `<span style="--c:${COLOURS[i]}"><i>${NAMES[i]}</i><b>${num(n)}</b></span>`).join(""),
      true,
    );
    const before = this.misses.filter((m) => m <= t).length;
    this.set("misses", this.misses.length ? `${num(before)} of ${num(this.misses.length)}` : "none");
    this.drawErrors(r, t);
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
      { group: "Played by" },
      { label: "Autoplay", checked: !this.playing, radio: "replay", action: () => this.stop(true) },
    ];
    if (list.length) entries.push({ group: "Replays in osu!lazer" });
    for (const e of list) {
      const mods = e.mods.filter((m) => m !== "CL");
      entries.push({
        label: `${e.user ?? "Someone"} · ${e.accuracy !== undefined ? pct(e.accuracy) : "–"}${mods.length ? ` · ${mods.join("")}` : ""}`,
        hint: e.date ? date(e.date) : undefined,
        checked: this.playing?.entry.id === e.id,
        radio: "replay",
        disabled: unreplayed(e.mods).length > 0,
        action: () => void this.start(e),
      });
    }
    if (!list.length) entries.push({ label: this.list ? "No replays of this difficulty in lazer" : "Looking for replays…", disabled: true });
    // the player's own scores on osu!
    entries.push({ group: "Your scores on osu!" });
    if (this.online === null) {
      entries.push({
        label: this.asking ? "Asking osu!…" : "Find your replays on osu!",
        icon: "search",
        disabled: this.asking,
        action: () => void this.askOsu(anchor),
      });
    } else if (!this.online.length) entries.push({ label: "No other scores of yours on osu!", disabled: true });
    for (const o of this.online ?? []) {
      const mods = o.mods.filter((m) => m !== "CL");
      const e: Entry = { ...o, id: `osu:${o.id}`, online: true, scoreId: o.id };
      entries.push({
        label: `${pct(o.accuracy)}${mods.length ? ` · ${mods.join("")}` : ""} · ${num(o.score)}`,
        hint: o.hasReplay ? (o.cached ? date(o.date) : `${date(o.date)} · download`) : "no replay on osu!",
        checked: this.playing?.entry.id === e.id,
        radio: "replay",
        disabled: !o.hasReplay || unreplayed(o.mods).length > 0,
        action: () => void this.start(e),
      });
    }
    openMenu(anchor, entries, { minWidth: 340 });
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
      toast(`Couldn't ask osu!: ${asApiError(err).message}`, { kind: "danger", timeout: 5000 });
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
      const r = e.online ? await api.getOnlineReplay(e.scoreId) : await api.getReplay(e.id);
      if (e.online) {
        e.cached = true;
        const o = this.online?.find((x) => x.id === e.scoreId);
        if (o) o.cached = true;
      }
      if (r.mode !== 3) throw new Error("This replay isn't osu!mania.");
      frames = r.frames;
    } catch (err) {
      toast(`Couldn't read the replay: ${asApiError(err).message}`, { kind: "danger", timeout: 5000 });
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
    if (!d || !p || !map || !(field instanceof ManiaPlayfield)) return;
    const notes = playedNotes(d.notes, p.entry.mods);
    this.replay = new ManiaReplay(notes, d.keys, p.frames, maniaWindows(map.od, p.entry.mods, p.entry.rate ?? 1));
    field.setPlay(this.replay, notes);
    this.misses = this.replay.judgements.filter((j) => j.result === MISS).map((j) => j.time);
    this.shown.clear();
    this.renderMarks();
    this.render();
  }

  /** Back to autoplay. */
  private stop(redraw: boolean): void {
    this.job++;
    this.playing = null;
    this.replay = null;
    this.misses = [];
    const field = this.field();
    if (field instanceof ManiaPlayfield) field.setPlay(null);
    this.renderMarks();
    if (redraw) {
      this.render();
      this.kick();
    }
  }

  private render(): void {
    const el = this.root;
    const p = this.playing;
    el.querySelector(".fs-replay-name")!.textContent = p ? (p.entry.user ?? "Someone") : "Autoplay";
    const sub = el.querySelector(".fs-replay-sub")!;
    if (p) {
      const e = p.entry;
      const mods = e.mods.filter((m) => m !== "CL");
      sub.textContent = [e.accuracy !== undefined ? pct(e.accuracy) : "", mods.join(""), e.date ? date(e.date) : ""].filter(Boolean).join(" · ");
    } else sub.textContent = this.list === null ? "" : this.list.length ? `${num(this.list.length)} ${this.list.length === 1 ? "replay" : "replays"} in lazer` : "no replays in lazer";
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

  /** The latest hits against lazer's windows (Perfect in the middle, Meh at the ends). */
  private drawErrors(r: ManiaReplay, t: number): void {
    const c = this.root.querySelector<HTMLCanvasElement>(".fs-errors")!;
    const fit = fitCanvas(c);
    if (!fit) return;
    const { ctx, w, h } = fit;
    const W = r.windows;
    const edge = W[4];
    const mid = w / 2;
    const x = (off: number) => mid + (Math.max(-edge, Math.min(edge, off)) / edge) * (mid - 2);
    // the windows, widest first
    for (let i = 4; i >= 0; i--) {
      ctx.fillStyle = COLOURS[i];
      ctx.globalAlpha = 0.22;
      const half = (W[i] / edge) * (mid - 2);
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
    while (i >= 0 && js[i].time > t) i--;
    for (; i >= 0 && t - js[i].time < life; i--) {
      const j = js[i];
      if (j.tail || !Number.isFinite(j.offset) || j.result === MISS) continue;
      ctx.globalAlpha = 1 - (t - j.time) / life;
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
    this.set("err", n ? `${sum / n >= 0 ? "+" : "−"}${Math.abs(sum / n / (this.playing?.entry.rate ?? 1)).toFixed(1)} ms on average` : "");
  }
}

