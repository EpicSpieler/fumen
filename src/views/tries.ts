/* tries.ts — your tries at a difficulty, through tosu (lib/attempts): the one in focus (the last,
 * or one picked below) with how far it got and where it went wrong; where all of them end, as a
 * heat over the song's density; and practising the part that stopped you, in one click: the one
 * this try went wrong in, or the one most tries end at. main.ts opens it by itself when you leave
 * a map in osu! that you failed on, the way a pass opens its score. */
import { api, asApiError, thumbUrl } from "../lib/api";
import { progress, stopHeat, stopSpot, tally, troubleSpot, type Attempt } from "../lib/attempts";
import { displayArtist, displayTitle, duration, esc, fixed, num, pct, rankInfo, relativeTime, srChip } from "../lib/format";
import { rankNumber } from "../lib/live";
import { chartMods } from "../lib/mods";
import type { Section } from "../lib/practice";
import { back, canGoBack } from "../lib/router";
import { patternAt } from "../lib/score-review";
import { store } from "../lib/store";
import type { ChartData, MapRow } from "../lib/types";
import { claimContentArt } from "../player";
import { icon } from "../ui/icons";
import { toast } from "../ui/controls";
import { openSet } from "./actions";
import { practiceChart } from "./fullscreen";
import { t, tn } from "../lib/i18n";

/** tries listed at most */
const LISTED = 200;

const OUTCOME: Record<Attempt["outcome"], () => string> = {
  pass: () => t("Passed"),
  fail: () => t("Failed"),
  quit: () => t("Left"),
  retry: () => t("Restarted"),
};

export class TriesView {
  readonly el: HTMLElement;
  private tries: Attempt[] = [];
  private mapIdx = -1;
  private data: ChartData | null = null;
  /** the chart couldn't be read: the heat shows without the density under it */
  private noChart = false;
  private loaded = false;
  private job = 0;

  constructor(
    private md5: string,
    private focusId?: number,
  ) {
    this.el = document.createElement("section");
    this.el.className = "view score-view tries-view";
    this.el.innerHTML = `<div class="score-loading"><div class="skeleton" style="height:260px"></div></div>`;
    this.el.addEventListener("click", (e) => this.click(e.target as Element));
    void this.load();
  }

  private map(): MapRow | null {
    return this.mapIdx >= 0 ? (store.snap?.maps[this.mapIdx] ?? null) : null;
  }

  /** the try in focus: the one asked for, else the newest */
  private focus(): Attempt | null {
    return this.tries.find((a) => a.id === this.focusId) ?? this.tries[0] ?? null;
  }

  private async load(): Promise<void> {
    const job = ++this.job;
    try {
      const [tries, id] = await Promise.all([api.attemptsForMap(this.md5, LISTED), api.mapByMd5(this.md5).catch(() => null)]);
      if (job !== this.job) return;
      this.tries = tries;
      this.mapIdx = id ? (store.snap?.maps.findIndex((m) => m.id === id) ?? -1) : -1;
    } catch (e) {
      toast(asApiError(e).message, { kind: "danger" });
    }
    this.loaded = true;
    this.render();
    const map = this.map();
    if (!map) return;
    try {
      const d = await api.getChart(map.id, chartMods([], map.mode));
      if (job !== this.job) return;
      this.data = d;
    } catch (e) {
      console.warn("[tries]", asApiError(e).message);
      this.noChart = true;
    }
    if (job === this.job) this.render();
  }

  /** a new try at this map came in (main.ts): it goes on top, in focus */
  add(a: Attempt): void {
    if (a.md5 !== this.md5 || this.tries.some((x) => x.id !== undefined && x.id === a.id)) return;
    this.tries.unshift(a);
    this.focusId = a.id;
    this.render();
  }

  private render(): void {
    if (!this.loaded) return;
    const a = this.focus();
    const map = this.map();
    const set = map ? store.snap!.sets[map.set] : null;
    if (!a) {
      this.el.innerHTML = `
        <div class="empty-state">${icon("info")}
          <div class="empty-title">${t("No tries yet")}</div>
          <div class="empty-sub">${t("Play it in osu! with Follow osu! on, and every try shows up here: how far it got and where it went wrong.")}</div>
        </div>`;
      return;
    }
    const unicode = store.prefs.unicode;
    const title = set ? displayTitle(set, unicode) : t("A difficulty that isn't in the library");
    const artist = set ? displayArtist(set, unicode) : "";
    const kicker = [OUTCOME[a.outcome](), relativeTime(a.ended)].join(" · ");
    this.el.innerHTML = `
      <div class="set-hero score-hero">
        <div class="set-hero-art${set?.bg ? "" : " img-missing"}">${set?.bg ? `<img src="${thumbUrl(set.bg, 1280)}" alt="" decoding="async" />` : ""}</div>
        <div class="set-hero-scrim"></div>
        ${canGoBack() ? `<button class="icon-btn set-back on-image score-back" type="button" data-tip="${t("Back")}" aria-label="${t("Back")}">${icon("arrow-left")}</button>` : ""}
        <div class="set-hero-text score-hero-text">
          <div class="label-caps set-kicker">${esc(kicker)}</div>
          <h1 class="set-title score-title">${esc(title)}</h1>
          <div class="set-artist">${esc([artist, map ? `[${map.version}]` : ""].filter(Boolean).join(" "))}</div>
          <div class="meta-line set-meta">
            ${map ? srChip(map.sr) : ""}
            ${a.mods ? `<span>${esc(a.mods)}</span>` : ""}
            ${a.rate !== 1 ? `<span class="num">${fixed(a.rate, 2)}×</span>` : ""}
          </div>
        </div>
        <div class="score-result">${this.result(a)}</div>
      </div>
      <div class="set-body score-body">
        <div class="score-line">
          <div class="score-counts">${this.counts()}</div>
          <div class="score-facts num">
            <span><i>${t("Accuracy")}</i><b>${pct(a.accuracy)}</b></span>
            <span><i>${t("Misses")}</i><b>${num(a.misses)}</b></span>
            <span><i>${t("Combo")}</i><b>${num(a.maxCombo)}x</b></span>
          </div>
        </div>
        ${this.actions(a, map)}
        ${this.heatSection(a, map)}
        ${this.listSection(a)}
      </div>`;
    claimContentArt(set?.bg ? thumbUrl(set.bg, 640) : null);
  }

  /** a pass: its grade and accuracy; otherwise how far it got */
  private result(a: Attempt): string {
    if (a.outcome === "pass") {
      const g = rankInfo(rankNumber(a.rank));
      return `
        <div class="score-grade" style="--c:${g.color}">${g.label}</div>
        <div class="score-acc"><b class="num">${pct(a.accuracy)}</b><span class="score-delta">${t("Passed")}</span></div>`;
    }
    const p = progress(a);
    const at = duration(a.failedAt ?? a.reached);
    // without the map's length the time is all there is to show
    const below = p === null ? OUTCOME[a.outcome]() : a.outcome === "fail" ? t("Failed at {at}", { at }) : t("Left at {at}", { at });
    return `
      <div class="score-acc">
        <b class="num">${p === null ? at : pct(p, 0)}</b>
        <span class="score-delta">${below}</span>
      </div>`;
  }

  private counts(): string {
    const c = tally(this.tries);
    const chip = (label: string, n: number | string, colour: string) =>
      `<span class="score-count" style="--c:${colour}"><i>${label}</i><b class="num">${typeof n === "number" ? num(n) : n}</b></span>`;
    return [
      chip(t("Tries"), c.tries, "var(--t2)"),
      c.pass ? chip(t("Passed"), c.pass, "var(--success)") : "",
      c.fail ? chip(t("Failed"), c.fail, "var(--danger)") : "",
      c.left ? chip(t("Left early"), c.left, "var(--warning)") : "",
      c.furthest !== null && c.pass === 0 ? chip(t("Furthest"), pct(c.furthest, 0), "var(--accent-ink)") : "",
    ].join("");
  }

  private actions(a: Attempt, map: MapRow | null): string {
    if (!map) return `<p class="chart-note">${t("This difficulty isn't in Fumen's library yet, so there's nothing to practise on. It turns up after the next import.")}</p>`;
    const spot = troubleSpot(a);
    const most = this.mostSpot();
    const same = spot && most && Math.abs(spot.a - most.section.a) < 2000 && Math.abs(spot.b - most.section.b) < 2000;
    return `
      <div class="score-actions">
        ${spot ? `<button class="btn btn-primary tries-practice" type="button" data-a="${spot.a}" data-b="${spot.b}">${icon("repeat")}<span>${a.outcome === "fail" ? t("Practise where you failed") : t("Practise where you left")}</span></button>` : ""}
        ${most && !same ? `<button class="btn tries-practice" type="button" data-a="${most.section.a}" data-b="${most.section.b}">${icon("repeat")}<span>${t("Practise where most tries end")}</span></button>` : ""}
        <button class="btn btn-ghost tries-set" type="button">${icon("arrow-right")}<span>${t("Open the set")}</span></button>
      </div>
      ${spot ? `<p class="chart-note tries-spot">${this.spotWords(spot, a.rate)}</p>` : ""}`;
  }

  /** "1:12–1:25, Jumpstream, at 1.5×" */
  private spotWords(s: Section, rate: number): string {
    const pattern = this.data ? patternAt(this.data, s.a, s.b) : null;
    return [`<span class="num">${duration(s.a)}–${duration(s.b)}</span>`, pattern ? esc(pattern) : "", rate !== 1 ? t("at {rate}×, the speed you played it", { rate: fixed(rate, 2) }) : ""].filter(Boolean).join(" · ");
  }

  private seconds(): number {
    const d = this.data;
    const last = Math.max(0, ...this.tries.map((a) => a.lastObject ?? 0), ...this.tries.map((a) => a.failedAt ?? a.reached));
    return Math.ceil(((d ? d.analysis.end : last) + 1000) / 1000);
  }

  private mostSpot(): { section: Section; stops: number } | null {
    return stopSpot(this.tries, this.seconds());
  }

  /** The song's density, where the tries end over it, and this try's misses and spot. */
  private heatSection(a: Attempt, map: MapRow | null): string {
    if (!map) return "";
    const d = this.data;
    if (!d && !this.noChart) return `<section class="section"><h2 class="section-title">${t("Where your tries end")}</h2><div class="skeleton" style="height:120px"></div></section>`;
    const seconds = this.seconds();
    const total = seconds * 1000;
    const x = (ms: number) => ((Math.min(Math.max(ms, 0), total) / total) * 100).toFixed(3);
    const peak = d ? Math.max(1, ...d.analysis.density) : 1;
    const bars = d ? d.analysis.density.map((v, i) => `<i style="left:${x(d.analysis.start + i * 1000)}%;height:${((v / peak) * 100).toFixed(1)}%"></i>`).join("") : "";
    const heat = stopHeat(this.tries, seconds)
      .map((h, i) => (h > 0.04 ? `<i style="left:${x(i * 1000)}%;width:${(100 / seconds).toFixed(3)}%;--h:${h.toFixed(3)}"></i>` : ""))
      .join("");
    const stops = this.tries
      .filter((o) => o.outcome !== "pass")
      .map((o) => `<b class="${o.outcome === "fail" ? "fail" : "left"}${o === a ? " on" : ""}" style="left:${x(o.failedAt ?? o.reached)}%"></b>`)
      .join("");
    const misses = a.missesAt.map((m) => `<b style="left:${x(m)}%"></b>`).join("");
    const spot = troubleSpot(a);
    const band = spot ? `<span class="score-band tries-band" style="left:${x(spot.a)}%;width:${(((spot.b - spot.a) / total) * 100).toFixed(3)}%" data-a="${spot.a}" data-b="${spot.b}" data-tip="${t("Practise this part")}"></span>` : "";
    const most = this.mostSpot();
    const note = most
      ? t("{n} tries end around {from}–{to}{pattern}.", {
          n: num(most.stops),
          from: duration(most.section.a),
          to: duration(most.section.b),
          pattern: (() => {
            const p = d ? patternAt(d, most.section.a, most.section.b) : null;
            return p ? `, ${p}` : "";
          })(),
        })
      : this.tries.some((o) => o.outcome !== "pass")
        ? t("Once a few tries end at the same place, it lights up here.")
        : t("Every try here was a pass.");
    return `
      <section class="section">
        <h2 class="section-title">${t("Where your tries end")}</h2>
        <div class="score-graph tries-graph" aria-label="${t("Notes per second, with where the tries ended over it")}">
          <div class="score-density">${bars}</div>
          <div class="tries-heat">${heat}</div>
          <div class="score-misses">${misses}</div>
          <div class="tries-stops">${stops}</div>
          ${band}
        </div>
        <div class="score-graph-axis num"><span>0:00</span><span>${duration(total)}</span></div>
        <p class="chart-note">${esc(note)}</p>
      </section>`;
  }

  private listSection(focus: Attempt): string {
    if (this.tries.length < 2) return "";
    return `
      <section class="section">
        <h2 class="section-title">${t("Your tries")} <span class="section-count num">${this.tries.length}</span></h2>
        <div class="score-session tries-list">${this.tries
          .map((a) => {
            const p = a.outcome === "pass" ? 1 : progress(a);
            const g = a.outcome === "pass" ? rankInfo(rankNumber(a.rank)) : null;
            return `
              <button class="score-session-row tries-row${a === focus ? " on" : ""}" type="button" data-id="${a.id ?? ""}">
                <span class="tries-outcome ${a.outcome}">${g ? `<span class="grade" style="--c:${g.color}">${g.label}</span>` : esc(OUTCOME[a.outcome]())}</span>
                <span class="tries-progress" aria-label="${p === null ? "" : pct(p, 0)}"><i style="width:${((p ?? 0) * 100).toFixed(1)}%"></i></span>
                <span class="num">${pct(a.accuracy)}</span>
                <span class="tries-misses num">${tn(a.misses, "{n} miss", "{n} misses")}${a.mods ? ` · ${esc(a.mods)}` : ""}</span>
                <span class="num score-session-when">${relativeTime(a.ended)}</span>
              </button>`;
          })
          .join("")}</div>
      </section>`;
  }

  private click(target: Element): void {
    if (target.closest(".score-back")) return back();
    const row = target.closest<HTMLElement>(".tries-row");
    if (row?.dataset.id) {
      this.focusId = Number(row.dataset.id);
      return this.render();
    }
    const mi = this.mapIdx;
    if (mi < 0) return;
    const pr = target.closest<HTMLElement>(".tries-practice, .tries-band");
    if (pr) {
      const a = this.focus();
      practiceChart(mi, { section: { a: Number(pr.dataset.a), b: Number(pr.dataset.b) }, rate: a?.rate !== 1 ? a?.rate : undefined });
      return;
    }
    if (target.closest(".tries-set")) return openSet(store.snap!.maps[mi].set, mi);
  }

  destroy(): void {
    this.job++;
    this.el.remove();
  }
}
