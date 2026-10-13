import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/shell.css";
import "./styles/library.css";
import "./styles/home.css";
import "./styles/fullscreen.css";
import "./styles/set.css";
import "./styles/chart.css";
import "./styles/player.css";
import "./styles/settings.css";
import "./styles/welcome.css";
import "./styles/import.css";
import "./styles/history.css";
import "./styles/skills.css";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, asApiError, isTauri, onAnalysis, thumbUrl } from "./lib/api";
import { esc, num } from "./lib/format";
import { current, goSection, initRouterInput, router, sectionRoot, type Route } from "./lib/router";
import { describeScan, isScanning, runScan } from "./lib/scan";
import { clearSkins, loadSkinList } from "./lib/skin/skins";
import { events, loadPrefs, refreshStatus, reloadLibrary, setPrefs, setSnapshot, store } from "./lib/store";
import type { ScanProgress } from "./lib/types";
import { mountPlayerBar } from "./player";
import { openFullscreen } from "./views/fullscreen";
import { importProgressText, isImporting, openImport } from "./views/import";
import { readLinks } from "./lib/links";
import { closeMenus, initControls, toast } from "./ui/controls";
import { icon, injectIconSprite } from "./ui/icons";
import { applyAppearance } from "./ui/theme";
import {
  addToCollection, collectionEvents, collectionMaps, DRAG_TYPE, fumenCollection, fumenCollections, initCollections, isSmart, smartFilter,
} from "./lib/collections";
import { initGoals } from "./lib/goals-store";
import { collectionMenu, newCollection } from "./views/actions";
import { initHistory, mapIndexOf, syncIfStale } from "./lib/history";
import { downloadText, initUpdater, installUpdate, updateEvents, type UpdateState } from "./lib/updater";
import { HistoryView } from "./views/history";
import { HomeView } from "./views/home";
import { SkillsView } from "./views/skills";
import { LibraryView } from "./views/library";
import { SetView } from "./views/set";
import { SettingsView } from "./views/settings";
import { WelcomeView } from "./views/welcome";

interface View {
  el: HTMLElement;
  destroy(): void;
  shown?(): void;
}

const MARK = `<svg class="side-mark" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="15" width="4" height="2.6" rx="1.3"/><rect x="8" y="11" width="4" height="2.6" rx="1.3"/><rect x="13" y="7" width="4" height="2.6" rx="1.3"/><rect x="18" y="3" width="4" height="6.6" rx="1.6" opacity=".45"/><rect x="18" y="7" width="4" height="2.6" rx="1.3"/><rect x="2" y="20" width="21" height="1.2" rx=".6" opacity=".35"/></svg>`;

const app = document.getElementById("app")!;
app.className = "app";
app.innerHTML = `
  <nav class="sidebar">
    <div class="side-head" data-tauri-drag-region>
      <button class="icon-btn side-toggle" type="button">${icon("chevrons-left")}</button>
      <div class="side-brand" data-tauri-drag-region>${MARK}<span class="side-name" data-tauri-drag-region>Fumen</span></div>
      <button class="icon-btn side-refresh" type="button" aria-label="Update library">${icon("refresh")}</button>
    </div>
    <div class="side-search">
      <label class="search">
        ${icon("search", "search-ic")}
        <input type="text" spellcheck="false" autocomplete="off" placeholder="Search…" aria-label="Search the library" />
        <button class="icon-btn sm search-clear" type="button" data-tip="Clear" aria-label="Clear search" hidden>${icon("x")}</button>
      </label>
      <button class="nav-item side-search-btn reveal" type="button" data-tip="Search" aria-label="Search">${icon("search")}</button>
    </div>
    <div class="nav">
      <button class="nav-item reveal" type="button" data-nav="home">${icon("home")}<span class="nav-label">Home</span></button>
      <button class="nav-item reveal" type="button" data-nav="library">${icon("library")}<span class="nav-label">Library</span></button>
      <button class="nav-item reveal" type="button" data-nav="history">${icon("clock")}<span class="nav-label">History</span></button>
      <button class="nav-item reveal" type="button" data-nav="skills">${icon("radar")}<span class="nav-label">Skills</span></button>
      <button class="nav-item reveal" type="button" data-act="import">${icon("download")}<span class="nav-label">Add beatmaps</span></button>
    </div>
    <div class="side-sep"></div>
    <section class="side-box" data-group="collections" hidden>
      <div class="side-box-bar">
        <button class="side-box-head" type="button" aria-expanded="true">
          ${icon("collection", "side-box-ic")}<span class="side-box-label">Collections</span>${icon("chevron-down", "side-box-chev")}
        </button>
        <button class="icon-btn sm side-box-add" type="button" data-tip="New collection" aria-label="New collection">${icon("plus")}</button>
      </div>
      <div class="side-list"></div>
    </section>
    <div class="side-foot">
      <button class="side-update" type="button" hidden>
        <span class="side-update-bar"></span>
        ${icon("download", "side-update-ic")}
        <span class="side-update-text"><span class="side-update-title"></span><span class="side-update-sub"></span></span>
      </button>
      <div class="side-sep"></div>
      <div class="profile">
        <div class="avatar"><span class="avatar-initial"></span><img alt="" hidden /></div>
        <div class="profile-text">
          <div class="profile-name"></div>
          <div class="profile-sub num"></div>
        </div>
        <button class="icon-btn profile-settings" type="button" data-nav="settings" data-tip="Settings" aria-label="Settings">${icon("settings")}</button>
      </div>
    </div>
  </nav>
  <div class="main">
    <div class="topbar" data-tauri-drag-region>
      <div class="win-controls">
        <button class="win-btn" id="win-min" type="button" aria-label="Minimise">${icon("win-min")}</button>
        <button class="win-btn" id="win-max" type="button" aria-label="Maximise">${icon("win-max", "ic-max")}${icon("win-restore", "ic-restore")}</button>
        <button class="win-btn win-close" id="win-close" type="button" aria-label="Close">${icon("win-close")}</button>
      </div>
    </div>
    <main class="content"></main>
    <footer class="player-bar"></footer>
  </div>`;

const $ = <T extends Element>(sel: string) => app.querySelector<T>(sel)!;

// ── Update button (sidebar) ──────────────────────────────────────────────
const sideUpdate = $<HTMLButtonElement>(".side-update");
function renderSideUpdate(s: UpdateState): void {
  const show = s.phase === "available" || s.phase === "downloading" || s.phase === "installing" || (s.phase === "error" && !!s.version);
  sideUpdate.hidden = !show;
  if (!show) return;
  const version = "version" in s ? s.version : "";
  const [title, sub] =
    s.phase === "downloading"
      ? [`Downloading ${version}`, downloadText(s)]
      : s.phase === "installing"
        ? [`Installing ${version}`, "Fumen restarts"]
        : s.phase === "error"
          ? [`Update to ${version}`, "Didn't work, try again"]
          : [`Update to ${version}`, "Restarts Fumen"];
  sideUpdate.querySelector(".side-update-title")!.textContent = title;
  sideUpdate.querySelector(".side-update-sub")!.textContent = sub;
  sideUpdate.disabled = s.phase === "downloading" || s.phase === "installing";
  sideUpdate.classList.toggle("is-error", s.phase === "error");
  sideUpdate.dataset.tip = s.phase === "error" ? s.message : `${title} · ${sub}`;
  const p = s.phase === "downloading" && s.total ? s.done / s.total : s.phase === "installing" ? 1 : 0;
  sideUpdate.style.setProperty("--p", String(p));
}
updateEvents.on("change", renderSideUpdate);
sideUpdate.addEventListener("click", () => void installUpdate());
const content = $<HTMLElement>(".content");
const sideList = $<HTMLElement>(".side-list");
const sideBox = $<HTMLElement>(".side-box");
const searchInput = $<HTMLInputElement>(".side-search input");
const searchClear = $<HTMLButtonElement>(".side-search .search-clear");
const refreshBtn = $<HTMLButtonElement>(".side-refresh");

let home: HomeView | null = null;
let library: LibraryView | null = null;
let history: HistoryView | null = null;
let skillsView: SkillsView | null = null;
const collectionViews = new Map<string, LibraryView>();
let active: View | null = null;

// ── routing ────────────────────────────────────────────────────────────────

function ensureHome(): HomeView {
  if (!home) {
    home = new HomeView();
    home.el.hidden = true;
    content.appendChild(home.el);
  }
  return home;
}

function ensureLibrary(): LibraryView {
  if (!library) {
    library = new LibraryView({
      title: "Library",
      persistent: true,
      emptyHint: "Import your osu!lazer library from Settings.",
      onQuery: (q) => syncSearchFrom(library, q),
      onSmartSaved: (id) => goSection({ name: "collection", id }),
    });
    library.el.hidden = true;
    content.appendChild(library.el);
  }
  return library;
}

function ensureHistory(): HistoryView {
  if (!history) {
    history = new HistoryView();
    history.el.hidden = true;
    content.appendChild(history.el);
  }
  return history;
}

function ensureSkills(): SkillsView {
  if (!skillsView) {
    skillsView = new SkillsView();
    skillsView.el.hidden = true;
    content.appendChild(skillsView.el);
  }
  return skillsView;
}

function collectionView(id: string): LibraryView | null {
  const mine = fumenCollection(id);
  if (mine) return fumenCollectionView(id);
  const col = store.snap?.collections.find((c) => c.id === id);
  if (!col) return null;
  let v = collectionViews.get(id);
  if (!v) {
    const view: LibraryView = new LibraryView({
      title: col.name,
      restrict: () => {
        const c = store.snap?.collections.find((x) => x.id === id);
        return new Set(c?.maps ?? []);
      },
      subtitle: () => {
        const c = store.snap?.collections.find((x) => x.id === id);
        return c?.missing ? `${num(c.missing)} not in your library` : "";
      },
      emptyHint: "Add maps to this collection in osu!lazer.",
      onQuery: (q) => syncSearchFrom(view, q),
      menu: (at) => collectionMenu(at, id, { copied: (copy) => goSection({ name: "collection", id: copy }) }),
    });
    v = view;
    v.el.hidden = true;
    content.appendChild(v.el);
    collectionViews.set(id, v);
  }
  return v;
}

/** One of Fumen's collections: like lazer's, plus taking maps out, renaming and deleting. */
function fumenCollectionView(id: string): LibraryView {
  let v = collectionViews.get(id);
  if (!v) {
    const view: LibraryView = new LibraryView({
      title: () => fumenCollection(id)?.name ?? "Collection",
      restrict: () => {
        const c = fumenCollection(id);
        return c ? collectionMaps(c) : new Set();
      },
      subtitle: () => {
        const c = fumenCollection(id);
        return c?.missing ? `${num(c.missing)} not in your library` : "";
      },
      emptyHint: isSmart(fumenCollection(id))
        ? "Nothing in your library matches this search right now."
        : "Drag sets here from the library, or right-click a beatmap › Add to collection.",
      onQuery: (q) => syncSearchFrom(view, q),
      menu: (at) => collectionMenu(at, id, { deleted: () => goSection({ name: "library" }), editSearch }),
      collection: id,
    });
    v = view;
    v.el.hidden = true;
    content.appendChild(v.el);
    collectionViews.set(id, v);
  }
  return v;
}

/** A smart collection's search, into the library's filters to change it. */
function editSearch(id: string): void {
  const c = fumenCollection(id);
  if (!c) return;
  goSection({ name: "library" });
  ensureLibrary().editSmart(id, c.name, smartFilter(c));
}

collectionEvents.on("collections", () => {
  // pages of collections that are gone go; the others show what changed
  for (const [id, v] of collectionViews) {
    const lazer = store.snap?.collections.some((c) => c.id === id);
    if (fumenCollection(id)) v.refresh();
    else if (!lazer) {
      if (active === v) goSection({ name: "library" });
      v.destroy();
      collectionViews.delete(id);
    }
  }
  renderCollections();
});

function show(route: Route): void {
  closeMenus(true);
  // persistent views just hide; ephemeral ones are destroyed
  const persistent = new Set<View>([...(home ? [home] : []), ...(library ? [library] : []), ...(history ? [history] : []), ...(skillsView ? [skillsView] : []), ...collectionViews.values()]);
  if (active && !persistent.has(active)) active.destroy();
  for (const v of persistent) v.el.hidden = true;

  let view: View;
  switch (route.name) {
    case "home":
      if (store.snap) view = ensureHome();
      else {
        view = new WelcomeView();
        content.appendChild(view.el);
      }
      break;
    case "library":
      view = ensureLibrary();
      break;
    case "history":
      view = ensureHistory();
      break;
    case "skills":
      view = ensureSkills();
      break;
    case "collection":
      view = collectionView(route.id) ?? ensureLibrary();
      break;
    case "set":
      view = new SetView(route.id, route.map, route.similar);
      content.appendChild(view.el);
      break;
    case "settings":
      view = new SettingsView();
      content.appendChild(view.el);
      break;
    case "welcome":
      view = new WelcomeView();
      content.appendChild(view.el);
      break;
  }
  active = view;
  view.el.hidden = false;
  view.el.classList.remove("view-enter");
  void view.el.offsetWidth;
  view.el.classList.add("view-enter");
  view.shown?.();
  document.body.dataset.view = route.name;
  syncNav(route);
  syncSearchToRoute(route);
}

router.on("change", show);

function syncNav(route: Route): void {
  // a set page belongs to the section it was opened from
  const r = route.name === "set" ? sectionRoot() : route;
  const section = r.name === "welcome" ? "home" : r.name;
  app.querySelectorAll<HTMLElement>("[data-nav]").forEach((b) => b.classList.toggle("active", b.dataset.nav === section));
  sideList.querySelectorAll<HTMLElement>(".side-item").forEach((b) => {
    b.classList.toggle("active", r.name === "collection" && b.dataset.id === r.id);
  });
}

function renderCollections(): void {
  const snap = store.snap;
  const lazer = (snap?.collections ?? []).filter((c) => !c.from);
  const stable = (snap?.collections ?? []).filter((c) => c.from === "stable");
  const mine = snap ? fumenCollections() : [];
  sideBox.hidden = !snap;
  const item = (id: string, name: string, maps: number[], fumen: boolean, smart = false) => {
    // cover: the first difficulty in the collection that has a background
    const mi = maps.find((i) => snap!.maps[i].bg ?? snap!.sets[snap!.maps[i].set].bg);
    const bg = mi !== undefined ? (snap!.maps[mi].bg ?? snap!.sets[snap!.maps[mi].set].bg) : undefined;
    return `<button class="side-item reveal" type="button" data-id="${esc(id)}"${fumen && !smart ? " data-fumen" : ""}${smart ? " data-smart" : ""}>
      <span class="side-cover${bg ? "" : " img-missing"}">${bg ? `<img src="${thumbUrl(bg, 160)}" alt="" loading="lazy" decoding="async" />` : icon("collection")}</span>
      <span class="side-label">${esc(name)}</span>${smart ? icon("sliders", "side-smart") : ""}<span class="side-count num">${num(maps.length)}</span>
    </button>`;
  };
  sideList.innerHTML = [
    ...mine.map((c) => item(c.id, c.name, [...collectionMaps(c)], true, isSmart(c))),
    !mine.length ? `<div class="side-empty">Make one with + or drag a set here.</div>` : "",
    lazer.length ? `<div class="side-sub">In osu!lazer</div>` : "",
    ...lazer.map((c) => item(c.id, c.name, c.maps, false)),
    stable.length ? `<div class="side-sub">In osu!stable</div>` : "",
    ...stable.map((c) => item(c.id, c.name, c.maps, false)),
  ].join("");
  syncNav(current());
  applySidebar();
}

$(".side-box-add").addEventListener("click", () => void newCollection().then((id) => id && goSection({ name: "collection", id })));
sideList.addEventListener("contextmenu", (e) => {
  const b = (e.target as Element).closest<HTMLElement>(".side-item");
  if (!b) return;
  e.preventDefault();
  collectionMenu({ x: e.clientX, y: e.clientY }, b.dataset.id!, {
    deleted: () => {},
    copied: (copy) => goSection({ name: "collection", id: copy }),
    editSearch,
  });
});

// drops from the library: onto one of Fumen's collections, or the box's + for a new one
const dragIds = (e: DragEvent): string[] | null => {
  try {
    return JSON.parse(e.dataTransfer?.getData(DRAG_TYPE) || "null");
  } catch {
    return null;
  }
};
const dropTarget = (e: DragEvent) => (e.target as Element).closest<HTMLElement>(".side-item[data-fumen], .side-box-add");
sideBox.addEventListener("dragover", (e) => {
  if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
  const t = dropTarget(e);
  sideBox.querySelectorAll(".drop-over").forEach((x) => x !== t && x.classList.remove("drop-over"));
  if (!t) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  t.classList.add("drop-over");
});
sideBox.addEventListener("dragleave", (e) => {
  const t = dropTarget(e);
  if (t && !t.contains(e.relatedTarget as Node)) t.classList.remove("drop-over");
});
sideBox.addEventListener("drop", (e) => {
  const t = dropTarget(e);
  sideBox.querySelectorAll(".drop-over").forEach((x) => x.classList.remove("drop-over"));
  const ids = dragIds(e);
  if (!t || !ids?.length) return;
  e.preventDefault();
  const idx = ids.map((id) => mapIndexOf(id)).filter((i): i is number => i !== undefined);
  if (t.classList.contains("side-box-add")) void newCollection(idx);
  else void addToCollection(t.dataset.id!, idx);
});

app.querySelector(".nav")!.addEventListener("click", (e) => {
  if ((e.target as Element).closest("[data-act=\"import\"]")) return openImport();
  const b = (e.target as Element).closest<HTMLElement>("[data-nav]");
  if (!b) return;
  if (!store.snap) return goSection({ name: "welcome" });
  goSection({ name: b.dataset.nav as "home" | "library" | "history" | "skills" });
});
$(".profile-settings").addEventListener("click", () => goSection({ name: "settings" }));
sideList.addEventListener("click", (e) => {
  const b = (e.target as Element).closest<HTMLElement>(".side-item");
  if (b) goSection({ name: "collection", id: b.dataset.id! });
});
sideList.addEventListener("error", (e) => {
  const img = e.target as HTMLElement;
  if (img.tagName === "IMG") {
    img.parentElement?.classList.add("img-missing");
    img.remove();
  }
}, true);

// collapsible groups
function applyGroups(): void {
  app.querySelectorAll<HTMLElement>(".side-box[data-group]").forEach((box) => {
    const closed = store.prefs.collapsedGroups.includes(box.dataset.group!);
    box.classList.toggle("closed", closed);
    box.querySelector(".side-box-head")!.setAttribute("aria-expanded", String(!closed));
  });
}
app.querySelectorAll<HTMLElement>(".side-box-head").forEach((head) =>
  head.addEventListener("click", () => {
    const group = head.closest<HTMLElement>(".side-box")!.dataset.group!;
    const set = new Set(store.prefs.collapsedGroups);
    if (set.has(group)) set.delete(group);
    else set.add(group);
    setPrefs({ collapsedGroups: [...set] });
    applyGroups();
  }),
);

// ── sidebar collapse ───────────────────────────────────────────────────────

function applySidebar(): void {
  const collapsed = store.prefs.sidebarCollapsed;
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  const btn = $<HTMLElement>(".side-toggle");
  btn.dataset.tip = collapsed ? "Expand sidebar" : "Collapse sidebar";
  btn.setAttribute("aria-label", btn.dataset.tip);
  app.querySelectorAll<HTMLElement>(".sidebar .nav-item[data-nav], .sidebar .nav-item[data-act], .sidebar .side-item").forEach((el) => {
    const label = el.querySelector(".nav-label, .side-label")?.textContent ?? "";
    if (collapsed) el.dataset.tip = label;
    else delete el.dataset.tip;
  });
}
function setSidebarCollapsed(collapsed: boolean): void {
  if (collapsed === store.prefs.sidebarCollapsed) return;
  setPrefs({ sidebarCollapsed: collapsed });
  applySidebar();
}
$(".side-toggle").addEventListener("click", () => setSidebarCollapsed(!store.prefs.sidebarCollapsed));

// ── search (lives in the sidebar, drives the library / collection on screen) ──

function searchTarget(): LibraryView | null {
  const r = current();
  if (r.name === "collection") return collectionViews.get(r.id) ?? null;
  if (r.name === "library") return library;
  return null;
}

function setSearchValue(q: string): void {
  if (searchInput.value !== q) searchInput.value = q;
  searchClear.hidden = !q;
  document.body.classList.toggle("searching", !!q);
}

/** A view changed its own query (reset button, "more by this mapper"). */
function syncSearchFrom(view: LibraryView | null, q: string): void {
  if (view && view === searchTarget()) setSearchValue(q);
}

function syncSearchToRoute(route: Route): void {
  const view = route.name === "collection" ? collectionViews.get(route.id) : library;
  setSearchValue(view?.query ?? "");
}

let searchTimer = 0;
function applySearch(): void {
  const view = searchTarget();
  const q = searchInput.value;
  if (view) return view.setQuery(q);
  if (!q.trim() || !store.snap) return;
  // query first, then navigate: the route sync then finds the same text and leaves the caret alone
  ensureLibrary().setQuery(q);
  goSection({ name: "library" });
}
searchInput.addEventListener("input", () => {
  searchClear.hidden = !searchInput.value;
  document.body.classList.toggle("searching", !!searchInput.value);
  if (searchInput.value) hideHints();
  else showHints();
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(applySearch, 70);
});
searchClear.addEventListener("click", () => {
  searchInput.value = "";
  applySearch();
  setSearchValue("");
  searchInput.focus();
});

function focusSearch(): void {
  setSidebarCollapsed(false);
  searchInput.focus();
  searchInput.select();
}
$(".side-search-btn").addEventListener("click", focusSearch);

// filter syntax hints under the search field while it's empty
const HINTS: { token: string; label: string }[] = [
  { token: "keys=7", label: "Mania key count" },
  { token: "sr>5", label: "Star rating" },
  { token: "status=ranked", label: "ranked, loved, local…" },
  { token: "bpm>=180", label: "Tempo" },
  { token: "length<2:00", label: "Length" },
  { token: "pattern=jumpstream", label: "stream, chordjack, ln, stamina…" },
  { token: "peak>15", label: "Densest notes per second" },
  { token: "played=no", label: "Never played" },
  { token: "grade>=a", label: "Your best grade" },
  { token: "creator=", label: "Mapper" },
  { token: "-word", label: "Leave out a word" },
];
let hintsEl: HTMLElement | null = null;
let hintIdx = -1;

function showHints(): void {
  if (hintsEl || searchInput.value || document.activeElement !== searchInput || !store.snap) return;
  const el = document.createElement("div");
  el.className = "menu search-hints";
  el.setAttribute("role", "listbox");
  el.innerHTML = `<div class="menu-group">Filter like this</div>${HINTS.map(
    (h, i) => `<div class="menu-item mi" role="option" data-i="${i}" style="--k:${i}"><span class="menu-label hint-token">${esc(h.token)}</span><span class="menu-hint">${esc(h.label)}</span></div>`,
  ).join("")}`;
  const r = searchInput.closest(".search")!.getBoundingClientRect();
  el.style.left = `${Math.round(r.left)}px`;
  el.style.top = `${Math.round(r.bottom + 6)}px`;
  el.style.width = `${Math.max(280, Math.round(r.width))}px`;
  el.addEventListener("pointerdown", (e) => e.preventDefault()); // keep focus in the input
  el.addEventListener("click", (e) => {
    const it = (e.target as Element).closest<HTMLElement>("[data-i]");
    if (it) insertHint(+it.dataset.i!);
  });
  el.addEventListener("pointermove", (e) => {
    const it = (e.target as Element).closest<HTMLElement>("[data-i]");
    if (it) highlightHint(+it.dataset.i!);
  });
  document.body.appendChild(el);
  hintsEl = el;
  hintIdx = -1;
}

function hideHints(): void {
  const el = hintsEl;
  if (!el) return;
  hintsEl = null;
  el.classList.add("closing");
  setTimeout(() => el.remove(), 150);
}

function highlightHint(i: number): void {
  hintIdx = i;
  hintsEl?.querySelectorAll<HTMLElement>("[data-i]").forEach((n) => n.classList.toggle("hl", +n.dataset.i! === i));
}

function insertHint(i: number): void {
  const { token } = HINTS[i];
  searchInput.value = token;
  // select the example value so typing replaces it
  const m = /^(-|[a-z]+(?:>=|<=|==|!=|=|<|>))(.*)$/.exec(token);
  const from = m ? m[1].length : token.length;
  searchInput.focus();
  searchInput.setSelectionRange(from, token.length);
  hideHints();
  searchClear.hidden = false;
  document.body.classList.add("searching");
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(applySearch, 70);
}

searchInput.addEventListener("focus", showHints);
searchInput.addEventListener("blur", hideHints);
searchInput.addEventListener("keydown", (e) => {
  if (hintsEl && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    const n = HINTS.length;
    highlightHint(hintIdx < 0 ? (e.key === "ArrowDown" ? 0 : n - 1) : (hintIdx + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
  } else if (hintsEl && e.key === "Enter" && hintIdx >= 0) {
    e.preventDefault();
    insertHint(hintIdx);
  } else if (e.key === "Escape") {
    e.stopPropagation();
    if (hintsEl) hideHints();
    else if (searchInput.value) {
      searchInput.value = "";
      applySearch();
      setSearchValue("");
    } else searchInput.blur();
  } else if (e.key === "Enter") {
    clearTimeout(searchTimer);
    applySearch();
  }
});

// ── profile + library state ────────────────────────────────────────────────

function renderProfile(): void {
  const snap = store.snap;
  const user = snap?.user;
  const name = user?.name ?? (snap ? "osu! player" : "Fumen");
  $(".profile-name").textContent = name;
  $(".avatar-initial").textContent = name.slice(0, 1).toUpperCase();
  const img = $<HTMLImageElement>(".avatar img");
  if (user?.id && img.dataset.id !== String(user.id)) {
    img.dataset.id = String(user.id);
    img.hidden = true;
    img.onload = () => (img.hidden = false);
    img.onerror = () => (img.hidden = true);
    img.src = `https://a.ppy.sh/${user.id}`;
  } else if (!user?.id) {
    img.hidden = true;
    img.removeAttribute("src");
    delete img.dataset.id;
  }
  renderLibraryState();
}

/** background chart analysis (runs after imports; feeds pattern search) */
let analysis: ScanProgress | null = null;

function renderLibraryState(): void {
  const sub = $<HTMLElement>(".profile-sub");
  const p = store.scan;
  const importing = importProgressText();
  if (importing) {
    sub.textContent = `Adding beatmaps · ${importing}`;
    sub.dataset.tip = "Downloading and importing into osu!lazer";
  } else if (p) {
    const { label, fraction } = describeScan(p);
    sub.textContent = `Updating · ${Math.round(fraction * 100)}%`;
    sub.dataset.tip = label;
  } else if (analysis && analysis.done < analysis.total) {
    sub.textContent = `Analysing charts · ${Math.round((analysis.done / Math.max(1, analysis.total)) * 100)}%`;
    sub.dataset.tip = "Reading every difficulty once, for pattern search";
  } else {
    const sets = store.snap?.sets.filter((s) => s.maps.length).length ?? 0;
    sub.textContent = store.snap ? `${num(sets)} beatmap sets` : "No library yet";
    delete sub.dataset.tip;
  }
  const busy = isScanning() || isImporting();
  refreshBtn.disabled = busy || !(store.status?.install || store.status?.stable?.install);
  refreshBtn.classList.toggle("busy", busy);
  refreshBtn.dataset.tip = busy ? "Updating library…" : "Update library";
}

refreshBtn.addEventListener("click", async () => {
  const res = await runScan();
  if (!res.ok) toast(`Couldn't update the library: ${res.error.message}`, { kind: "danger", timeout: 6000 });
  else toast("Library updated", { kind: "success", timeout: 2200 });
});
events.on("scan", renderLibraryState);
events.on("status", renderLibraryState);
events.on("importing", renderLibraryState);

// ── window ─────────────────────────────────────────────────────────────────

async function initWindow(): Promise<void> {
  if (!isTauri) return;
  const win = getCurrentWindow();
  $("#win-min").addEventListener("click", () => void win.minimize());
  $("#win-max").addEventListener("click", () => void win.toggleMaximize());
  $("#win-close").addEventListener("click", () => void win.close());
  const sync = async () => {
    const max = await win.isMaximized().catch(() => false);
    document.body.classList.toggle("win-maximized", max);
    $<HTMLElement>("#win-max").dataset.tip = max ? "Restore" : "Maximise";
  };
  await win.onResized(() => void sync());
  void sync();
  // lazer may change while Fumen is open: check when the window regains focus
  let lastCheck = 0;
  await win.onFocusChanged(({ payload: focused }) => {
    if (!focused || Date.now() - lastCheck < 30_000) return;
    lastCheck = Date.now();
    void maybeAutoRescan();
  });
}

// ── keyboard ───────────────────────────────────────────────────────────────

window.addEventListener("keydown", (e) => {
  const typing = (e.target as HTMLElement).closest("input, textarea, [contenteditable]");
  if ((e.ctrlKey && e.key.toLowerCase() === "f") || (e.key === "/" && !typing)) {
    if (!store.snap) return;
    e.preventDefault();
    focusSearch();
  }
});

// osu! links pasted anywhere outside a text field: add them
window.addEventListener("paste", (e) => {
  if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
  const text = e.clipboardData?.getData("text") ?? "";
  if (!readLinks(text).links.length) return;
  e.preventDefault();
  openImport(text);
});

// search requests from anywhere (tags, "more by this mapper", the player menu)
events.on("search", (q) => {
  goSection({ name: "library" });
  ensureLibrary().setQuery(q);
});

// ── data ───────────────────────────────────────────────────────────────────

events.on("library", () => {
  // a new import may have brought new skins; reading the list also extracts lazer's built-in ones
  clearSkins();
  void loadSkinList().catch(() => {});
  renderCollections();
  renderProfile();
  // collections that vanished
  for (const [id, v] of collectionViews) {
    if (!store.snap?.collections.some((c) => c.id === id)) {
      v.destroy();
      collectionViews.delete(id);
    }
  }
});

/** First import only: pick a sensible default ruleset from what the player actually plays. */
function applyFirstRunDefaults(): void {
  if (store.prefs.defaultsApplied || !store.snap) return;
  const plays = [0, 0, 0, 0];
  for (const m of store.snap.maps) if (m.best && m.mode >= 0 && m.mode <= 3) plays[m.mode] += m.best.plays;
  const total = plays.reduce((a, b) => a + b, 0);
  const top = plays.indexOf(Math.max(...plays));
  const patch: Parameters<typeof setPrefs>[0] = { defaultsApplied: true };
  if (total >= 20 && plays[top] / total >= 0.6) patch.mode = top;
  setPrefs(patch);
}

async function maybeAutoRescan(): Promise<void> {
  const st = await refreshStatus().catch(() => null);
  // an import into lazer rescans by itself when it's done
  if (!st?.changed || store.settings?.autoRescan === false || isImporting()) return;
  const res = await runScan();
  if (!res.ok) toast(`Couldn't update the library: ${res.error.message}`, { kind: "danger", timeout: 6000 });
}

async function boot(): Promise<void> {
  injectIconSprite();
  initControls();
  initRouterInput();
  mountPlayerBar($(".player-bar"), { onFullscreen: () => openFullscreen() });
  void initWindow();
  if (isTauri) {
    void onAnalysis(
      (p) => {
        analysis = p;
        renderLibraryState();
      },
      () => {
        analysis = null;
        renderLibraryState();
        if (store.snap) void reloadLibrary().catch((e) => console.warn("[analysis] reload failed", e));
      },
    );
  }

  try {
    loadPrefs(await api.getSettings());
  } catch (e) {
    console.warn("[settings]", asApiError(e).message);
  }
  applyAppearance();
  applySidebar();
  applyGroups();
  renderProfile();

  let st;
  try {
    st = await refreshStatus();
  } catch (e) {
    toast(asApiError(e).message, { kind: "danger" });
  }
  if (st?.scannedAt) {
    setSnapshot(await api.getLibrary());
    applyFirstRunDefaults(); // before the library view exists: it reads the default mode from prefs
    show(current());
    if (st.changed && store.settings?.autoRescan !== false) void maybeAutoRescan();
  } else {
    renderCollections();
    goSection({ name: "welcome" });
    const off = events.on("library", () => {
      off();
      applyFirstRunDefaults();
    });
  }
  // the plays: kept current, and read from osu! when the last sync is old
  initHistory();
  void syncIfStale();
  initUpdater();
  initGoals();
  initCollections();
  document.body.classList.add("ready");
}

void boot();
