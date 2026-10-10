/* set.ts — a beatmap set: artwork hero, difficulties (each opens its chart), details. */
import { openUrl } from "@tauri-apps/plugin-opener";
import { osuSetUrl, thumbUrl } from "../lib/api";
import {
  bpm, date, displayArtist, displayTitle, duration, esc, holdRatio, keysOrMode, mapPatternText, modeLabel, nps, num,
  rankInfo, relativeTime, srChip, statusLabel,
} from "../lib/format";
import { shortDan } from "../lib/dan";
import { back, canGoBack, goSection } from "../lib/router";
import { events, store } from "../lib/store";
import type { MapRow, SetRow } from "../lib/types";
import { claimContentArt, player } from "../player";
import { icon } from "../ui/icons";
import { setMenu } from "./actions";
import { ChartPanel } from "./chart";

export class SetView {
  readonly el: HTMLElement;
  private offs: (() => void)[] = [];
  private setIdx = -1;
  /** difficulty whose chart is open (by id: indices change when the library reloads) */
  private openId: string | null = null;
  private panel: ChartPanel | null = null;

  constructor(private id: string, private focusMap?: string) {
    this.el = document.createElement("section");
    this.el.className = "view set-view";
    this.render();
    this.bind();
    this.offs.push(
      events.on("library", () => this.render()),
      events.on("prefs", (p) => {
        if ("unicode" in p) this.render();
      }),
      player.bus.on("track", () => this.syncPlay()),
      player.bus.on("state", () => this.syncPlay()),
    );
  }

  private render(): void {
    const snap = store.snap;
    const si = snap?.sets.findIndex((s) => s.id === this.id) ?? -1;
    this.setIdx = si;
    this.closeChart(false);
    if (!snap || si < 0) {
      this.el.innerHTML = `<div class="empty-state set-missing">${icon("collection-duo")}<div class="empty-title">This set is no longer in your library</div><button class="btn btn-sm set-back-lib" type="button">Back to library</button></div>`;
      claimContentArt(null);
      return;
    }
    const set = snap.sets[si];
    const maps = set.maps.map((mi) => snap.maps[mi]);
    const unicode = store.prefs.unicode;
    const title = displayTitle(set, unicode);
    const artist = displayArtist(set, unicode);
    const altTitle = unicode ? set.title : set.titleUnicode;
    const modes = [...new Set(maps.map((m) => m.mode))].sort();
    const bpms = maps.map((m) => m.bpm);
    const lo = Math.min(...bpms);
    const hi = Math.max(...bpms);
    const length = Math.max(...maps.map((m) => m.length));
    const plays = maps.reduce((n, m) => n + (m.best?.plays ?? 0), 0);
    const lastPlayed = maps.reduce((t, m) => Math.max(t, m.played ?? 0, m.best?.last ?? 0), 0);

    const meta: string[] = [
      `<span>mapped by <b>${esc(set.creator || "unknown")}</b></span>`,
      `<span class="num">${lo === hi ? bpm(lo) : `${bpm(lo)}–${bpm(hi)}`} BPM</span>`,
      `<span class="num">${duration(length)}</span>`,
    ];
    if (set.ranked && [1, 2, 4].includes(set.status)) meta.push(`<span>${statusLabel(set.status)} ${date(set.ranked)}</span>`);
    if (set.added) meta.push(`<span>added ${relativeTime(set.added)}</span>`);

    this.el.innerHTML = `
      <div class="set-hero">
        <div class="set-hero-art${set.bg ? "" : " img-missing"}">${set.bg ? `<img src="${thumbUrl(set.bg, 1280)}" alt="" decoding="async" />` : ""}</div>
        <div class="set-hero-scrim"></div>
        <button class="icon-btn set-back on-image" type="button" data-tip="Back" aria-label="Back">${icon("arrow-left")}</button>
        <div class="set-hero-text">
          <div class="label-caps set-kicker">${esc(statusLabel(set.status))} · ${modes.map((m) => esc(modeLabel(m))).join(", ")}</div>
          <h1 class="set-title">${esc(title)}</h1>
          ${altTitle && altTitle !== title ? `<div class="set-alt">${esc(altTitle)}</div>` : ""}
          <div class="set-artist">${esc(artist)}</div>
          <div class="meta-line set-meta">${meta.join("")}</div>
          <div class="set-actions">
            <button class="btn btn-primary btn-lg set-play" type="button">${icon("play", "ic-play")}${icon("pause", "ic-pause")}<span>Play</span></button>
            ${set.onlineId ? `<button class="btn btn-lg set-web" type="button">${icon("external")}<span>osu! website</span></button>` : ""}
            <button class="icon-btn set-more" type="button" data-tip="More" aria-label="More actions">${icon("more")}</button>
          </div>
        </div>
      </div>
      <div class="set-body">
        <section class="section">
          <h2 class="section-title">Difficulties <span class="section-count num">${maps.length}</span></h2>
          ${this.diffGroups(set, maps)}
        </section>
        <section class="section set-details">
          ${this.details(set, plays, lastPlayed)}
        </section>
      </div>`;

    claimContentArt(set.bg ? thumbUrl(set.bg, 640) : null);
    this.syncPlay();

    const open = this.initialChart(set);
    if (open !== undefined) this.openChart(open, false);
    if (this.focusMap) {
      const row = this.el.querySelector<HTMLElement>(`.diff[data-id="${CSS.escape(this.focusMap)}"]`);
      if (row) requestAnimationFrame(() => row.scrollIntoView({ block: "start", behavior: "smooth" }));
      this.focusMap = undefined;
    }
  }

  /** Which chart to show first: the one asked for, the one playing, or the hardest in your mode. */
  private initialChart(set: SetRow): number | undefined {
    const snap = store.snap!;
    const byId = (id: string | null | undefined) => set.maps.find((mi) => snap.maps[mi].id === id);
    const asked = byId(this.focusMap) ?? byId(this.openId);
    if (asked !== undefined) return asked;
    if (player.isCurrent(this.setIdx) && player.now) return player.now.map;
    const mode = store.prefs.mode;
    const pool = set.maps.filter((mi) => mode < 0 || snap.maps[mi].mode === mode);
    const list = pool.length ? pool : set.maps;
    return list.reduce((best, mi) => (snap.maps[mi].sr > snap.maps[best].sr ? mi : best), list[0]);
  }

  private openChart(mi: number | null, animate = true): void {
    const snap = store.snap!;
    const id = mi === null ? null : snap.maps[mi].id;
    if (id !== null && id === this.openId && this.panel) return;
    this.closeChart(animate);
    this.openId = id;
    this.el.querySelectorAll<HTMLElement>(".diff").forEach((d) => {
      const on = +d.dataset.map! === mi;
      d.classList.toggle("open", on);
      d.setAttribute("aria-expanded", String(on));
    });
    if (mi === null) return;
    const row = this.el.querySelector<HTMLElement>(`.diff[data-map="${mi}"]`);
    if (!row) return;
    const wrap = document.createElement("div");
    wrap.className = "diff-panel";
    const inner = document.createElement("div");
    inner.className = "diff-panel-inner";
    wrap.appendChild(inner);
    this.panel = new ChartPanel(this.setIdx, mi);
    inner.appendChild(this.panel.el);
    row.after(wrap);
    if (animate) requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add("open")));
    else wrap.classList.add("open");
  }

  private closeChart(animate: boolean): void {
    const panel = this.panel;
    this.panel = null;
    if (!panel) return;
    const wrap = panel.el.closest<HTMLElement>(".diff-panel");
    wrap?.previousElementSibling?.classList.remove("open");
    const done = () => {
      panel.destroy();
      wrap?.remove();
    };
    if (!animate || !wrap) return done();
    wrap.classList.remove("open");
    wrap.addEventListener("transitionend", done, { once: true });
    setTimeout(done, 450);
  }

  private diffGroups(set: SetRow, maps: MapRow[]): string {
    const byMode = new Map<number, number[]>();
    set.maps.forEach((mi, i) => {
      const m = maps[i];
      if (!byMode.has(m.mode)) byMode.set(m.mode, []);
      byMode.get(m.mode)!.push(mi);
    });
    const multi = byMode.size > 1;
    return [...byMode.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(
        ([mode, mis]) => `
        ${multi ? `<div class="label-caps diff-group-label">${esc(modeLabel(mode))}</div>` : ""}
        <div class="diff-list">${mis.map((mi) => this.diffRow(mi)).join("")}</div>`,
      )
      .join("");
  }

  private diffRow(mi: number): string {
    const m = store.snap!.maps[mi];
    const best = m.best ? rankInfo(m.best.rank) : null;
    const facts = [
      m.mode === 3 ? `${Math.round(m.cs)} keys` : keysOrMode(m),
      `OD ${fmt1(m.od)}`,
      `HP ${fmt1(m.hp)}`,
      ...(m.mode === 0 || m.mode === 2 ? [`CS ${fmt1(m.cs)}`, `AR ${fmt1(m.ar)}`] : []),
    ];
    const holdLabel = m.mode === 3 ? "long notes" : "sliders";
    const patterns = mapPatternText(m);
    const dan = m.dan
      ? `<span class="diff-dan" data-tip="${esc(m.dan.includes("||") ? `Estimated dan: ${m.dan.replace(" || ", ", ")}` : "Estimated dan")}">${esc(shortDan(m.dan, holdRatio(m)))}</span>`
      : "";
    return `
      <div class="diff${m.hidden ? " is-hidden" : ""}" data-map="${mi}" data-id="${esc(m.id)}" role="button" tabindex="0" aria-expanded="false">
        ${srChip(m.sr, "lg", icon("star-fill"))}
        <div class="diff-main">
          <div class="diff-name">${esc(m.version)}${m.hidden ? `<span class="diff-flag">hidden in osu!</span>` : ""}</div>
          <div class="diff-facts">${facts.map((f) => `<span>${esc(f)}</span>`).join("")}${dan}${patterns ? `<span class="diff-pat">${esc(patterns)}</span>` : ""}</div>
        </div>
        <div class="diff-stats num">
          <div><b>${num(m.objects)}</b><span>notes</span></div>
          <div><b>${Math.round(holdRatio(m) * 100)}%</b><span>${holdLabel}</span></div>
          <div><b>${nps(m).toFixed(1)}</b><span>notes/s</span></div>
          <div><b>${duration(m.length)}</b><span>length</span></div>
        </div>
        <div class="diff-best">
          ${best
            ? `<span class="grade lg" style="--c:${best.color}">${best.label}</span><div><b class="num">${(m.best!.acc * 100).toFixed(2)}%</b><span>${m.best!.plays} ${m.best!.plays === 1 ? "play" : "plays"}</span></div>`
            : `<span class="diff-unplayed">${m.played ? `played ${relativeTime(m.played)}` : "not played"}</span>`}
        </div>
        ${icon("chevron-down", "diff-chev")}
      </div>`;
  }

  private details(set: SetRow, plays: number, lastPlayed: number): string {
    const rows: [string, string][] = [];
    if (set.source) rows.push(["Source", esc(set.source)]);
    if (set.onlineId) rows.push(["Set ID", `<span class="num">${set.onlineId}</span>`]);
    if (set.ranked) rows.push([[1, 2].includes(set.status) ? "Ranked" : statusLabel(set.status), date(set.ranked)]);
    if (set.added) rows.push(["Added", date(set.added)]);
    rows.push(["Your plays", plays ? `${num(plays)}${lastPlayed ? ` · last ${relativeTime(lastPlayed)}` : ""}` : lastPlayed ? `last ${relativeTime(lastPlayed)}` : "none yet"]);
    const tags = (set.tags ?? "").split(/\s+/).filter(Boolean);
    return `
      <div class="details-grid">
        <div class="panel details-facts">
          ${rows.map(([k, v]) => `<div class="fact"><span class="fact-k">${k}</span><span class="fact-v">${v}</span></div>`).join("")}
        </div>
        ${tags.length ? `<div class="panel details-tags"><div class="label-caps">Tags</div><div class="tag-words">${tags.map((t) => `<button type="button" class="tag-word" data-tag="${esc(t)}">${esc(t)}</button>`).join("")}</div></div>` : ""}
      </div>`;
  }

  private syncPlay(): void {
    const playing = player.isCurrent(this.setIdx) && player.playing;
    const btn = this.el.querySelector<HTMLElement>(".set-play");
    if (!btn) return;
    btn.classList.toggle("is-playing", playing);
    btn.querySelector("span")!.textContent = playing ? "Pause" : player.isCurrent(this.setIdx) ? "Resume" : "Play";
    this.el.querySelectorAll<HTMLElement>(".diff").forEach((d) => d.classList.toggle("playing", player.isCurrent(this.setIdx) && player.now?.map === +d.dataset.map!));
  }

  private bind(): void {
    this.el.addEventListener("click", (e) => {
      const t = e.target as Element;
      if (t.closest(".set-back")) return canGoBack() ? back() : goSection({ name: "library" });
      if (t.closest(".set-back-lib")) return goSection({ name: "library" });
      if (t.closest(".set-play")) {
        const open = this.openId ? store.snap?.sets[this.setIdx].maps.find((mi) => store.snap!.maps[mi].id === this.openId) : undefined;
        return player.playSet(this.setIdx, open);
      }
      if (t.closest(".set-web")) {
        const set = store.snap?.sets[this.setIdx];
        if (set?.onlineId) void openUrl(osuSetUrl(set.onlineId));
        return;
      }
      if (t.closest(".set-more")) return setMenu(t.closest(".set-more")!, this.setIdx, undefined, { inSetPage: true, onSearch: search });
      const tag = t.closest<HTMLElement>(".tag-word");
      if (tag) return search(`tag=${tag.dataset.tag!.includes(" ") ? `"${tag.dataset.tag}"` : tag.dataset.tag}`);
      if (t.closest(".diff-panel")) return;
      const diff = t.closest<HTMLElement>(".diff");
      if (diff) this.openChart(diff.classList.contains("open") ? null : +diff.dataset.map!);
    });
    this.el.addEventListener("contextmenu", (e) => {
      const diff = (e.target as Element).closest<HTMLElement>(".diff");
      if (!diff) return;
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY }, this.setIdx, +diff.dataset.map!, { inSetPage: true, onSearch: search });
    });
    this.el.addEventListener("keydown", (e) => {
      const diff = (e.target as Element).closest<HTMLElement>(".diff");
      if (diff && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        this.openChart(diff.classList.contains("open") ? null : +diff.dataset.map!);
        return;
      }
      if (e.key === "Escape" && !e.defaultPrevented) back();
    });
  }

  destroy(): void {
    this.closeChart(false);
    this.offs.forEach((f) => f());
    claimContentArt(undefined);
    this.el.remove();
  }
}

function search(q: string): void {
  events.emit("search", q);
}

const fmt1 = (v: number): string => (Math.round(v * 10) / 10).toString();
