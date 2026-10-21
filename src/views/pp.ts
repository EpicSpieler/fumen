/* pp.ts — a difficulty's pp in the chart panel, as osu! works it out (src-tauri/src/pp.rs): the
 * most a play can give at the picked mods and the player's rate, a few accuracies below that, and
 * a play the player types in (Goods, Misses and the rest, mixed as they like).
 *
 * The graph has a line per judgement: how the pp fall as that judgement's count grows while the
 * others stay as typed in, so every line runs through the play typed in. Dragging along a line
 * sets its count. Half Time and Double Time are the player's rate (the chart panel's rate
 * control); the other mods are picked here, once per ruleset for the session. */
import { api, asApiError } from "../lib/api";
import { esc, fixed, num, pct, srChip, statusLabel } from "../lib/format";
import { t } from "../lib/i18n";
import {
  givesPp,
  graphReach,
  niceCeil,
  noCounts,
  PP_MOD_NAMES,
  PP_STEPS,
  ppAsk,
  ppKinds,
  ppLimit,
  ppModsFor,
  ppShownFirst,
  ppTakesCombo,
  type PpAsk,
  type PpCounts,
  type PpKind,
  type PpMod,
} from "../lib/pp";
import { store } from "../lib/store";
import type { PpSheet } from "../lib/types";
import { player } from "../player";
import { fitCanvas } from "../ui/playfield";
import { icon } from "../ui/icons";

/** the mods picked per ruleset (not the rate), for the session */
const picked: Record<number, PpMod[]> = {};
/** the lines shown per ruleset, for the session */
const shownBy: Record<number, PpKind[]> = {};

const GRAPH_PAD = { left: 38, right: 10, top: 10, bottom: 22 };

/** the colour behind an element (the first ancestor that paints one) */
function backdrop(el: Element | null): string {
  for (; el; el = el.parentElement) {
    const bg = getComputedStyle(el).backgroundColor;
    if (bg && bg !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(bg)) return bg;
  }
  return "#000";
}

/** pp as osu! shows them: whole above 100, one decimal below */
export const ppText = (v: number): string => (v >= 100 ? num(Math.round(v)) : fixed(v, 1));

export class PpPanel {
  readonly el: HTMLElement;
  private readonly mode: number;
  private readonly mapId: string;
  private readonly status: number;
  private counts: PpCounts = noCounts();
  private combo: number | null = null;
  private sheet: PpSheet | null = null;
  private ask: PpAsk | null = null;
  private reach = 10;
  private busy = false;
  private again = false;
  private dead = false;
  private failed = "";
  private offs: (() => void)[] = [];
  private resize: ResizeObserver | null = null;
  /** the count under the pointer, while it's on the graph */
  private hover: number | null = null;
  /** the line being dragged */
  private dragging: PpKind | null = null;

  constructor(mapIdx: number) {
    const map = store.snap!.maps[mapIdx];
    this.mode = map.mode;
    this.mapId = map.id;
    this.status = map.status;
    shownBy[this.mode] ??= ppShownFirst(this.mode);
    picked[this.mode] ??= [];
    this.el = document.createElement("section");
    this.el.className = "chart-block chart-pp";
    this.el.innerHTML = `
      <div class="pp-head">
        <div class="label-caps">${t("Performance")}</div>
        <div class="pp-mods" role="group" aria-label="Mods"></div>
      </div>
      <div class="pp-body">
        <div class="pp-sum">
          <div class="pp-max"><span class="cstat-k">${t("Most you can get")}</span><b class="num">–</b><span class="cstat-s pp-max-sub">&nbsp;</span></div>
          <div class="pp-steps num"></div>
        </div>
        <div class="pp-graph-col">
          <div class="pp-graph">
            <canvas class="pp-canvas" aria-label="${t("pp by judgement count")}"></canvas>
            <div class="pp-tip num"></div>
          </div>
          <div class="pp-legend"></div>
        </div>
      </div>
      <div class="pp-play">
        <div class="pp-fields"></div>
        <div class="pp-result"><b class="num">–</b><span class="pp-result-sub num">&nbsp;</span></div>
        <button class="icon-btn sm pp-clear" type="button" data-tip="${t("Back to a perfect play")}" aria-label="${t("Back to a perfect play")}" hidden>${icon("x")}</button>
      </div>
      ${givesPp(this.status) ? "" : `<p class="chart-note pp-note">${t("osu! gives no pp on {status} maps; this is what a play would be worth if it were ranked.", { status: esc(statusLabel(this.status)) })}</p>`}`;
    this.renderMods();
    this.renderFields();
    this.bind();
    this.offs.push(player.bus.on("rate", () => this.onRate()));
    this.resize = new ResizeObserver(() => this.draw());
    this.resize.observe(this.el.querySelector(".pp-graph")!);
    void this.refresh();
  }

  // ── asking ────────────────────────────────────────────────────────────

  private mods(): string[] {
    return picked[this.mode].filter((m) => m !== "HT" && m !== "DT");
  }

  private shown(): PpKind[] {
    return shownBy[this.mode];
  }

  /** Asks pp.rs for everything the panel shows; one question at a time, the latest wins. */
  private async refresh(): Promise<void> {
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    try {
      // the axis needs the chart's judgement count, so the first question only asks for that
      const total = this.sheet?.total;
      const limit = total === undefined ? 0 : Math.min(...this.shown().map((k) => ppLimit(k, total, this.sheet!.tiny)));
      this.reach = graphReach(limit || 1, Math.max(0, ...this.shown().map((k) => this.counts[k])));
      const ask = ppAsk(this.mode, this.counts, this.combo, total === undefined ? [] : this.shown(), this.reach);
      const sheet = await api.getPp(this.mapId, this.mods(), player.rate, ask.plays);
      if (this.dead) return;
      const first = total === undefined;
      this.sheet = sheet;
      this.ask = ask;
      this.failed = "";
      if (first) this.again = true;
      this.render();
    } catch (e) {
      if (this.dead) return;
      this.failed = asApiError(e).message;
      this.render();
    } finally {
      this.busy = false;
      if (this.again && !this.dead) {
        this.again = false;
        void this.refresh();
      }
    }
  }

  private onRate(): void {
    this.renderMods();
    void this.refresh();
  }

  // ── rendering ─────────────────────────────────────────────────────────

  private renderMods(): void {
    const on = picked[this.mode];
    const r = player.rate;
    this.el.querySelector(".pp-mods")!.innerHTML = ppModsFor(this.mode)
      .map((m) => {
        const active = m === "DT" ? r > 1 : m === "HT" ? r < 1 : on.includes(m);
        const tip = (m === "DT" && r > 1) || (m === "HT" && r < 1) ? `${PP_MOD_NAMES[m]} · ${fixed(r, 2)}×` : PP_MOD_NAMES[m];
        return `<button class="chip-toggle pp-mod${active ? " active" : ""}" type="button" data-pp-mod="${m}" aria-pressed="${active}" data-tip="${esc(tip)}">${m}</button>`;
      })
      .join("");
  }

  private renderFields(): void {
    const kinds = ppKinds(this.mode);
    const field = (key: string, label: string, color: string | null, value: number | null, placeholder = "0") =>
      `<label class="pp-field">
        <span class="pp-field-k">${color ? `<i style="background:${color}"></i>` : ""}${esc(label)}</span>
        <input type="number" inputmode="numeric" min="0" step="1" data-pp-count="${key}" value="${value ?? ""}" placeholder="${esc(placeholder)}" aria-label="${esc(label)}">
      </label>`;
    this.el.querySelector(".pp-fields")!.innerHTML =
      kinds.map((k) => field(k.kind, k.label, k.color, this.counts[k.kind] || null)).join("") +
      (ppTakesCombo(this.mode) ? field("combo", "Combo", null, this.combo, this.sheet ? num(this.sheet.maxCombo) : "max") : "");
  }

  private render(): void {
    const s = this.sheet;
    const sub = this.el.querySelector(".pp-max-sub")!;
    const maxEl = this.el.querySelector(".pp-max b")!;
    if (this.failed || !s || !this.ask) {
      maxEl.textContent = "–";
      sub.textContent = this.failed || " ";
      this.el.classList.toggle("is-failed", !!this.failed);
      this.draw();
      return;
    }
    this.el.classList.remove("is-failed");
    const plays = s.plays;
    const r = player.rate;
    maxEl.innerHTML = `${ppText(s.max)}<small>pp</small>`;
    const modText = [...this.mods(), ...(r > 1 ? ["DT"] : r < 1 ? ["HT"] : [])].join("");
    sub.innerHTML = `${srChip(s.stars, "", icon("star-fill"))}<span>${esc(modText || t("No mods"))}${r !== 1 ? ` · ${fixed(r, 2)}×` : ""}</span>`;

    this.el.querySelector(".pp-steps")!.innerHTML = PP_STEPS.map((acc, i) => {
      const p = plays[this.ask!.steps[i]];
      return `<div class="pp-step"><span>${pct(acc / 100, 0)}</span><b>${ppText(p.pp)}</b></div>`;
    }).join("");

    const play = plays[this.ask.play];
    const lost = s.max - play.pp;
    this.el.querySelector(".pp-result b")!.innerHTML = `${ppText(play.pp)}<small>pp</small>`;
    this.el.querySelector(".pp-result-sub")!.textContent = `${pct(play.acc)}${lost > 0.05 ? ` · −${ppText(lost)} pp` : ""}`;
    const touched = Object.values(this.counts).some((v) => v > 0) || this.combo !== null;
    this.el.querySelector<HTMLElement>(".pp-clear")!.hidden = !touched;
    const combo = this.el.querySelector<HTMLInputElement>("[data-pp-count='combo']");
    if (combo) combo.placeholder = num(s.maxCombo);
    for (const input of this.el.querySelectorAll<HTMLInputElement>("[data-pp-count]")) {
      const k = input.dataset.ppCount!;
      input.max = String(k === "combo" ? s.maxCombo : ppLimit(k as PpKind, s.total, s.tiny));
    }

    const kinds = ppKinds(this.mode);
    const shown = this.shown();
    this.el.querySelector(".pp-legend")!.innerHTML = kinds
      .map((k) => {
        const on = shown.includes(k.kind);
        const line = this.ask!.lines.find((l) => l.kind === k.kind);
        const cost = line ? play.pp - plays[line.next].pp : null;
        const costText = cost !== null && cost > 0.005 ? `−${fixed(cost, cost < 10 ? 2 : 1)}` : "";
        const tip = costText ? t("One more {judgement}: {pp} pp", { judgement: k.label, pp: costText }) : on ? t("Hide this line") : t("Show this line");
        return `<button class="chip-toggle pp-line${on ? " active" : ""}" type="button" data-pp-line="${k.kind}" aria-pressed="${on}" data-tip="${esc(tip)}"><i style="background:${k.color}"></i>${esc(k.label)}${costText ? `<span class="pp-cost num">${costText}</span>` : ""}</button>`;
      })
      .join("");
    this.draw();
  }

  // ── the graph ─────────────────────────────────────────────────────────

  /** the graph's frame in CSS pixels: count → x, pp → y */
  private frame(w: number, h: number) {
    const s = this.sheet;
    const top = Math.max(1, s?.max ?? 1);
    // the pp axis starts at a round number under the lowest line, not at 0: the lines use the height
    let low = top;
    for (const line of this.ask?.lines ?? []) for (const i of line.at) low = Math.min(low, s!.plays[i].pp);
    const step = niceCeil(Math.max(top - low, top * 0.08) / 3);
    const floor = low < top * 0.3 ? 0 : Math.floor(low / step) * step;
    const yMax = Math.max(top + (top - floor) * 0.05, floor + step);
    const P = GRAPH_PAD;
    return {
      step,
      floor,
      x: (n: number) => P.left + (n / this.reach) * (w - P.left - P.right),
      y: (pp: number) => P.top + (1 - (pp - floor) / (yMax - floor)) * (h - P.top - P.bottom),
      count: (px: number) => Math.round(((px - P.left) / (w - P.left - P.right)) * this.reach),
    };
  }

  /** pp along a line at any count, between the asked-for ones */
  private along(kind: PpKind, n: number): number | null {
    const line = this.ask?.lines.find((l) => l.kind === kind);
    const s = this.sheet;
    if (!line || !s) return null;
    const { xs, at } = line;
    let i = xs.findIndex((x) => x >= n);
    if (i < 0) i = xs.length - 1;
    if (xs[i] === n || i === 0) return s.plays[at[i]].pp;
    const f = (n - xs[i - 1]) / (xs[i] - xs[i - 1]);
    return s.plays[at[i - 1]].pp + f * (s.plays[at[i]].pp - s.plays[at[i - 1]].pp);
  }

  private draw(): void {
    const canvas = this.el.querySelector<HTMLCanvasElement>(".pp-canvas");
    if (!canvas) return;
    const fit = fitCanvas(canvas);
    if (!fit) return;
    const { ctx, w, h } = fit;
    const s = this.sheet;
    if (!s || !this.ask || this.failed) return;
    const css = getComputedStyle(this.el);
    const ink = css.getPropertyValue("--ink").trim() || "255 255 255";
    const muted = css.getPropertyValue("--t3").trim() || "#888";
    const f = this.frame(w, h);
    const P = GRAPH_PAD;

    // pp lines across, counts along the bottom
    ctx.font = `500 10.5px ${css.fontFamily}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    for (let v = f.floor; f.y(v) >= P.top - 1; v += f.step) {
      ctx.fillStyle = `rgb(${ink} / ${v > f.floor ? 0.06 : 0.12})`;
      ctx.fillRect(P.left, Math.round(f.y(v)), w - P.left - P.right, 1);
      ctx.fillStyle = muted;
      ctx.fillText(num(v), P.left - 8, f.y(v));
    }
    ctx.textBaseline = "alphabetic";
    for (const [i, n] of [0, Math.round(this.reach / 2), this.reach].entries()) {
      ctx.textAlign = i === 0 ? "left" : i === 1 ? "center" : "right";
      ctx.fillStyle = muted;
      ctx.fillText(num(n), f.x(n) + (i === 0 ? -2 : 0), h - 6);
    }

    // the play typed in: a level all the lines pass through
    const play = s.plays[this.ask.play].pp;
    ctx.strokeStyle = `rgb(${ink} / .28)`;
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(P.left, Math.round(f.y(play)) + 0.5);
    ctx.lineTo(w - P.right, Math.round(f.y(play)) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    const kinds = ppKinds(this.mode);
    const color = (k: PpKind) => kinds.find((x) => x.kind === k)!.color;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const line of this.ask.lines) {
      ctx.strokeStyle = color(line.kind);
      ctx.lineWidth = this.dragging === line.kind ? 2.5 : 2;
      ctx.beginPath();
      line.xs.forEach((x, i) => {
        const y = f.y(s.plays[line.at[i]].pp);
        if (i) ctx.lineTo(f.x(x), y);
        else ctx.moveTo(f.x(x), y);
      });
      ctx.stroke();
    }
    const ring = backdrop(this.el);
    const dot = (x: number, y: number, c: string, r = 4) => {
      ctx.beginPath();
      ctx.arc(x, y, r + 2, 0, Math.PI * 2);
      ctx.fillStyle = ring;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.fill();
    };
    for (const line of this.ask.lines) {
      const n = this.counts[line.kind];
      if (n <= this.reach) dot(f.x(n), f.y(play), color(line.kind));
    }

    // the count under the pointer
    const tip = this.el.querySelector<HTMLElement>(".pp-tip")!;
    if (this.hover === null || !this.ask.lines.length) {
      tip.classList.remove("on");
      return;
    }
    const n = this.hover;
    ctx.fillStyle = `rgb(${ink} / .35)`;
    ctx.fillRect(Math.round(f.x(n)), P.top, 1, h - P.top - P.bottom);
    const rows: string[] = [];
    for (const line of this.ask.lines) {
      const v = this.along(line.kind, n);
      if (v === null) continue;
      dot(f.x(n), f.y(v), color(line.kind), 3.5);
      const k = kinds.find((x) => x.kind === line.kind)!;
      rows.push(`<span><i style="background:${k.color}"></i>${num(n)} ${esc(k.label)}</span><b>${ppText(v)} pp</b>`);
    }
    tip.innerHTML = rows.join("");
    tip.classList.add("on");
    const x = f.x(n);
    tip.style.left = `${x}px`;
    tip.classList.toggle("left", x > w * 0.6);
  }

  // ── input ─────────────────────────────────────────────────────────────

  private setCount(kind: PpKind, n: number, fromField = false): void {
    const s = this.sheet;
    const limit = s ? ppLimit(kind, s.total, s.tiny) : Infinity;
    const v = Math.max(0, Math.min(limit, Math.round(n) || 0));
    if (this.counts[kind] === v && !fromField) return;
    this.counts[kind] = v;
    if (!fromField) {
      const input = this.el.querySelector<HTMLInputElement>(`[data-pp-count='${kind}']`);
      if (input) input.value = v ? String(v) : "";
    }
    void this.refresh();
  }

  private bind(): void {
    this.el.addEventListener("click", (e) => {
      const target = e.target as Element;
      const mod = target.closest<HTMLElement>("[data-pp-mod]");
      if (mod) return this.toggleMod(mod.dataset.ppMod as PpMod);
      const line = target.closest<HTMLElement>("[data-pp-line]");
      if (line) {
        const k = line.dataset.ppLine as PpKind;
        const shown = this.shown();
        // one line stays
        if (shown.includes(k) && shown.length > 1) shownBy[this.mode] = shown.filter((x) => x !== k);
        else if (!shown.includes(k)) shownBy[this.mode] = ppKinds(this.mode).map((x) => x.kind).filter((x) => x === k || shown.includes(x));
        void this.refresh();
        return;
      }
      if (target.closest(".pp-clear")) {
        this.counts = noCounts();
        this.combo = null;
        this.renderFields();
        void this.refresh();
      }
    });

    this.el.addEventListener("input", (e) => {
      const input = (e.target as Element).closest<HTMLInputElement>("[data-pp-count]");
      if (!input) return;
      const k = input.dataset.ppCount!;
      const v = input.value.trim() === "" ? null : Math.max(0, Math.round(Number(input.value)) || 0);
      if (k === "combo") {
        this.combo = v === null ? null : Math.min(v, this.sheet?.maxCombo ?? v);
        void this.refresh();
      } else this.setCount(k as PpKind, v ?? 0, true);
    });
    // what's typed past the most there can be is shown as that
    this.el.addEventListener("change", (e) => {
      const input = (e.target as Element).closest<HTMLInputElement>("[data-pp-count]");
      if (!input || input.value.trim() === "") return;
      const k = input.dataset.ppCount!;
      const v = k === "combo" ? this.combo : this.counts[k as PpKind];
      input.value = v ? String(v) : "";
    });

    const graph = this.el.querySelector<HTMLElement>(".pp-graph")!;
    const at = (e: PointerEvent) => {
      const r = graph.getBoundingClientRect();
      const f = this.frame(r.width, r.height);
      return { n: Math.max(0, Math.min(this.reach, f.count(e.clientX - r.left))), y: e.clientY - r.top, f };
    };
    graph.addEventListener("pointermove", (e) => {
      if (!this.ask?.lines.length) return;
      const { n } = at(e);
      this.hover = n;
      if (this.dragging) this.setCount(this.dragging, n);
      this.draw();
    });
    graph.addEventListener("pointerleave", () => {
      if (this.dragging) return;
      this.hover = null;
      this.draw();
    });
    graph.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !this.ask?.lines.length) return;
      const { n, y, f } = at(e);
      // the line nearest the pointer at that count
      let best: PpKind | null = null;
      let dist = Infinity;
      for (const line of this.ask.lines) {
        const v = this.along(line.kind, n);
        if (v === null) continue;
        const d = Math.abs(f.y(v) - y);
        if (d < dist) [best, dist] = [line.kind, d];
      }
      if (!best) return;
      this.dragging = best;
      graph.setPointerCapture(e.pointerId);
      this.setCount(best, n);
      this.draw();
    });
    const end = () => {
      if (!this.dragging) return;
      this.dragging = null;
      this.draw();
    };
    graph.addEventListener("pointerup", end);
    graph.addEventListener("pointercancel", end);
  }

  private toggleMod(m: PpMod): void {
    if (m === "DT" || m === "HT") {
      const r = player.rate;
      player.setRate((m === "DT" ? r > 1 : r < 1) ? 1 : m === "DT" ? 1.5 : 0.75);
      return;
    }
    const on = picked[this.mode];
    if (on.includes(m)) picked[this.mode] = on.filter((x) => x !== m);
    else picked[this.mode] = [...on.filter((x) => !((m === "EZ" && x === "HR") || (m === "HR" && x === "EZ"))), m];
    this.renderMods();
    void this.refresh();
  }

  destroy(): void {
    this.dead = true;
    this.resize?.disconnect();
    this.offs.forEach((f) => f());
    this.el.remove();
  }
}
