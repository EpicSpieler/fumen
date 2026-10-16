/* plays.ts — "Your plays" on one difficulty, in the set page's chart panel: how often, the best,
 * accuracy over time, and the plays themselves. Logged in, osu! is asked for the player's
 * scores on the difficulty too (plays from other computers or stable). */
import { openUrl } from "@tauri-apps/plugin-opener";
import { osuScoreUrl } from "../lib/api";
import { date, esc, MODE_SHORT, num, pct, rankInfo, relativeTime } from "../lib/format";
import { historyEvents, historyNow, loadHistory, modsText, playScoreTip, playsOf, playWhen, playWhenTip, syncMap } from "../lib/history";
import { store } from "../lib/store";
import type { Play } from "../lib/types";
import { icon } from "../ui/icons";
import { openGoalDialog } from "./goal-dialog";
import { t, tn } from "../lib/i18n";

/** plays listed before "Show all" */
const FEW = 5;

export class MapPlays {
  readonly el: HTMLElement;
  private off: () => void;
  private all = false;

  constructor(private mapIdx: number) {
    this.el = document.createElement("div");
    this.el.className = "map-plays";
    const map = store.snap!.maps[mapIdx];
    this.off = historyEvents.on("history", () => this.render());
    loadHistory().then(
      () => {
        this.render();
        syncMap(map);
      },
      () => this.render(),
    );
    this.render();
    this.el.addEventListener("click", (e) => {
      const t = e.target as Element;
      if (t.closest(".plays-all")) {
        this.all = !this.all;
        return this.render();
      }
      if (t.closest(".plays-goal")) return openGoalDialog({ kind: "chart", mapIdx: this.mapIdx });
      const link = t.closest<HTMLElement>(".mplay-web");
      if (link) void openUrl(osuScoreUrl(+link.dataset.id!));
    });
  }

  private render(): void {
    const map = store.snap?.maps[this.mapIdx];
    if (!map) return;
    const head = `<div class="label-caps">${t("Your plays")}</div><button class="btn btn-ghost btn-sm plays-goal" type="button" data-tip="${t("Set an accuracy to reach on this difficulty")}">${icon("flag")}<span>${t("Set a goal")}</span></button>`;
    if (!historyNow()) {
      this.el.innerHTML = `<div class="plays-head">${head}</div><div class="skeleton" style="height:40px"></div>`;
      return;
    }
    const plays = playsOf(map.id);
    if (!plays.length) {
      const note = map.played ? t("Played {when}, without a score osu!lazer kept.", { when: relativeTime(map.played) }) : t("Not played yet.");
      this.el.innerHTML = `<div class="plays-head">${head}</div><p class="chart-note">${note}</p>`;
      return;
    }
    const passes = plays.filter((p) => !p.failed);
    const best = passes.reduce<Play | undefined>((b, p) => (!b || p.score > b.score ? p : b), undefined);
    const first = plays[plays.length - 1];
    const words = [
      tn(plays.length, "{n} play", "{n} plays"),
      best ? `${t("best {acc}", { acc: pct(best.acc) })}${best.pp ? `, ${num(Math.round(best.pp))}pp` : ""}` : t("no pass yet"),
      t("first {date}", { date: date(first.date) }),
    ];
    const shown = this.all ? plays : plays.slice(0, FEW);
    this.el.innerHTML = `
      <div class="plays-head">${head}<div class="meta-line num">${words.map((w) => `<span>${w}</span>`).join("")}</div></div>
      ${passes.length >= 3 ? accuracyGraph([...passes].reverse(), best) : ""}
      <div class="plays-list">${shown.map((p) => row(p, map.mode, p === best)).join("")}</div>
      ${plays.length > FEW ? `<button class="btn btn-ghost btn-sm plays-all" type="button">${this.all ? t("Show fewer") : t("Show all {n}", { n: num(plays.length) })}</button>` : ""}`;
  }

  destroy(): void {
    this.off();
    this.el.remove();
  }
}

function row(p: Play, mapMode: number, isBest: boolean): string {
  const g = rankInfo(p.rank);
  // a convert: say which ruleset it was played in
  const mods = [p.mode !== mapMode ? (MODE_SHORT[p.mode as 0] ?? p.ruleset ?? "") : "", modsText(p)].filter(Boolean).join(" · ");
  return `
    <div class="mplay${p.failed ? " failed" : ""}${isBest ? " best" : ""}">
      <span class="mplay-when" data-tip="${playWhenTip(p)}">${playWhen(p.date)}</span>
      <span class="grade" style="--c:${g.color}" data-tip="${playScoreTip(p)}">${p.failed ? "F" : g.label}</span>
      <span class="num mplay-acc">${pct(p.acc)}</span>
      <span class="mplay-mods">${esc(mods)}</span>
      <span class="num mplay-pp">${p.pp ? `${num(Math.round(p.pp))}pp` : ""}</span>
      <span class="num mplay-score">${num(p.score)}</span>
      ${p.id ? `<button class="icon-btn mplay-web" type="button" data-id="${p.id}" data-tip="${t("View score on osu! website")}" aria-label="${t("View score on osu! website")}">${icon("external")}</button>` : `<span></span>`}
    </div>`;
}

/** Accuracy of the passes, oldest to newest, evenly spaced; the best is marked. */
function accuracyGraph(passes: Play[], best: Play | undefined): string {
  const accs = passes.map((p) => p.acc);
  let lo = Math.min(...accs);
  let hi = Math.max(...accs);
  // at least half a percent of room, so a steady player doesn't get a jagged line
  if (hi - lo < 0.005) {
    const mid = (hi + lo) / 2;
    [lo, hi] = [mid - 0.0025, mid + 0.0025];
  }
  const x = (i: number) => (passes.length === 1 ? 50 : (i / (passes.length - 1)) * 100);
  const y = (a: number) => (1 - (a - lo) / (hi - lo)) * 100;
  const line = passes.map((p, i) => `${x(i).toFixed(2)},${y(p.acc).toFixed(2)}`).join(" ");
  const dots = passes
    .map((p, i) => `<i class="acc-dot${p === best ? " best" : ""}" style="left:${x(i).toFixed(2)}%;top:${y(p.acc).toFixed(2)}%" data-tip="${esc(`${pct(p.acc)} · ${date(p.date)}`)}"></i>`)
    .join("");
  return `
    <div class="acc-graph">
      <div class="acc-axis num"><span>${pct(hi)}</span><span>${pct(lo)}</span></div>
      <div class="acc-plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polyline points="${line}" /></svg>
        ${dots}
      </div>
    </div>`;
}
