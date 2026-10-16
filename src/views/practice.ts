/* practice.ts — practice mode beside the fullscreen playfield (lib/practice for the parts and the
 * metronome):
 *
 *  - a loop over a part of the chart: dragged across the density graph (on the beat), or its
 *    hardest part; the song goes back a moment before A every time it reaches B. The part is
 *    remembered per difficulty
 *  - Speed up: the loop starts 0.20× under the rate you had and climbs 0.05× each time round,
 *    up to it
 *  - a metronome on the timing points
 *
 * A click on the graph still seeks; only a drag picks a part.
 */
import { duration, fixed, num } from "../lib/format";
import { hardest, metronome, notesIn, savedSection, saveSection, snapBeat, type Section } from "../lib/practice";
import type { ChartData, PatternName } from "../lib/types";
import { player, RATE_MIN, RATE_STEP } from "../player";
import { icon } from "../ui/icons";
import { t } from "../lib/i18n";

/** song ms played before A, to see the part coming */
const LEAD = 1500;
/** Speed up starts this far under the rate it climbs to */
const CLIMB = 0.2;
/** a dragged part shorter than this (song ms) is a click */
const SHORTEST = 1000;

export interface PracticeAsk {
  mapId: string;
  /** the pattern whose hardest part to loop (osu!mania) */
  pattern?: PatternName | null;
}

export class PracticePanel {
  private mapId = "";
  private data: ChartData | null = null;
  private section: Section | null = null;
  /** times round the loop */
  private round = 0;
  private climb: { from: number; to: number } | null = null;
  private clicks = false;
  private active = false;
  private asked: PracticeAsk | null = null;

  constructor(
    private root: HTMLElement,
    private kick: () => void,
  ) {}

  static html(): string {
    return `
      <div class="fs-setting fs-practice">
        <span class="fs-k">${t("Practice")}</span>
        <div class="fs-pr-ctl">
          <button class="chip-toggle fs-pr-hard" type="button" data-tip="${t("Loop the densest 16 seconds")}">${icon("repeat")}${t("Hardest part")}</button>
          <button class="chip-toggle fs-pr-climb" type="button" aria-pressed="false" data-tip="${t("Start the loop {down}× slower, {up}× faster each time round", { down: fixed(0.2, 2), up: fixed(0.05, 2) })}">${t("Speed up")}</button>
          <button class="chip-toggle fs-pr-clicks" type="button" aria-pressed="false" data-tip="${t("A tick on every beat, higher on the bar's first")}">${icon("metronome")}${t("Metronome")}</button>
        </div>
        <span class="fs-pr-sub"></span>
      </div>`;
  }

  /** Loops the hardest part of `ask.mapId` once its chart is in (now, if it is). */
  ask(ask: PracticeAsk): void {
    this.asked = ask;
    if (this.data && this.mapId === ask.mapId) this.chart(this.mapId, this.data);
  }

  /** The chart the playfield shows (null while it loads, or none). */
  chart(mapId: string, d: ChartData | null): void {
    if (mapId !== this.mapId) {
      this.mapId = mapId;
      this.round = 0;
      this.climb = null;
      this.section = mapId ? savedSection(mapId) : null;
    }
    this.data = d;
    metronome.setBeats(d?.beats ?? []);
    if (d && this.asked?.mapId === mapId) {
      const pattern = this.asked.pattern;
      this.asked = null;
      this.setSection(hardest(d, pattern), true);
      return;
    }
    this.render();
  }

  /** On while the playfield shows a chart. */
  setActive(on: boolean): void {
    this.active = on;
    metronome.setActive(on && this.clicks);
  }

  /** Every frame while playing: back to A at B. */
  frame(t: number): void {
    const s = this.section;
    if (!s || !this.data || !player.playing || t < s.b) return;
    this.round++;
    const c = this.climb;
    if (c && player.rate < c.to - 1e-6) player.setRate(Math.min(c.to, player.rate + RATE_STEP));
    player.audio.currentTime = this.start() / 1000;
    this.render();
  }

  /** Handles a click in the panel; true when it was one. */
  click(t: Element): boolean {
    if (t.closest(".fs-pr-hard")) {
      if (this.data) this.setSection(hardest(this.data), true);
      return true;
    }
    if (t.closest(".fs-pr-climb")) {
      this.toggleClimb();
      return true;
    }
    if (t.closest(".fs-pr-clicks")) {
      this.clicks = !this.clicks;
      metronome.setActive(this.active && this.clicks);
      this.render();
      return true;
    }
    if (t.closest(".fs-pr-clear")) {
      this.section = null;
      this.round = 0;
      saveSection(this.mapId, null);
      this.render();
      return true;
    }
    return false;
  }

  /** The density graph: a click seeks (`seek`, song ms), a drag picks the part. */
  bindGraph(graph: HTMLElement, seek: (ms: number) => void): void {
    graph.addEventListener("pointerdown", (e) => {
      const d = this.data;
      if (!d || e.button !== 0) return;
      const r = graph.getBoundingClientRect();
      const total = this.total();
      const at = (x: number) => Math.max(0, Math.min(1, (x - r.left) / r.width)) * total;
      const x0 = e.clientX;
      let dragging = false;
      graph.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        if (!dragging && Math.abs(ev.clientX - x0) < 5) return;
        dragging = true;
        this.band(Math.min(at(x0), at(ev.clientX)), Math.max(at(x0), at(ev.clientX)));
      };
      const up = (ev: PointerEvent) => {
        graph.removeEventListener("pointermove", move);
        graph.removeEventListener("pointerup", up);
        graph.removeEventListener("pointercancel", up);
        if (!dragging) return seek(at(x0));
        if (ev.type === "pointercancel") return this.render();
        const a = snapBeat(d.beats, Math.min(at(x0), at(ev.clientX)));
        const b = snapBeat(d.beats, Math.max(at(x0), at(ev.clientX)));
        if (b - a >= SHORTEST) this.setSection({ a: Math.max(0, a), b }, true);
        else this.render();
      };
      graph.addEventListener("pointermove", move);
      graph.addEventListener("pointerup", up);
      graph.addEventListener("pointercancel", up);
    });
  }

  /** Shows the state: the buttons, the line under them, the part on the graph. */
  render(): void {
    const el = this.root;
    const s = this.section;
    const r = player.rate;
    const press = (sel: string, on: boolean) => {
      const b = el.querySelector<HTMLElement>(sel)!;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    };
    press(".fs-pr-climb", !!this.climb);
    press(".fs-pr-clicks", this.clicks);
    const parts: string[] = [];
    if (s && this.data) {
      parts.push(`${duration(s.a / r)} – ${duration(s.b / r)}`, t("{n} notes", { n: num(notesIn(this.data, s)) }));
      if (this.round) parts.push(t("round {n}", { n: num(this.round + 1) }));
    }
    if (this.climb) parts.push(t("{rate}× of {to}×", { rate: fixed(r, 2), to: fixed(this.climb.to, 2) }));
    const sub = el.querySelector(".fs-pr-sub")!;
    sub.innerHTML = s
      ? `${parts.join(" · ")} · <button class="fs-speed-reset fs-pr-clear" type="button">${t("stop looping")}</button>`
      : `${t("Drag across the graph to loop a part")}${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
    if (s && this.data) this.band(s.a, s.b);
    else el.querySelector<HTMLElement>(".fs-graph-loop")!.hidden = true;
  }

  private setSection(s: Section, go: boolean): void {
    this.section = s;
    this.round = 0;
    saveSection(this.mapId, s);
    this.render();
    if (!go) return;
    const a = player.audio;
    const jump = () => {
      a.currentTime = this.start() / 1000;
      if (!player.playing) player.toggle();
      this.kick();
    };
    if (a.readyState < 1) a.addEventListener("loadedmetadata", jump, { once: true });
    else jump();
  }

  private toggleClimb(): void {
    if (this.climb) {
      const to = this.climb.to;
      this.climb = null;
      player.setRate(to);
    } else {
      const to = player.rate;
      const from = Math.max(RATE_MIN, Math.round((to - CLIMB) / RATE_STEP) * RATE_STEP);
      this.climb = { from, to };
      this.round = 0;
      player.setRate(from);
      if (this.section) player.audio.currentTime = this.start() / 1000;
    }
    this.render();
    this.kick();
  }

  /** where each time round starts, song ms */
  private start(): number {
    return Math.max(0, (this.section?.a ?? 0) - LEAD);
  }

  /** the graph's time axis, as the fullscreen draws it */
  private total(): number {
    return (this.data?.analysis.end ?? 0) + 1000;
  }

  private band(a: number, b: number): void {
    const box = this.root.querySelector<HTMLElement>(".fs-graph-loop")!;
    const total = this.total();
    box.hidden = false;
    box.style.left = `${(Math.max(0, a) / total) * 100}%`;
    box.style.width = `${(Math.max(0, Math.min(total, b) - Math.max(0, a)) / total) * 100}%`;
  }
}
