/* pool-picker.ts — choosing what goes where in a pool: a difficulty for a slot (searched the
 * library's way, or on osu! through the mirrors' search, the ones that suit the slot first; a
 * pasted link to a difficulty works in both), or a slot for a difficulty (from its menu, "Add to
 * pool…"). A difficulty from osu! that the library doesn't have comes as its chart off the
 * mirrors (src-tauri/src/pools.rs).
 *
 * What suits a slot: in osu!mania the kind's character (rice with few long notes, LN with many,
 * hybrid in between, SV with scroll speed changes) and a star rating near the slot's place in its
 * kind (RC1 below RC2 below RC3, from the ones filled), else near the pool's. Star ratings here are
 * the library's (osu!mania at Half Time and Double Time: Fumen's); the pool page shows the exact
 * ones at the slot's mods. */
import { api, asApiError, osuCoverUrl, thumbUrl } from "../lib/api";
import { bpm, displayTitle, duration, esc, num, srChip } from "../lib/format";
import { t, tn } from "../lib/i18n";
import {
  fitsPool, kindInfo, kindOfSlot, poolById, poolRuleset, pools, poolSlot, rateOf, setPoolSlot, setPoolSlotOnline, slotChart, slotCodes, slotMapIdx,
  type Pool,
} from "../lib/pools";
import { DEFAULT_FILTER, filterLibrary } from "../lib/search";
import { store } from "../lib/store";
import type { FoundMap, FoundSet, MapRow } from "../lib/types";
import { attachSegIndicator, closeAnimated, openMenu, toast, type MenuEntry } from "../ui/controls";
import { icon } from "../ui/icons";
import { openPoolDialog } from "./pool-dialog";

/** rows the picker shows at most */
const SHOWN = 60;
/** how far from the slot's aim osu!'s search looks (stars, either way) */
const ONLINE_SPREAD = 0.75;

/** where the picker looked last (for the next slot) */
let lastSource: "library" | "osu" = "library";

/** A pasted link to a difficulty on osu! (or its number): its id. */
export function linkedBeatmap(text: string): number | null {
  const s = text.trim();
  if (/^\d{1,10}$/.test(s)) return +s || null;
  if (!isLink(s)) return null;
  const m = /beatmapsets\/\d+[^#]*#\w+\/(\d+)/i.exec(s) ?? /\/(?:b|beatmaps)\/(\d+)/i.exec(s) ?? /[?&]b=(\d+)/i.exec(s);
  return m ? +m[1] : null;
}

/** text that is a link to osu! (not a number, which may be a search too) */
const isLink = (s: string): boolean => /^((https?:\/\/)?(www\.)?osu\.ppy\.sh\/|osu:\/\/)/i.test(s.trim());

/** osu!mania star ratings at Half Time and Double Time against 1×, the library's middle one (the
 * mirrors only know 1×). */
function maniaRateFactor(r: number): number {
  const snap = store.snap;
  if (!snap || r === 1) return 1;
  const ratios: number[] = [];
  for (const m of snap.maps) {
    const at = r > 1 ? m.srDt : m.srHt;
    if (m.mode === 3 && at && m.sr > 0.5) ratios.push(at / m.sr);
    if (ratios.length >= 4000) break;
  }
  if (!ratios.length) return r > 1 ? 1.35 : 0.8;
  ratios.sort((a, b) => a - b);
  return ratios[ratios.length >> 1];
}

/** A difficulty's star rating at some mods, as far as the library knows it. */
export function knownStars(m: MapRow, mods: readonly string[]): number {
  const r = rateOf(mods);
  if (m.mode === 3) return (r > 1 ? m.srDt : r < 1 ? m.srHt : undefined) ?? m.sr;
  return m.sr;
}

/** the osu!mania kinds with a character to check */
const RULED = ["RC", "LN", "HB", "SV"];

/** what a difficulty is like, in the library or not */
type Character = Pick<MapRow, "mode" | "objects" | "holds" | "category">;

const lnShare = (m: Character): number => (m.objects ? m.holds / m.objects : 0);

/** Whether a difficulty has the character of an osu!mania kind (null: the kind has none to check). */
export function suits(code: string, m: Character): boolean | null {
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

/** Picks a difficulty for a slot: from the library, or from osu!. */
export function openSlotPicker(poolId: string, slot: string): void {
  const pool = poolById(poolId);
  const kind = pool && kindOfSlot(pool, slot);
  const snap = store.snap;
  const ix = store.index;
  if (!pool || !kind || !snap || !ix) return;
  const info = kindInfo(kind.code);
  const target = slotTarget(pool, slot);
  const rate = rateOf(kind.mods);
  const hasRule = pool.mode === 3 && RULED.includes(kind.code);
  let source = lastSource;
  let onlySuiting = hasRule;
  let text = "";
  /** where each difficulty already is in the pool (library ones by index, the rest by osu!'s id) */
  const inPool = new Map<number, string>();
  const onlineInPool = new Map<number, string>();
  for (const s of pool.slots) {
    const i = slotMapIdx(s);
    if (i !== undefined) inPool.set(i, s.slot);
    const c = slotChart(s);
    if (c?.beatmapId) onlineInPool.set(c.beatmapId, s.slot);
  }
  /** the library's difficulties that fit the pool, by osu!'s id */
  const owned = new Map<number, number>();
  snap.maps.forEach((m, i) => {
    if (m.onlineId && fitsPool(pool, i)) owned.set(m.onlineId, i);
  });

  // osu!'s side: pages of the mirrors' search
  let found: FoundSet[] = [];
  let page = 0;
  let more = false;
  let searching = false;
  let searchError = "";
  let asked = 0;
  /** a difficulty being fetched (its chart off the mirrors) */
  let fetching: number | null = null;
  /** the slot's aim in the mirrors' terms (1×) */
  const aim = target === null ? null : pool.mode === 3 ? target / maniaRateFactor(rate) : target;

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
          <input type="text" spellcheck="false" autocomplete="off" aria-label="${t("Search")}">
        </label>
        <div class="seg-pill pick-source" role="tablist" aria-label="${t("Where to look")}">
          <button type="button" role="tab" data-source="library">${t("Library")}</button>
          <button type="button" role="tab" data-source="osu">osu!</button>
        </div>
        ${hasRule ? `<button class="chip-toggle pick-suits active" type="button" aria-pressed="true">${t("Only {kind}", { kind: esc(info.name.toLowerCase()) })}</button>` : ""}
      </div>
      <div class="pick-list" role="listbox" aria-label="${t("Difficulties")}"></div>
      <div class="pick-foot"><span class="pick-count num"></span><button class="btn btn-ghost" type="button" data-act="cancel">${t("Cancel")}</button></div>
    </div>`;
  const list = bd.querySelector<HTMLElement>(".pick-list")!;
  const input = bd.querySelector<HTMLInputElement>(".pick-search input")!;
  const count = bd.querySelector<HTMLElement>(".pick-count")!;

  const libraryRow = (i: number, sr: number): string => {
    const m = snap.maps[i];
    const set = snap.sets[m.set];
    const bg = m.bg ?? set.bg;
    const facts =
      m.mode === 3
        ? [`LN ${Math.round(lnShare(m) * 100)}%`, m.category ? esc(m.category) : ""]
        : [`${bpm(m.bpm * rate)} BPM`, duration(m.length / rate)];
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
  };

  /** the row for a pasted link: what it points at goes in as it is */
  const linkRow = (id: number): string => {
    const own = owned.get(id);
    if (own !== undefined) return libraryRow(own, knownStars(snap.maps[own], kind.mods));
    const busy = fetching === id;
    return `<div class="pick-row pick-link${busy ? " is-busy" : ""}" role="option" tabindex="0" data-beatmap="${id}">
      <span class="t-art pick-link-ic">${icon(busy ? "refresh" : "link")}</span>
      <div class="pick-text">
        <div class="t-title">${t("osu! beatmap {id}", { id })}</div>
        <div class="t-sub">${busy ? t("Getting its chart from the mirrors…") : t("Not in your library: its chart comes from the mirrors")}</div>
      </div>
      <span class="pick-facts num">${onlineInPool.has(id) ? `<b>${t("in {slot}", { slot: esc(onlineInPool.get(id)!) })}</b>` : ""}</span>
      <span class="pick-sr"></span>
    </div>`;
  };

  const renderLibrary = () => {
    const linked = linkedBeatmap(text);
    const onlyLink = linked !== null && isLink(text);
    const found = filterLibrary(ix, { ...DEFAULT_FILTER, text: onlyLink ? "" : text, mode: pool.mode, keys: pool.mode === 3 && pool.keys ? [pool.keys] : [] });
    let rows: { i: number; m: MapRow; sr: number }[] = [];
    if (!onlyLink)
      for (const r of found.sets)
        for (const i of r.maps) {
          if (!fitsPool(pool, i)) continue;
          const m = snap.maps[i];
          if (onlySuiting && suits(kind.code, m) === false) continue;
          rows.push({ i, m, sr: knownStars(m, kind.mods) });
        }
    rows.sort((a, b) => (target !== null ? Math.abs(a.sr - target) - Math.abs(b.sr - target) : (b.m.played ?? 0) - (a.m.played ?? 0) || b.sr - a.sr));
    const total = rows.length;
    rows = rows.slice(0, SHOWN);
    count.textContent = onlyLink ? "" : total > SHOWN ? t("The {n} closest of {total}", { n: SHOWN, total: num(total) }) : tn(total, "{n} difficulty", "{n} difficulties");
    const top = linked !== null ? linkRow(linked) : "";
    if (onlyLink || (top && !rows.length)) {
      list.innerHTML = top;
      return;
    }
    if (!rows.length) {
      list.innerHTML = `<div class="pick-empty">${text ? t("Nothing in your library matches.") : t("Nothing in your library fits this pool.")}<button class="btn btn-sm" type="button" data-act="to-osu">${icon("search")}<span>${t("Look on osu!")}</span></button></div>`;
      return;
    }
    list.innerHTML = top + rows.map(({ i, sr }) => libraryRow(i, sr)).join("");
  };

  /** osu!'s difficulties found so far that fit the slot, nearest the aim first */
  const onlineRows = (): { set: FoundSet; m: FoundMap }[] => {
    const rows: { set: FoundSet; m: FoundMap }[] = [];
    for (const set of found)
      for (const m of set.maps) {
        if (!m.matches || m.mode !== pool.mode) continue;
        if (pool.mode === 3 && pool.keys && Math.round(m.cs) !== pool.keys) continue;
        const known = m.circles + m.sliders > 0;
        if (onlySuiting && known && suits(kind.code, { mode: m.mode, objects: m.circles + m.sliders, holds: m.sliders }) === false) continue;
        rows.push({ set, m });
      }
    if (aim !== null) rows.sort((a, b) => Math.abs(a.m.sr - aim) - Math.abs(b.m.sr - aim));
    return rows;
  };

  const renderOnline = () => {
    const linked = linkedBeatmap(text);
    if (linked) {
      count.textContent = "";
      list.innerHTML = linkRow(linked);
      return;
    }
    const rows = onlineRows();
    count.textContent = searching && !rows.length ? t("Searching osu!…") : tn(rows.length, "{n} difficulty", "{n} difficulties");
    if (searchError && !rows.length) {
      list.innerHTML = `<div class="pick-empty">${esc(searchError)}</div>`;
      return;
    }
    if (!rows.length) {
      list.innerHTML = searching ? `<div class="pick-empty">${t("Searching osu!…")}</div>` : `<div class="pick-empty">${t("Nothing on osu! matches. Paste a link to a difficulty, or search for something else.")}</div>`;
      return;
    }
    list.innerHTML =
      rows
        .map(({ set, m }) => {
          const own = owned.get(m.id);
          const busy = fetching === m.id;
          const known = m.circles + m.sliders > 0;
          const facts = [
            m.mode === 3 && known ? `LN ${Math.round((m.sliders / (m.circles + m.sliders)) * 100)}%` : "",
            `${bpm(m.bpm * rate)} BPM`,
            duration((m.length * 1000) / rate),
          ];
          const where = onlineInPool.get(m.id);
          const mark = where ? `<b>${t("in {slot}", { slot: esc(where) })}</b>` : own !== undefined ? `<b>${t("in your library")}</b>` : "";
          const title = (store.prefs.unicode && set.titleUnicode) || set.title;
          return `<div class="pick-row${busy ? " is-busy" : ""}" role="option" tabindex="0" data-beatmap="${m.id}">
            <span class="t-art"><img src="${osuCoverUrl(set.id)}" alt="" loading="lazy" decoding="async"></span>
            <div class="pick-text">
              <div class="t-title">${esc(title)}</div>
              <div class="t-sub">${busy ? t("Getting its chart from the mirrors…") : `${esc(m.version)} · ${esc(set.creator)}`}</div>
            </div>
            <span class="pick-facts num">${[...facts.filter(Boolean), mark].filter(Boolean).join(" · ")}</span>
            <span class="pick-sr" data-tip="${kind.mods.length ? t("Without mods; the pool shows it with them") : ""}">${srChip(m.sr)}</span>
          </div>`;
        })
        .join("") + (more ? `<div class="pick-more"><button class="btn btn-sm" type="button" data-act="more"${searching ? " disabled" : ""}>${t("More")}</button></div>` : "");
  };

  const render = () => (source === "library" ? renderLibrary() : renderOnline());

  /** One page of osu!'s search for the slot (a new search from page 0). */
  const search = async (next = false) => {
    if (linkedBeatmap(text)) return render();
    const ask = ++asked;
    page = next ? page + 1 : 0;
    if (!next) found = [];
    searching = true;
    searchError = "";
    render();
    try {
      const res = await api.searchMirrors({
        text: text.trim(),
        mode: pool.mode,
        keys: pool.mode === 3 && pool.keys ? [pool.keys] : [],
        srMin: aim !== null ? Math.max(0, +(aim - ONLINE_SPREAD).toFixed(2)) : null,
        srMax: aim !== null ? +(aim + ONLINE_SPREAD).toFixed(2) : null,
        status: [],
        sort: text.trim() ? "relevance" : "plays",
        page,
      });
      if (ask !== asked) return;
      found = next ? [...found, ...res.sets] : res.sets;
      more = res.more;
    } catch (e) {
      if (ask !== asked) return;
      searchError = asApiError(e).message;
      more = false;
    }
    searching = false;
    render();
  };

  const setSource = (to: "library" | "osu") => {
    source = lastSource = to;
    bd.querySelectorAll<HTMLElement>(".pick-source button").forEach((b) => {
      const on = b.dataset.source === to;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    });
    input.placeholder = to === "library" ? t("Search, like in the library: sr>5 ln>30 …") : t("Search osu!, or paste a link to a difficulty");
    if (to === "osu" && !found.length && !searching) void search();
    else render();
  };

  const finish = () => {
    document.removeEventListener("keydown", onKey, true);
    closeAnimated(bd);
  };
  const pick = (i: number) => {
    finish();
    void setPoolSlot(pool.id, slot, i);
  };
  /** a difficulty from osu!: the library's when it has it, else its chart off the mirrors */
  const pickOnline = async (id: number) => {
    const own = owned.get(id);
    if (own !== undefined) return pick(own);
    if (fetching !== null) return;
    fetching = id;
    render();
    try {
      await setPoolSlotOnline(pool.id, slot, String(id));
      fetching = null;
      finish();
    } catch (e) {
      fetching = null;
      render();
      toast(asApiError(e).message, { kind: "danger", timeout: 4000 });
    }
  };
  const choose = (row: HTMLElement) => {
    if (row.dataset.map !== undefined) pick(+row.dataset.map);
    else if (row.dataset.beatmap) void pickOnline(+row.dataset.beatmap);
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
        choose(row);
      }
    }
  };
  document.addEventListener("keydown", onKey, true);
  bd.addEventListener("pointerdown", (e) => {
    if (e.target === bd) finish();
  });
  let typing = 0;
  input.addEventListener("input", () => {
    text = input.value;
    clearTimeout(typing);
    if (source === "library" || linkedBeatmap(text)) typing = window.setTimeout(render, 120);
    else typing = window.setTimeout(() => void search(), 400);
  });
  bd.addEventListener("click", (e) => {
    const el = e.target as Element;
    const row = el.closest<HTMLElement>(".pick-row");
    if (row) return choose(row);
    const src = el.closest<HTMLElement>(".pick-source button");
    if (src) return setSource(src.dataset.source as "library" | "osu");
    if (el.closest('[data-act="to-osu"]')) return setSource("osu");
    if (el.closest('[data-act="more"]')) return void search(true);
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
  attachSegIndicator(bd.querySelector<HTMLElement>(".pick-source")!);
  setSource(source);
  setTimeout(() => input.focus(), 30);
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
      hint: s ? (slotChart(s)?.title ?? t("not in the library")) : t("empty"),
      checked: here,
      disabled: here,
      action: () => void setPoolSlot(p.id, code, mapIdx),
    });
  }
  openMenu(at, entries, { minWidth: 240, className: "slot-menu" });
}
