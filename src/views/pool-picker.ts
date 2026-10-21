/* pool-picker.ts — choosing what goes where in a pool: a library difficulty for a slot (searched
 * the library's way, the ones that suit the slot first), or a slot for a difficulty (from its
 * menu, "Add to pool…").
 *
 * What suits a slot: in osu!mania the kind's character (rice with few long notes, LN with many,
 * hybrid in between, SV with scroll speed changes) and a star rating near the slot's place in its
 * kind (RC1 below RC2 below RC3, from the ones filled), else near the pool's. Star ratings here are
 * the library's (osu!mania at Half Time and Double Time: Fumen's); the pool page shows the exact
 * ones at the slot's mods. */
import { thumbUrl } from "../lib/api";
import { bpm, displayTitle, duration, esc, num, srChip } from "../lib/format";
import { t, tn } from "../lib/i18n";
import {
  fitsPool, kindInfo, kindOfSlot, poolById, poolRuleset, pools, poolSlot, rateOf, setPoolSlot, slotCodes, slotMapIdx, type Pool,
} from "../lib/pools";
import { DEFAULT_FILTER, filterLibrary } from "../lib/search";
import { store } from "../lib/store";
import type { MapRow } from "../lib/types";
import { closeAnimated, openMenu, type MenuEntry } from "../ui/controls";
import { icon } from "../ui/icons";
import { openPoolDialog } from "./pool-dialog";

/** rows the picker shows at most */
const SHOWN = 60;

/** A difficulty's star rating at some mods, as far as the library knows it. */
export function knownStars(m: MapRow, mods: readonly string[]): number {
  const r = rateOf(mods);
  if (m.mode === 3) return (r > 1 ? m.srDt : r < 1 ? m.srHt : undefined) ?? m.sr;
  return m.sr;
}

/** the osu!mania kinds with a character to check */
const RULED = ["RC", "LN", "HB", "SV"];

const lnShare = (m: MapRow): number => (m.objects ? m.holds / m.objects : 0);

/** Whether a difficulty has the character of an osu!mania kind (null: the kind has none to check). */
export function suits(code: string, m: MapRow): boolean | null {
  if (m.mode !== 3) return null;
  const ln = lnShare(m);
  switch (code) {
    case "RC":
      return ln < 0.12;
    case "LN":
      return ln >= 0.4;
    case "HB":
      return ln >= 0.12 && ln < 0.6;
    case "SV":
      return /\bSV\b/.test(m.category ?? "");
    default:
      return null;
  }
}

/** The star rating a slot aims at: from the others of its kind (in order), else the pool's. */
export function slotTarget(pool: Pool, slot: string): number | null {
  const snap = store.snap;
  const kind = kindOfSlot(pool, slot);
  if (!snap || !kind) return null;
  const stars = (code: string): number | null => {
    const i = slotMapIdx(poolSlot(pool, code));
    const k = kindOfSlot(pool, code);
    return i !== undefined && k ? knownStars(snap.maps[i], k.mods) : null;
  };
  const codes = kind.count === 1 ? [kind.code] : Array.from({ length: kind.count }, (_, i) => `${kind.code}${i + 1}`);
  const at = codes.indexOf(slot);
  const filled = codes.map((c, i) => [i, stars(c)] as const).filter((x): x is readonly [number, number] => x[1] !== null && x[0] !== at);
  if (filled.length >= 2) {
    // a straight line through the kind's filled slots
    const n = filled.length;
    const mx = filled.reduce((s, [i]) => s + i, 0) / n;
    const my = filled.reduce((s, [, v]) => s + v, 0) / n;
    const sxx = filled.reduce((s, [i]) => s + (i - mx) ** 2, 0);
    const slope = sxx ? filled.reduce((s, [i, v]) => s + (i - mx) * (v - my), 0) / sxx : 0;
    return my + slope * (at - mx);
  }
  if (filled.length === 1) return filled[0][1] + (at - filled[0][0]) * 0.15;
  const all = slotCodes(pool.categories).map(stars).filter((v): v is number => v !== null);
  return all.length ? all.reduce((s, v) => s + v, 0) / all.length : null;
}

/** Picks a library difficulty for a slot. */
export function openSlotPicker(poolId: string, slot: string): void {
  const pool = poolById(poolId);
  const kind = pool && kindOfSlot(pool, slot);
  const snap = store.snap;
  const ix = store.index;
  if (!pool || !kind || !snap || !ix) return;
  const info = kindInfo(kind.code);
  const target = slotTarget(pool, slot);
  const hasRule = pool.mode === 3 && RULED.includes(kind.code);
  let onlySuiting = hasRule;
  let text = "";
  /** where each difficulty already is in the pool */
  const inPool = new Map<number, string>();
  for (const s of pool.slots) {
    const i = slotMapIdx(s);
    if (i !== undefined) inPool.set(i, s.slot);
  }

  const bd = document.createElement("div");
  bd.className = "modal-backdrop dialog-backdrop";
  bd.innerHTML = `
    <div class="modal-panel dialog pick-dialog" role="dialog" aria-modal="true" aria-labelledby="pick-title">
      <div class="pick-head">
        <span class="slot-code" style="--k:${info.color}">${esc(slot)}</span>
        <div>
          <div class="dialog-title" id="pick-title">${t("A map for {slot}", { slot: esc(slot) })}</div>
          <div class="pick-sub num">${esc(poolRuleset(pool))} · ${esc(info.name)}${kind.mods.length ? ` · ${esc(kind.mods.join(""))}` : ""}${target !== null ? ` · ${t("around {sr}★", { sr: target.toFixed(2) })}` : ""}</div>
        </div>
      </div>
      <div class="pick-tools">
        <label class="search pick-search">
          ${icon("search", "search-ic")}
          <input type="text" spellcheck="false" autocomplete="off" placeholder="${t("Search, like in the library: sr>5 ln>30 …")}" aria-label="${t("Search the library")}">
        </label>
        ${hasRule ? `<button class="chip-toggle pick-suits active" type="button" aria-pressed="true">${t("Only {kind}", { kind: esc(info.name.toLowerCase()) })}</button>` : ""}
      </div>
      <div class="pick-list" role="listbox" aria-label="${t("Difficulties")}"></div>
      <div class="pick-foot"><span class="pick-count num"></span><button class="btn btn-ghost" type="button" data-act="cancel">${t("Cancel")}</button></div>
    </div>`;
  const list = bd.querySelector<HTMLElement>(".pick-list")!;

  const render = () => {
    const found = filterLibrary(ix, { ...DEFAULT_FILTER, text, mode: pool.mode, keys: pool.mode === 3 && pool.keys ? [pool.keys] : [] });
    let rows: { i: number; m: MapRow; sr: number; fits: boolean | null }[] = [];
    for (const r of found.sets)
      for (const i of r.maps) {
        if (!fitsPool(pool, i)) continue;
        const m = snap.maps[i];
        const fits = suits(kind.code, m);
        if (onlySuiting && fits === false) continue;
        rows.push({ i, m, sr: knownStars(m, kind.mods), fits });
      }
    rows.sort((a, b) => (target !== null ? Math.abs(a.sr - target) - Math.abs(b.sr - target) : (b.m.played ?? 0) - (a.m.played ?? 0) || b.sr - a.sr));
    const total = rows.length;
    rows = rows.slice(0, SHOWN);
    bd.querySelector(".pick-count")!.textContent = total > SHOWN ? t("The {n} closest of {total}", { n: SHOWN, total: num(total) }) : tn(total, "{n} difficulty", "{n} difficulties");
    if (!rows.length) {
      list.innerHTML = `<div class="pick-empty">${text ? t("Nothing in your library matches.") : t("Nothing in your library fits this pool.")}</div>`;
      return;
    }
    list.innerHTML = rows
      .map(({ i, m, sr }) => {
        const set = snap.sets[m.set];
        const bg = m.bg ?? set.bg;
        const facts =
          m.mode === 3
            ? [`LN ${Math.round(lnShare(m) * 100)}%`, m.category ? esc(m.category) : ""]
            : [`${bpm(m.bpm * rateOf(kind.mods))} BPM`, duration(m.length / rateOf(kind.mods))];
        const where = inPool.get(i);
        return `<div class="pick-row" role="option" tabindex="0" data-map="${i}">
          <span class="t-art${bg ? "" : " img-missing"}">${bg ? `<img src="${thumbUrl(bg, 160)}" alt="" loading="lazy" decoding="async">` : ""}</span>
          <div class="pick-text">
            <div class="t-title">${esc(displayTitle(set, store.prefs.unicode))}</div>
            <div class="t-sub">${esc(m.version)} · ${esc(set.creator)}</div>
          </div>
          <span class="pick-facts num">${facts.filter(Boolean).join(" · ")}${where ? ` · <b>${t("in {slot}", { slot: esc(where) })}</b>` : ""}</span>
          <span class="pick-sr" data-tip="${pool.mode === 3 || !kind.mods.length ? "" : t("Without mods; the pool shows it with them")}">${srChip(sr)}</span>
        </div>`;
      })
      .join("");
  };

  const finish = () => {
    document.removeEventListener("keydown", onKey, true);
    closeAnimated(bd);
  };
  const pick = (i: number) => {
    finish();
    void setPoolSlot(pool.id, slot, i);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish();
    } else if (e.key === "Enter") {
      const row = (e.target as Element).closest?.<HTMLElement>(".pick-row") ?? list.querySelector<HTMLElement>(".pick-row");
      if (row) {
        e.preventDefault();
        e.stopPropagation();
        pick(+row.dataset.map!);
      }
    }
  };
  document.addEventListener("keydown", onKey, true);
  bd.addEventListener("pointerdown", (e) => {
    if (e.target === bd) finish();
  });
  let typing = 0;
  bd.querySelector(".pick-search input")!.addEventListener("input", (e) => {
    text = (e.target as HTMLInputElement).value;
    clearTimeout(typing);
    typing = window.setTimeout(render, 120);
  });
  bd.addEventListener("click", (e) => {
    const el = e.target as Element;
    const row = el.closest<HTMLElement>(".pick-row");
    if (row) return pick(+row.dataset.map!);
    const suitsBtn = el.closest<HTMLElement>(".pick-suits");
    if (suitsBtn) {
      onlySuiting = !onlySuiting;
      suitsBtn.classList.toggle("active", onlySuiting);
      suitsBtn.setAttribute("aria-pressed", String(onlySuiting));
      return render();
    }
    if (el.closest('[data-act="cancel"]')) finish();
  });

  document.body.appendChild(bd);
  render();
  setTimeout(() => bd.querySelector<HTMLInputElement>(".pick-search input")?.focus(), 30);
}

/** "Add to pool…": the pools a difficulty fits, then a slot in the one picked. */
export function poolPicker(at: Element | { x: number; y: number }, mapIdx: number): void {
  const fit = pools().filter((p) => fitsPool(p, mapIdx));
  const entries: MenuEntry[] = [];
  if (fit.length) entries.push({ group: t("Add to pool") });
  for (const p of fit) {
    const filled = p.slots.find((s) => slotMapIdx(s) === mapIdx);
    entries.push({
      label: p.name,
      icon: "flag",
      hint: filled ? filled.slot : `${num(p.slots.length)}/${num(slotCodes(p.categories).length)}`,
      checked: !!filled,
      action: () => void setTimeout(() => slotMenu(at, p.id, mapIdx), 0),
    });
  }
  if (fit.length) entries.push("sep");
  entries.push({
    label: t("New pool…"),
    icon: "plus",
    action: () =>
      void openPoolDialog().then((id) => {
        if (id) setTimeout(() => slotMenu(at, id, mapIdx), 0);
      }),
  });
  setTimeout(() => openMenu(at, entries, { minWidth: 220 }), 0);
}

/** The slots of a pool, to put a difficulty in: empty ones say so, filled ones what's there. */
function slotMenu(at: Element | { x: number; y: number }, poolId: string, mapIdx: number): void {
  const p = poolById(poolId);
  const snap = store.snap;
  if (!p || !snap) return;
  const entries: MenuEntry[] = [{ group: p.name }];
  for (const code of slotCodes(p.categories)) {
    const s = poolSlot(p, code);
    const i = slotMapIdx(s);
    const here = i === mapIdx;
    entries.push({
      label: code,
      hint: s ? (i !== undefined ? snap.sets[snap.maps[i].set].title : t("not in the library")) : t("empty"),
      checked: here,
      disabled: here,
      action: () => void setPoolSlot(p.id, code, mapIdx),
    });
  }
  openMenu(at, entries, { minWidth: 240, className: "slot-menu" });
}
