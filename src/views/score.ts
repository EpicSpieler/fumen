/* score.ts — a play that just happened, looked at: the result against the best before it, where
 * the accuracy went (the song's density with the losses over it, the worst stretches with their
 * patterns), how the timing leaned, and what to do next (watch the replay, practise a stretch,
 * put the map in a collection, find similar ones). The other plays of the session sit below.
 *
 * The play comes from the replay lazer saved (src-tauri/src/live.rs); it's judged here the way
 * lazer judges it (lib/score-review), on the difficulty as the library has it. */
import { api, asApiError, thumbUrl } from "../lib/api";
import { duration, esc, fixed, num, pct, rankInfo, relativeTime, srChip } from "../lib/format";
import { isBest, playMods, rankNumber, sessionStart } from "../lib/live";
import { chartMods, type Mod } from "../lib/mods";
import { back, canGoBack, go } from "../lib/router";
import { judge, rateHint, review, type LossStretch, type Review } from "../lib/score-review";
import { store } from "../lib/store";
import type { ChartData, LivePlay, MapRow } from "../lib/types";
import { claimContentArt } from "../player";
import { icon } from "../ui/icons";
import { toast } from "../ui/controls";
import { collectionPicker, openSet } from "./actions";
import { practiceChart, watchPlay } from "./fullscreen";
import { t, tn } from "../lib/i18n";

const NAMES: Record<string, string> = {
  perfect: "Perfect", great: "Great", good: "Good", ok: "Ok", meh: "Meh", miss: "Miss",
  large_tick_hit: "Drops", small_tick_hit: "Droplets", slider_tail_hit: "Slider ends",
};
/** OsuColour.ForHitResult */
const COLOURS: Record<string, string> = {
  perfect: "#99eeff", great: "#66ccff", good: "#b3d944", ok: "#88b300", meh: "#ffcc22", miss: "#ed1121",
  large_tick_hit: "#66ccff", small_tick_hit: "#88b300", slider_tail_hit: "#66ccff",
};
/** the results as lib/replay numbers them */
const JUDGED_NAMES = ["Perfect", "Great", "Good", "Ok", "Meh", "Miss"];
const JUDGED_COLOURS = ["#99eeff", "#66ccff", "#b3d944", "#88b300", "#ffcc22", "#ed1121"];
/** the judgements shown, in order, per ruleset */
const SHOWN: Record<number, string[]> = {
  0: ["great", "ok", "meh", "miss"],
  1: ["great", "ok", "miss"],
  2: ["great", "large_tick_hit", "small_tick_hit", "miss"],
  3: ["perfect", "great", "good", "ok", "meh", "miss"],
};
/** a mean hit error worth mentioning, real ms */
const LEAN = 5;

export class ScoreView {
  readonly el: HTMLElement;
  private play: LivePlay | null = null;
  private session: LivePlay[] = [];
  private data: ChartData | null = null;
  private rv: Review | null = null;
  private job = 0;

  constructor(private id: string) {
    this.el = document.createElement("section");
    this.el.className = "view score-view";
    this.el.innerHTML = `<div class="score-loading"><div class="skeleton" style="height:260px"></div></div>`;
    this.el.addEventListener("click", (e) => this.click(e.target as Element));
    void this.load();
  }

  private mapIdx(): number {
    const id = this.play?.map;
    return id ? (store.snap?.maps.findIndex((m) => m.id === id) ?? -1) : -1;
  }

  private async load(): Promise<void> {
    const job = ++this.job;
    let play: LivePlay | null;
    try {
      play = await api.livePlay(this.id);
    } catch (e) {
      play = null;
      toast(asApiError(e).message, { kind: "danger" });
    }
    if (job !== this.job) return;
    this.play = play;
    if (!play) {
      this.el.innerHTML = `<div class="empty-state">${icon("info")}<div class="empty-title">${t("This play isn't here any more")}</div></div>`;
      return;
    }
    const day = await api.livePlays(play.date - 24 * 3600_000).catch(() => [] as LivePlay[]);
    const start = sessionStart(day.filter((p) => p.date <= play.date + 1), play.date);
    this.session = day.filter((p) => p.date >= start - 1);
    this.render();
    // the judging needs the chart (built with the score's chart mods) and its replay
    const mi = this.mapIdx();
    const map = mi >= 0 ? store.snap!.maps[mi] : null;
    if (!map) return;
    try {
      const mods = play.mods.filter((m): m is Mod => ["EZ", "HR", "MR"].includes(m));
      const [d, r] = await Promise.all([api.getChart(map.id, chartMods(mods, map.mode)), api.liveReplay(play.id)]);
      if (job !== this.job) return;
      this.data = d;
      const judged = judge(d, map.od, play.mods, play.rate ?? 1, r.frames);
      this.rv = judged ? review(d, judged, play.rate ?? 1) : null;
    } catch (e) {
      console.warn("[score]", asApiError(e).message);
    }
    if (job === this.job) this.render();
  }

  private render(): void {
    const p = this.play;
    if (!p) return;
    const mi = this.mapIdx();
    const map = mi >= 0 ? store.snap!.maps[mi] : null;
    const set = map ? store.snap!.sets[map.set] : null;
    const g = rankInfo(rankNumber(p.rank));
    const best = isBest(p);
    const delta = p.bestBefore === null ? null : p.accuracy - p.bestBefore;
    const mods = playMods(p);
    const kicker = [t("Just played"), relativeTime(p.date)].join(" · ");
    this.el.innerHTML = `
      <div class="set-hero score-hero">
        <div class="set-hero-art${set?.bg ? "" : " img-missing"}">${set?.bg ? `<img src="${thumbUrl(set.bg, 1280)}" alt="" decoding="async" />` : ""}</div>
        <div class="set-hero-scrim"></div>
        ${canGoBack() ? `<button class="icon-btn set-back on-image score-back" type="button" data-tip="${t("Back")}" aria-label="${t("Back")}">${icon("arrow-left")}</button>` : ""}
        <div class="set-hero-text score-hero-text">
          <div class="label-caps set-kicker">${esc(kicker)}</div>
          <h1 class="set-title score-title">${esc(p.title ?? t("A difficulty that isn't in the library"))}</h1>
          <div class="set-artist">${esc([p.artist, p.version ? `[${p.version}]` : ""].filter(Boolean).join(" "))}</div>
          <div class="meta-line set-meta">
            ${p.stars !== null ? srChip(p.stars) : ""}
            ${mods ? `<span>${esc(mods)}</span>` : ""}
            ${p.length ? `<span class="num">${duration(p.length / (p.rate ?? 1))}</span>` : ""}
          </div>
        </div>
        <div class="score-result">
          <div class="score-grade" style="--c:${g.color}">${g.label}</div>
          <div class="score-acc">
            <b class="num">${pct(p.accuracy)}</b>
            <span class="score-delta num${best ? " up" : ""}">${
              delta === null ? t("First pass") : best ? t("New best, +{d}", { d: pct(delta) }) : t("{d} to your best", { d: pct(-delta) })
            }</span>
          </div>
        </div>
      </div>
      <div class="set-body score-body">
        <div class="score-line">
          <div class="score-counts">${this.counts(p)}</div>
          <div class="score-facts num">
            <span><i>${t("Combo")}</i><b>${num(p.combo)}x</b></span>
            <span><i>${t("Score")}</i><b>${num(p.score)}</b></span>
          </div>
        </div>
        ${this.actions(map)}
        ${this.lossSection(map)}
        ${this.timingSection()}
        ${this.sessionSection()}
      </div>`;
    claimContentArt(set?.bg ? thumbUrl(set.bg, 640) : null);
  }

  /** The judgements as lazer counted them (or as judged here, for a replay without lazer's counts). */
  private counts(p: LivePlay): string {
    const shown = SHOWN[p.mode] ?? SHOWN[3];
    const r = this.rv?.replay;
    if (r && !Object.values(p.statistics).some((n) => n > 0)) {
      return r.results
        .map((i) => `<span class="score-count" style="--c:${JUDGED_COLOURS[i]}"><i>${("names" in r ? r.names[i] : undefined) ?? JUDGED_NAMES[i]}</i><b class="num">${num(this.rv!.counts[i])}</b></span>`)
        .join("");
    }
    return shown
      .filter((k) => k === "miss" || (p.maximumStatistics[k] ?? 0) > 0 || (p.statistics[k] ?? 0) > 0)
      .map((k) => `<span class="score-count" style="--c:${COLOURS[k]}"><i>${NAMES[k]}</i><b class="num">${num(p.statistics[k] ?? 0)}</b></span>`)
      .join("");
  }

  private actions(map: MapRow | null): string {
    if (!map) return `<p class="chart-note">${t("This difficulty isn't in Fumen's library yet, so there's nothing to show on its chart. It turns up after the next import.")}</p>`;
    const worst = this.rv?.stretches[0];
    const hint = this.play ? rateHint(this.play.mode, this.play.accuracy, this.play.rate ?? 1) : null;
    return `
      <div class="score-actions">
        <button class="btn btn-primary score-watch" type="button"${this.rv ? "" : " disabled"}>${icon("play")}<span>${t("Watch the replay")}</span></button>
        ${worst ? `<button class="btn score-practice" type="button" data-a="${worst.start}" data-b="${worst.end}">${icon("repeat")}<span>${t("Practise the worst part")}</span></button>` : ""}
        ${hint ? `<button class="btn score-rate" type="button" data-rate="${hint}" data-tip="${t("Play it again at this rate in the fullscreen playfield")}">${icon("metronome")}<span>${t("Try it at {rate}×", { rate: fixed(hint, 2) })}</span></button>` : ""}
        <button class="btn btn-ghost score-collect" type="button">${icon("collection")}<span>${t("Add to collection")}</span></button>
        <button class="btn btn-ghost score-similar" type="button">${icon("similar")}<span>${t("Similar maps")}</span></button>
        <button class="btn btn-ghost score-set" type="button">${icon("arrow-right")}<span>${t("Open the set")}</span></button>
      </div>`;
  }

  /** The song's density with what was lost over it, and the worst stretches. */
  private lossSection(map: MapRow | null): string {
    if (!map) return "";
    const rv = this.rv;
    const d = this.data;
    if (!rv || !d) return `<section class="section"><h2 class="section-title">${t("Where the accuracy went")}</h2><div class="skeleton" style="height:120px"></div></section>`;
    const total = d.analysis.end + 1000;
    const x = (ms: number) => ((ms / total) * 100).toFixed(3);
    const peak = Math.max(1, ...d.analysis.density);
    const bars = d.analysis.density.map((v, i) => `<i style="left:${x(d.analysis.start + i * 1000)}%;height:${((v / peak) * 100).toFixed(1)}%"></i>`).join("");
    const most = Math.max(1e-9, ...rv.loss);
    const lost = rv.loss.map((v, i) => (v > 0 ? `<i style="left:${x(i * 1000)}%;height:${Math.max(6, (v / most) * 100).toFixed(1)}%"></i>` : "")).join("");
    const marks = rv.misses.map((m) => `<b style="left:${x(m)}%"></b>`).join("");
    const bands = rv.stretches.map((s, i) => `<span class="score-band" style="left:${x(s.start)}%;width:${(((s.end - s.start) / total) * 100).toFixed(3)}%" data-i="${i}"></span>`).join("");
    const list = rv.stretches.length
      ? rv.stretches.map((s, i) => this.stretchRow(s, i)).join("")
      : `<p class="chart-note">${rv.accuracy >= 0.9999 ? t("Nothing lost anywhere.") : t("The losses are spread over the whole song, no part stands out.")}</p>`;
    return `
      <section class="section">
        <h2 class="section-title">${t("Where the accuracy went")}</h2>
        <div class="score-graph" aria-label="${t("Notes per second, with the accuracy lost in each second")}">
          <div class="score-density">${bars}</div>
          <div class="score-lost">${lost}</div>
          <div class="score-misses">${marks}</div>
          ${bands}
        </div>
        <div class="score-graph-axis num"><span>0:00</span><span>${duration(total)}</span></div>
        <div class="score-stretches">${list}</div>
      </section>`;
  }

  private stretchRow(s: LossStretch, i: number): string {
    const parts = [
      s.misses ? tn(s.misses, "{n} miss", "{n} misses") : "",
      s.slips ? tn(s.slips, "{n} below the best result", "{n} below the best result") : "",
    ].filter(Boolean);
    return `
      <div class="score-stretch">
        <span class="score-stretch-n num">${i + 1}</span>
        <span class="score-stretch-when num">${duration(s.start)}–${duration(s.end)}</span>
        <span class="score-stretch-what">${esc(s.pattern ?? "")}</span>
        <span class="score-stretch-how">${parts.join(" · ")}</span>
        <span class="score-stretch-loss num">−${pct(s.loss)}</span>
        <button class="btn btn-ghost btn-sm score-practice" type="button" data-a="${s.start}" data-b="${s.end}">${icon("repeat")}<span>${t("Practise")}</span></button>
      </div>`;
  }

  private timingSection(): string {
    const tm = this.rv?.timing;
    if (!tm) return "";
    const lean = Math.abs(tm.mean) >= LEAN;
    const early = tm.early / Math.max(1, tm.early + tm.late);
    const words = tm.mean >= 0 ? t("{ms} ms late on average", { ms: fixed(tm.mean, 1) }) : t("{ms} ms early on average", { ms: fixed(-tm.mean, 1) });
    return `
      <section class="section">
        <h2 class="section-title">${t("Timing")}</h2>
        <div class="score-timing">
          <div class="score-stat"><i>${t("Average")}</i><b class="num">${words}</b></div>
          <div class="score-stat" data-tip="${t("How much the hits spread: 10 × their standard deviation, in ms. Lower is steadier.")}"><i>${t("Unstable rate")}</i><b class="num">${fixed(tm.ur, 1)}</b></div>
          <div class="score-stat score-lean">
            <i>${t("Early / late")}</i>
            <div class="score-lean-bar"><span style="width:${(early * 100).toFixed(1)}%"></span></div>
            <span class="num score-lean-n">${num(tm.early)} / ${num(tm.late)}</span>
          </div>
        </div>
        ${lean ? `<p class="chart-note">${t("If this stays the same over a few plays, an offset of {ms} ms in osu!lazer could help.", { ms: `${tm.mean > 0 ? "−" : "+"}${Math.round(Math.abs(tm.mean))}` })}</p>` : ""}
      </section>`;
  }

  private sessionSection(): string {
    if (this.session.length < 2) return "";
    return `
      <section class="section">
        <h2 class="section-title">${t("This session")} <span class="section-count num">${this.session.length}</span></h2>
        <div class="score-session">${this.session
          .map((p) => {
            const g = rankInfo(rankNumber(p.rank));
            return `
              <button class="score-session-row${p.id === this.id ? " on" : ""}" type="button" data-id="${esc(p.id)}">
                <span class="grade" style="--c:${g.color}">${g.label}</span>
                <span class="score-session-title">${esc(p.title ?? p.md5)} <i>${esc(p.version ?? "")}</i></span>
                <span class="num">${pct(p.accuracy)}</span>
                <span class="score-session-best">${isBest(p) ? t("best") : ""}</span>
                <span class="num score-session-when">${relativeTime(p.date)}</span>
              </button>`;
          })
          .join("")}</div>
      </section>`;
  }

  private click(target: Element): void {
    const p = this.play;
    if (!p) return;
    const mi = this.mapIdx();
    if (target.closest(".score-back")) return back();
    const row = target.closest<HTMLElement>(".score-session-row");
    if (row?.dataset.id && row.dataset.id !== this.id) return go({ name: "score", id: row.dataset.id }, { replace: true });
    if (mi < 0) return;
    if (target.closest(".score-watch")) {
      watchPlay(mi, {
        id: p.id,
        live: true,
        user: p.player,
        date: p.date,
        accuracy: p.accuracy,
        score: p.score,
        rank: rankNumber(p.rank),
        combo: p.combo,
        mods: p.mods,
        rate: p.rate ?? undefined,
        statistics: JSON.stringify(p.statistics),
      });
      return;
    }
    const pr = target.closest<HTMLElement>(".score-practice");
    if (pr) {
      practiceChart(mi, { section: { a: Number(pr.dataset.a), b: Number(pr.dataset.b) }, rate: p.rate ?? undefined });
      return;
    }
    const rate = target.closest<HTMLElement>(".score-rate");
    if (rate) return practiceChart(mi, { rate: Number(rate.dataset.rate) });
    const collect = target.closest<HTMLElement>(".score-collect");
    if (collect) return collectionPicker(collect, [mi]);
    if (target.closest(".score-similar")) return openSet(store.snap!.maps[mi].set, mi, { similar: true });
    if (target.closest(".score-set")) return openSet(store.snap!.maps[mi].set, mi);
    if (target.closest(".score-band")) {
      const s = this.rv?.stretches[Number((target.closest(".score-band") as HTMLElement).dataset.i)];
      if (s) practiceChart(mi, { section: { a: s.start, b: s.end }, rate: p.rate ?? undefined });
    }
  }

  destroy(): void {
    this.job++;
    this.el.remove();
  }
}
