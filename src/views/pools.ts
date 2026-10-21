/* pools.ts — the Pools page: every pool as a card, and a pool with its kinds of slot, each slot's
 * difficulty and its numbers at the slot's mods (star rating and the most pp, from
 * src-tauri/src/pp.rs; length and BPM at the rate). The bars on top are the pool's star ratings
 * slot by slot, so a kind that doesn't climb or a slot that sticks out shows at a glance.
 *
 * Slots take a difficulty from the picker (pool-picker.ts: the library, or osu! by search or
 * link), from a difficulty's menu ("Add to pool…"), or dragged in from the library; dragging one
 * slot onto another swaps them. One that isn't in the library shows what its chart says, with its
 * set to download.
 *
 * Out of Fumen: the RPRO bot's lines, a sheet (copied), CSV and JSON files (lib/pool-export.ts),
 * and a showcase picture (pool-showcase.ts), copied or saved. */
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, asApiError, osuCoverUrl, osuMapUrl, thumbUrl } from "../lib/api";
import { DRAG_TYPE } from "../lib/collections";
import { bpm, duration, esc, fixed, num, srChip } from "../lib/format";
import { mapIndexOf } from "../lib/history";
import { t, tn } from "../lib/i18n";
import {
  clearPoolSlot, deletePool, fitsPool, kindInfo, kindOfSlot, loadPools, modText, poolById, poolEvents, poolRuleset, pools, poolsLoaded,
  poolSlot, rateOf, rproText, setPoolSlot, setPoolSlotNote, slotChart, slotCodes, slotMapIdx, slotNumbers, swapPoolSlots, updatePool,
  type Pool, type PoolKind, type PoolSlot, type SlotChart,
} from "../lib/pools";
import { go } from "../lib/router";
import { events, store } from "../lib/store";
import { player } from "../player";
import { openMenu, toast, uiConfirm, uiPrompt, type MenuEntry } from "../ui/controls";
import { icon } from "../ui/icons";
import { openSet } from "./actions";
import { importSets, importTarget } from "./import";
import { drawShowcase, pngBytes } from "./pool-showcase";
import { exportRows, fileName, toCsv, toJson, toTsv } from "../lib/pool-export";
import { getVersion } from "@tauri-apps/api/app";
import { openPoolDialog } from "./pool-dialog";
import { chartStars, openSlotPicker, suits } from "./pool-picker";
import { ppText } from "./pp";

/** what a drag of a slot carries: its code */
const SLOT_DRAG = "application/x-fumen-slot";

/** The art of a slot's difficulty: the library's background, else osu!'s cover of the set. */
function artUrl(c: SlotChart, width: number): string | null {
  return c.bg ? thumbUrl(c.bg, width) : c.setId && c.online ? osuCoverUrl(c.setId) : null;
}

export class PoolsView {
  readonly el: HTMLElement;
  private offs: (() => void)[] = [];
  /** exact star ratings at the slots' mods, as they come in */
  private stars = new Map<string, number>();

  constructor(private id?: string) {
    this.el = document.createElement("section");
    this.el.className = "view pools-view";
    this.offs.push(
      poolEvents.on("pools", () => this.render()),
      events.on("library", () => this.render()),
    );
    this.bind();
    if (poolsLoaded()) this.render();
    else void loadPools();
  }

  private pool(): Pool | undefined {
    return this.id ? poolById(this.id) : undefined;
  }

  private render(): void {
    const p = this.pool();
    if (p) this.renderPool(p);
    else this.renderList();
  }

  // ── every pool ────────────────────────────────────────────────────────

  private renderList(): void {
    const list = pools();
    const head = `
      <header class="view-head">
        <div>
          <h1 class="view-title">${t("Pools")}</h1>
          <div class="view-sub">${t("Map pools for a tournament: slots by kind, the numbers at their mods, and out to the RPRO bot.")}</div>
        </div>
        <button class="btn btn-primary btn-sm" type="button" data-act="new">${icon("plus")}<span>${t("New pool")}</span></button>
      </header>`;
    if (!list.length) {
      this.el.innerHTML = `${head}
        <div class="empty-state">
          ${icon("flag")}
          <div class="empty-title">${t("No pools yet")}</div>
          <div class="empty-sub">${t("Make one, then fill its slots from your library.")}</div>
          <button class="btn btn-primary" type="button" data-act="new">${icon("plus")}<span>${t("New pool")}</span></button>
        </div>`;
      return;
    }
    const cards = list
      .map((p) => {
        const codes = slotCodes(p.categories);
        const charts = p.slots.map((s) => [s, slotChart(s)] as const);
        const covers = charts
          .map(([, c]) => (c ? artUrl(c, 320) : null))
          .filter((u): u is string => !!u)
          .slice(0, 3);
        const stars = charts
          .map(([s, c]) => {
            const k = kindOfSlot(p, s.slot);
            return c && k ? chartStars(c, k.mods) : null;
          })
          .filter((v): v is number => v !== null);
        const range = stars.length ? `${fixed(Math.min(...stars), 2)}–${fixed(Math.max(...stars), 2)}★` : "";
        const pips = codes
          .map((c) => {
            const k = kindOfSlot(p, c)!;
            return `<i class="${poolSlot(p, c) ? "on" : ""}" style="--k:${kindInfo(k.code).color}"></i>`;
          })
          .join("");
        return `<button class="pool-card" type="button" data-pool="${esc(p.id)}">
          <span class="pool-card-art">${covers.length ? covers.map((u) => `<img src="${u}" alt="" loading="lazy" decoding="async">`).join("") : icon("flag")}</span>
          <span class="pool-card-body">
            <span class="pool-card-name">${esc(p.name)}</span>
            <span class="pool-card-sub num">${[esc(poolRuleset(p)), t("{n} of {total}", { n: num(p.slots.length), total: num(codes.length) }), range].filter(Boolean).join(" · ")}</span>
            <span class="pool-pips">${pips}</span>
          </span>
        </button>`;
      })
      .join("");
    this.el.innerHTML = `${head}<div class="pool-cards">${cards}</div>`;
  }

  // ── one pool ──────────────────────────────────────────────────────────

  private renderPool(p: Pool): void {
    const snap = store.snap;
    if (!snap) return;
    const codes = slotCodes(p.categories);
    this.el.innerHTML = `
      <header class="view-head pool-head">
        <div class="pool-head-text">
          <button class="pool-back" type="button">${icon("chevron-left")}<span>${t("Pools")}</span></button>
          <h1 class="view-title">${esc(p.name)}</h1>
          <div class="view-sub pool-sub num"></div>
        </div>
        <div class="pool-head-tools">
          <button class="btn btn-sm" type="button" data-act="rpro" data-tip="${t("One line per slot, like the RPRO bot's Test match takes them")}">${icon("copy")}<span>${t("Copy for the RPRO bot")}</span></button>
          <button class="btn btn-sm" type="button" data-act="export">${icon("download")}<span>${t("Export")}</span></button>
          <button class="icon-btn" type="button" data-act="pool-menu" aria-label="${t("More")}" data-tip="${t("More")}">${icon("more-vert")}</button>
        </div>
      </header>
      <div class="pool-curve" role="list" aria-label="${t("Star rating by slot")}">
        ${codes.map((c) => `<button class="pc-bar${poolSlot(p, c) ? "" : " is-empty"}" type="button" role="listitem" data-slot="${esc(c)}" style="--k:${kindInfo(kindOfSlot(p, c)!.code).color}"><i></i><span>${esc(c)}</span></button>`).join("")}
      </div>
      <div class="pool-kinds">${p.categories.map((k) => this.kindHtml(p, k)).join("")}</div>`;
    this.refreshNumbers(p);
  }

  private kindHtml(p: Pool, k: PoolKind): string {
    const info = kindInfo(k.code);
    const codes = k.count === 1 ? [k.code] : Array.from({ length: k.count }, (_, i) => `${k.code}${i + 1}`);
    return `<section class="pool-kind" data-kind="${esc(k.code)}">
      <div class="pool-kind-head">
        <span class="slot-code" style="--k:${info.color}">${esc(k.code)}</span>
        <b>${esc(info.name)}</b>
        <span class="pool-kind-mods">${k.mods.length ? k.mods.map((m) => `<span class="mod-tag">${m}</span>`).join("") : esc(t("No mods"))}</span>
        <span class="pool-kind-range num"></span>
      </div>
      <div class="pool-slots">${codes.map((c) => this.slotHtml(p, k, c)).join("")}</div>
    </section>`;
  }

  private slotHtml(p: Pool, k: PoolKind, code: string): string {
    const info = kindInfo(k.code);
    const s = poolSlot(p, code);
    const chip = `<span class="slot-code" style="--k:${info.color}">${esc(code)}</span>`;
    if (!s) {
      return `<div class="pslot is-empty" data-slot="${esc(code)}">
        ${chip}
        <button class="pslot-add" type="button">${icon("plus")}<span>${t("Pick a map")}</span></button>
        <span class="pslot-hint">${t("or drag a difficulty here from the library")}</span>
      </div>`;
    }
    const note = s.note ? `<div class="pslot-note">${esc(s.note)}</div>` : "";
    const c = slotChart(s);
    if (!c) {
      // gone from the library, and nothing kept about it
      return `<div class="pslot is-missing" data-slot="${esc(code)}" draggable="true">
        ${chip}
        <span class="t-art img-missing"></span>
        <div class="pslot-text"><div class="t-title">${t("Not in your library any more")}</div><div class="t-sub num">${s.onlineId ? t("osu! beatmap {id}", { id: s.onlineId }) : esc(s.md5 ?? "")}</div></div>
        <span class="pslot-facts"></span><span class="pslot-sr"></span><span class="pslot-pp"></span><span></span>
        <button class="icon-btn sm pslot-more" type="button" aria-label="${t("More")}">${icon("more-vert")}</button>
      </div>${note}`;
    }
    const r = rateOf(k.mods);
    const facts = [duration(c.length / r), `${bpm(c.bpm * r)} BPM`];
    if (c.mode === 3) {
      facts.push(`LN ${Math.round((c.objects ? c.holds / c.objects : 0) * 100)}%`);
      if (c.category) facts.push(esc(c.category));
    }
    const fits = suits(k.code, c);
    const art = artUrl(c, 160);
    const away = c.mapIdx === undefined;
    const playing = !away && player.isCurrent(store.snap!.maps[c.mapIdx!].set) && player.playing;
    const action = away
      ? `<button class="icon-btn sm pslot-get" type="button" aria-label="${t("Download the set")}" data-tip="${t("Download the set")}">${icon("download")}</button>`
      : `<button class="icon-btn sm pslot-play" type="button" aria-label="${playing ? t("Pause") : t("Play")}">${icon(playing ? "pause" : "play")}</button>`;
    return `<div class="pslot${away ? " is-away" : ""}" data-slot="${esc(code)}"${away ? "" : ` data-map="${c.mapIdx}"`} draggable="true">
      ${chip}
      <span class="t-art${art ? "" : " img-missing"}">${art ? `<img src="${art}" alt="" loading="lazy" decoding="async">` : ""}</span>
      <div class="pslot-text">
        <div class="t-title">${esc(c.title)}${away ? ` <span class="pslot-away">${t("not in your library")}</span>` : ""}</div>
        <div class="t-sub">${esc(c.artist)} · ${esc(c.version)} · ${esc(c.creator)}</div>
      </div>
      <span class="pslot-facts num">${facts.join(" · ")}${fits === false ? ` <span class="pslot-warn" data-tip="${t("Doesn't look like {kind}", { kind: esc(kindInfo(k.code).name.toLowerCase()) })}">${icon("alert")}</span>` : ""}</span>
      <span class="pslot-sr">${srChip(this.stars.get(code) ?? chartStars(c, k.mods))}</span>
      <span class="pslot-pp num">${modText(k.mods) ? `<small>${modText(k.mods)}</small>` : ""}<b>–</b></span>
      ${action}
      <button class="icon-btn sm pslot-more" type="button" aria-label="${t("More")}">${icon("more-vert")}</button>
    </div>${note}`;
  }

  /** Asks for the exact numbers of every filled slot, and fills them in as they come. */
  private refreshNumbers(p: Pool): void {
    let length = 0;
    for (const s of p.slots) {
      const c = slotChart(s);
      const k = kindOfSlot(p, s.slot);
      if (!c || !k) continue;
      length += c.length / rateOf(k.mods);
      void slotNumbers(c.ppId, k.mods).then((n) => {
        if (!n || this.pool() !== p) return;
        this.stars.set(s.slot, n.stars);
        const row = this.el.querySelector<HTMLElement>(`.pslot[data-slot="${CSS.escape(s.slot)}"]`);
        if (row) {
          row.querySelector(".pslot-sr")!.innerHTML = srChip(n.stars);
          row.querySelector(".pslot-pp b")!.innerHTML = `${ppText(n.max)}<small>pp</small>`;
        }
        this.drawCurve(p);
      });
    }
    this.drawCurve(p, length);
  }

  /** The bars and the star ranges, from what's known so far. */
  private drawCurve(p: Pool, length?: number): void {
    const stars = new Map<string, number>();
    for (const s of p.slots) {
      const c = slotChart(s);
      const k = kindOfSlot(p, s.slot);
      if (c && k) stars.set(s.slot, this.stars.get(s.slot) ?? chartStars(c, k.mods));
    }
    const vals = [...stars.values()];
    const lo = vals.length ? Math.min(...vals) : 0;
    const hi = vals.length ? Math.max(...vals) : 1;
    const floor = Math.max(0, lo - Math.max(0.6, (hi - lo) * 0.35));
    for (const bar of this.el.querySelectorAll<HTMLElement>(".pc-bar")) {
      const v = stars.get(bar.dataset.slot!);
      bar.style.setProperty("--h", v === undefined ? "0" : String(Math.max(0.08, (v - floor) / Math.max(0.01, hi - floor))));
      bar.dataset.tip = v === undefined ? t("{slot}: empty", { slot: bar.dataset.slot! }) : `${bar.dataset.slot} · ${fixed(v, 2)}★`;
    }
    for (const sec of this.el.querySelectorAll<HTMLElement>(".pool-kind")) {
      const code = sec.dataset.kind!;
      const k = p.categories.find((x) => x.code === code)!;
      const own = (k.count === 1 ? [code] : Array.from({ length: k.count }, (_, i) => `${code}${i + 1}`)).map((c) => stars.get(c)).filter((v): v is number => v !== undefined);
      sec.querySelector(".pool-kind-range")!.textContent = own.length ? (own.length === 1 ? `${fixed(own[0], 2)}★` : `${fixed(Math.min(...own), 2)}–${fixed(Math.max(...own), 2)}★`) : "";
    }
    const sub = this.el.querySelector(".pool-sub");
    if (sub) {
      const total = slotCodes(p.categories).length;
      if (length !== undefined) sub.setAttribute("data-length", String(length));
      const len = +(sub.getAttribute("data-length") ?? 0);
      sub.textContent = [
        poolRuleset(p),
        t("{n} of {total} slots", { n: num(p.slots.length), total: num(total) }),
        vals.length ? `${fixed(lo, 2)}–${fixed(hi, 2)}★` : "",
        len ? t("{time} in all", { time: duration(len) }) : "",
      ]
        .filter(Boolean)
        .join(" · ");
    }
  }

  // ── doing things ──────────────────────────────────────────────────────

  private slotMenu(at: Element | { x: number; y: number }, p: Pool, code: string): void {
    const s = poolSlot(p, code);
    if (!s) return openSlotPicker(p.id, code);
    const c = slotChart(s);
    const entries: MenuEntry[] = [];
    if (c?.mapIdx !== undefined) {
      const mi = c.mapIdx;
      const m = store.snap!.maps[mi];
      entries.push(
        { label: t("Play"), icon: "play", action: () => player.playSet(m.set, mi) },
        { label: t("Open beatmap set"), icon: "library", action: () => openSet(m.set, mi) },
      );
    } else if (c?.online?.setId) {
      const o = c.online;
      entries.push(
        { label: t("Download the set"), icon: "download", action: () => void this.download(s) },
        { label: t("Open on osu!"), icon: "external", action: () => void openUrl(osuMapUrl(o.setId!, o.beatmapId, o.mode)) },
      );
    }
    entries.push(
      { label: t("Something like it…"), icon: "similar", action: () => openSlotPicker(p.id, code) },
      { label: t("Move to…"), icon: "arrow-right", action: () => void setTimeout(() => this.moveMenu(at, p, code), 0) },
      {
        label: s.note ? t("Change the note…") : t("Add a note…"),
        icon: "tag",
        action: () => void this.editNote(p, code, s.note),
      },
      "sep",
      { label: t("Take out of the pool"), icon: "x", danger: true, action: () => void clearPoolSlot(p.id, code) },
    );
    openMenu(at, entries, { minWidth: 220 });
  }

  private async editNote(p: Pool, code: string, now: string): Promise<void> {
    const note = await uiPrompt("", {
      title: t("Note for {slot}", { slot: code }),
      value: now,
      placeholder: t("Why this map, what to watch for…"),
      confirmLabel: t("Save"),
      maxLength: 2000,
    });
    if (note !== null) void setPoolSlotNote(p.id, code, note);
  }

  /** The other slots, to move a map to (swapping with what's there). */
  private moveMenu(at: Element | { x: number; y: number }, p: Pool, code: string): void {
    const entries: MenuEntry[] = [{ group: t("Move {slot} to", { slot: code }) }];
    for (const c of slotCodes(p.categories)) {
      if (c === code) continue;
      const s = poolSlot(p, c);
      const there = slotChart(s);
      entries.push({
        label: c,
        hint: s ? (there ? t("swap with {title}", { title: there.title }) : t("swap")) : t("empty"),
        action: () => void swapPoolSlots(p.id, code, c),
      });
    }
    openMenu(at, entries, { minWidth: 240, className: "slot-menu" });
  }

  private poolMenu(at: Element, p: Pool): void {
    openMenu(
      at,
      [
        {
          label: t("Rename…"),
          icon: "tag",
          action: () => void this.rename(p),
        },
        { label: t("Kinds of slot…"), icon: "sliders", action: () => void openPoolDialog(p) },
        { label: t("Copy for the RPRO bot"), icon: "copy", action: () => void this.copyRpro(p) },
        "sep",
        {
          label: t("Delete pool…"),
          icon: "trash",
          danger: true,
          action: () => void this.remove(p),
        },
      ],
      { minWidth: 220 },
    );
  }

  private async rename(p: Pool): Promise<void> {
    const name = await uiPrompt("", { title: t("Rename pool"), value: p.name, confirmLabel: t("Rename"), maxLength: 100 });
    if (name?.trim()) void updatePool(p.id, { name: name.trim() });
  }

  private async remove(p: Pool): Promise<void> {
    const ok = await uiConfirm(t("The maps stay in your library."), { title: t("Delete {pool}?", { pool: p.name }), confirmLabel: t("Delete"), danger: true });
    if (!ok) return;
    await deletePool(p.id);
    go({ name: "pools" }, { replace: true });
  }

  private exportMenu(at: Element, p: Pool): void {
    openMenu(
      at,
      [
        { label: t("Copy as a sheet"), icon: "copy", hint: "Sheets, Excel", action: () => void this.copySheet(p) },
        { label: t("Save as CSV…"), icon: "download", action: () => void this.saveText(p, "csv") },
        { label: t("Save as JSON…"), icon: "download", action: () => void this.saveText(p, "json") },
        "sep",
        { label: t("Copy showcase image"), icon: "copy", action: () => void this.showcase(p, "copy") },
        { label: t("Save showcase image…"), icon: "download", action: () => void this.showcase(p, "save") },
      ],
      { minWidth: 230 },
    );
  }

  /** the slots' numbers for an export (the ones on the page where pp.rs can't) */
  private rows(p: Pool) {
    return exportRows(p, (slot) => {
      const known = this.stars.get(slot);
      if (known !== undefined) return known;
      const c = slotChart(poolSlot(p, slot));
      const k = kindOfSlot(p, slot);
      return c && k ? chartStars(c, k.mods) : undefined;
    });
  }

  private async copySheet(p: Pool): Promise<void> {
    try {
      await navigator.clipboard.writeText(toTsv(await this.rows(p)));
      toast(t("Copied: paste it into a sheet"), { kind: "success", timeout: 2600 });
    } catch {
      toast(t("Couldn't access the clipboard"), { kind: "danger" });
    }
  }

  private async saveText(p: Pool, kind: "csv" | "json"): Promise<void> {
    try {
      const rows = await this.rows(p);
      const text = kind === "csv" ? toCsv(rows) : toJson(p, rows, `Fumen ${await getVersion().catch(() => "")}`.trim());
      const saved = await api.saveFile(kind, fileName(p.name, kind), new TextEncoder().encode(text), t("Export pool"), kind === "csv" ? t("CSV table") : "JSON");
      if (saved) toast(t("Saved as {file}", { file: saved }), { kind: "success", timeout: 2600 });
    } catch (e) {
      toast(`${t("Couldn't save the file.")} ${asApiError(e).message}`, { kind: "danger" });
    }
  }

  private async showcase(p: Pool, how: "copy" | "save"): Promise<void> {
    try {
      const canvas = await drawShowcase(p, await this.rows(p));
      const png = await pngBytes(canvas);
      if (how === "copy") {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([png as Uint8Array<ArrayBuffer>], { type: "image/png" }) })]);
        toast(t("Showcase image copied"), { kind: "success", timeout: 2600 });
        return;
      }
      const saved = await api.saveFile("png", fileName(p.name, "png"), png, t("Save showcase image"), t("PNG image"));
      if (saved) toast(t("Saved as {file}", { file: saved }), { kind: "success", timeout: 2600 });
    } catch (e) {
      toast(`${t("Couldn't make the image.")} ${asApiError(e).message}`, { kind: "danger" });
    }
  }

  /** Downloads a slot's set (not in the library) the way Browse does: into osu!lazer, or stable. */
  private async download(s: PoolSlot): Promise<void> {
    const o = s.online;
    if (!o?.setId) return;
    if (importTarget() !== "stable") {
      const st = await api.lazerImportStatus().catch(() => null);
      if (!st?.ready) {
        toast(st?.reason === "running" ? t("Close osu!lazer to add sets") : (st?.message ?? t("osu!lazer can't take sets right now")), { kind: "danger", timeout: 3500 });
        return;
      }
    }
    const how = importSets([{ id: o.setId, title: `${o.artist} - ${o.title}` }]);
    if (how === "queued") toast(t("Added after the import that's running"), { timeout: 2600 });
    else if (how === "started") toast(t("Downloading {title}…", { title: o.title }), { timeout: 2600 });
  }

  private async copyRpro(p: Pool): Promise<void> {
    const { text, left } = rproText(p);
    if (!text) {
      toast(t("Nothing to copy: no slot has a map from osu! yet."), { kind: "danger" });
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      const n = text.split("\n").length;
      toast(left.length ? t("{maps} copied; {slots} left out (not on osu!).", { maps: tn(n, "{n} map", "{n} maps"), slots: left.join(", ") }) : tn(n, "{n} map copied for the RPRO bot", "{n} maps copied for the RPRO bot"), {
        kind: left.length ? "info" : "success",
        timeout: 3500,
      });
    } catch {
      toast(t("Couldn't access the clipboard"), { kind: "danger" });
    }
  }

  private bind(): void {
    this.el.addEventListener("click", (e) => {
      const el = e.target as Element;
      if (el.closest('[data-act="new"]')) {
        void openPoolDialog().then((id) => id && go({ name: "pools", id }));
        return;
      }
      const card = el.closest<HTMLElement>(".pool-card");
      if (card) return go({ name: "pools", id: card.dataset.pool! });
      if (el.closest(".pool-back")) return go({ name: "pools" });
      const p = this.pool();
      if (!p) return;
      if (el.closest('[data-act="rpro"]')) return void this.copyRpro(p);
      const exportBtn = el.closest<HTMLElement>('[data-act="export"]');
      if (exportBtn) return this.exportMenu(exportBtn, p);
      const menuBtn = el.closest<HTMLElement>('[data-act="pool-menu"]');
      if (menuBtn) return this.poolMenu(menuBtn, p);
      const bar = el.closest<HTMLElement>(".pc-bar");
      if (bar) {
        const row = this.el.querySelector<HTMLElement>(`.pslot[data-slot="${CSS.escape(bar.dataset.slot!)}"]`);
        row?.scrollIntoView({ block: "center", behavior: "smooth" });
        row?.classList.remove("flash");
        void row?.offsetWidth;
        row?.classList.add("flash");
        return;
      }
      const row = el.closest<HTMLElement>(".pslot");
      if (!row) return;
      const code = row.dataset.slot!;
      if (row.classList.contains("is-empty")) return openSlotPicker(p.id, code);
      const more = el.closest<HTMLElement>(".pslot-more");
      if (more) return this.slotMenu(more, p, code);
      if (el.closest(".pslot-get")) {
        const s = poolSlot(p, code);
        if (s) void this.download(s);
        return;
      }
      if (row.classList.contains("is-away")) {
        const o = poolSlot(p, code)?.online;
        if (o?.setId) void openUrl(osuMapUrl(o.setId, o.beatmapId, o.mode));
        return;
      }
      const mi = row.dataset.map !== undefined ? +row.dataset.map : undefined;
      if (mi === undefined) return;
      const m = store.snap!.maps[mi];
      if (el.closest(".pslot-play")) {
        // the pool's sets are the queue
        const queue = p.slots.map((s) => slotMapIdx(s)).filter((i): i is number => i !== undefined).map((i) => store.snap!.maps[i].set);
        player.playSet(m.set, mi, queue);
        return;
      }
      openSet(m.set, mi);
    });
    this.el.addEventListener("contextmenu", (e) => {
      const row = (e.target as Element).closest<HTMLElement>(".pslot:not(.is-empty)");
      const p = this.pool();
      if (!row || !p) return;
      e.preventDefault();
      this.slotMenu({ x: e.clientX, y: e.clientY }, p, row.dataset.slot!);
    });

    // dragging: a slot onto another swaps them; a difficulty from the library fills one
    this.el.addEventListener("dragstart", (e) => {
      const row = (e.target as Element).closest<HTMLElement>(".pslot[draggable]");
      if (!row || !e.dataTransfer) return;
      e.dataTransfer.setData(SLOT_DRAG, row.dataset.slot!);
      e.dataTransfer.effectAllowed = "move";
      row.classList.add("dragging");
    });
    this.el.addEventListener("dragend", () => this.el.querySelectorAll(".dragging, .drop-on").forEach((x) => x.classList.remove("dragging", "drop-on")));
    this.el.addEventListener("dragover", (e) => {
      const row = (e.target as Element).closest<HTMLElement>(".pslot");
      const types = e.dataTransfer?.types ?? [];
      if (!row || !(types.includes(SLOT_DRAG) || types.includes(DRAG_TYPE))) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = types.includes(SLOT_DRAG) ? "move" : "copy";
      if (!row.classList.contains("drop-on")) {
        this.el.querySelectorAll(".drop-on").forEach((x) => x.classList.remove("drop-on"));
        row.classList.add("drop-on");
      }
    });
    this.el.addEventListener("dragleave", (e) => {
      const row = (e.target as Element).closest<HTMLElement>(".pslot");
      if (row && !row.contains(e.relatedTarget as Node)) row.classList.remove("drop-on");
    });
    this.el.addEventListener("drop", (e) => {
      const row = (e.target as Element).closest<HTMLElement>(".pslot");
      const p = this.pool();
      if (!row || !p || !e.dataTransfer) return;
      e.preventDefault();
      row.classList.remove("drop-on");
      const code = row.dataset.slot!;
      const from = e.dataTransfer.getData(SLOT_DRAG);
      if (from) {
        if (from !== code) void swapPoolSlots(p.id, from, code);
        return;
      }
      let ids: string[] = [];
      try {
        ids = JSON.parse(e.dataTransfer.getData(DRAG_TYPE) || "[]");
      } catch {
        // not ours
      }
      const mi = ids.map((id) => mapIndexOf(id)).find((i): i is number => i !== undefined && fitsPool(p, i));
      if (mi !== undefined) void setPoolSlot(p.id, code, mi);
      else if (ids.length) toast(t("That difficulty doesn't fit this pool ({ruleset}).", { ruleset: poolRuleset(p) }), { kind: "danger" });
    });
    this.offs.push(
      player.bus.on("state", () => this.syncPlaying()),
      player.bus.on("track", () => this.syncPlaying()),
    );
  }

  private syncPlaying(): void {
    for (const row of this.el.querySelectorAll<HTMLElement>(".pslot[data-map]")) {
      const m = store.snap?.maps[+row.dataset.map!];
      const btn = row.querySelector(".pslot-play");
      if (!m || !btn) continue;
      const playing = player.isCurrent(m.set) && player.playing;
      btn.innerHTML = icon(playing ? "pause" : "play");
      btn.setAttribute("aria-label", playing ? t("Pause") : t("Play"));
    }
  }

  destroy(): void {
    this.offs.forEach((f) => f());
    this.el.remove();
  }
}
