/* companion.ts — the companion window: small, in a corner, on top of the game. It shows the
 * session so far (plays, time, accuracy, new bests), the last play against the best before it,
 * and a pool to work through: a collection's difficulties, ticked off as they're passed, with the
 * best accuracy this session.
 *
 * Plays come from the replays lazer saves (src-tauri/src/live.rs, event `live-play`). A click on
 * the last play brings the main window up at its score page (event `show-score`).
 *
 * The window is transparent around the panel. While the cursor is over it, clicks go through to
 * the game and the panel fades (event `companion-through`, from lib.rs); holding Ctrl makes it
 * clickable. Its height follows the panel (`fit_companion`). */
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/companion.css";
import { emitTo, listen } from "@tauri-apps/api/event";
import { api, asApiError, onLivePlay } from "./lib/api";
import { duration, esc, num, pct, rankInfo, srChip } from "./lib/format";
import { isBest, playMods, rankNumber, sessionStart, summary } from "./lib/live";
import { loadPrefs, setPrefs, store } from "./lib/store";
import type { LivePlay, PoolChoice, PoolRow } from "./lib/types";
import { applyAppearance } from "./ui/theme";
import { icon, injectIconSprite } from "./ui/icons";
import { initControls, openMenu, type MenuEntry } from "./ui/controls";
import { t, tn } from "./lib/i18n";

const root = document.getElementById("companion")!;
let plays: LivePlay[] = [];
let start = Date.now();
let choices: PoolChoice[] = [];
let pool: PoolRow[] = [];
/** the pool menu is open: the window is taller than the panel for it */
let menuOpen = false;
/** room above the panel for the pool menu */
const MENU_ROOM = 320;

async function boot(): Promise<void> {
  try {
    loadPrefs(await api.getSettings());
  } catch (e) {
    console.warn("[companion]", asApiError(e).message);
  }
  applyAppearance();
  injectIconSprite();
  initControls();
  root.addEventListener("click", (e) => click(e.target as Element));
  const hint = document.createElement("div");
  hint.className = "cmp-hint";
  hint.textContent = t("Hold Ctrl to click");
  document.body.append(hint);
  void listen<boolean>("companion-through", (e) => document.body.classList.toggle("through", e.payload));
  // no webview menu here either
  window.addEventListener("contextmenu", (e) => e.preventDefault());
  await refresh();
  void onLivePlay(() => void refresh());
  // relative times and the session's end (an hour without a play)
  setInterval(() => void refresh(), 60_000);
}

async function refresh(): Promise<void> {
  const now = Date.now();
  plays = await api.livePlays(now - 24 * 3600_000).catch(() => []);
  start = sessionStart(plays, now);
  plays = plays.filter((p) => p.date >= start - 1);
  choices = await api.poolChoices().catch(() => []);
  const id = store.prefs.companionPool;
  pool = id && choices.some((c) => c.id === id) ? await api.poolRows(id, start).catch(() => []) : [];
  render();
}

function render(): void {
  const s = summary(plays);
  const last = plays[0];
  root.innerHTML = `
    <header class="cmp-bar" data-tauri-drag-region>
      <span class="cmp-brand" data-tauri-drag-region>${t("This session")}</span>
      <button class="icon-btn sm cmp-close" type="button" data-tip="${t("Close")}" aria-label="${t("Close")}">${icon("x")}</button>
    </header>
    <section class="cmp-stats">
      <div><i>${t("Plays")}</i><b class="num">${num(s.plays)}</b></div>
      <div><i>${t("Time")}</i><b class="num">${s.time ? duration(s.time) : "–"}</b></div>
      <div><i>${t("Acc")}</i><b class="num">${s.accuracy === null ? "–" : pct(s.accuracy)}</b></div>
      <div data-tip="${t("New bests")}"><i>${t("Bests")}</i><b class="num">${num(s.bests)}</b></div>
    </section>
    ${last ? lastPlay(last) : `<p class="cmp-empty">${t("Pass a map in osu!lazer and it shows up here.")}</p>`}
    ${poolHtml()}`;
  if (!menuOpen) void fit();
}

/** fits the window to the panel, with `extra` room above it; resolves once the window has its size */
function fit(extra = 0): Promise<void> {
  const height = Math.ceil(root.getBoundingClientRect().height) + extra;
  if (Math.abs(window.innerHeight - height) < 2) return Promise.resolve();
  return new Promise((done) => {
    const timer = setTimeout(done, 300);
    window.addEventListener("resize", () => (clearTimeout(timer), done()), { once: true });
    void api.fitCompanion(height);
  });
}

function lastPlay(p: LivePlay): string {
  const g = rankInfo(rankNumber(p.rank));
  const delta = p.bestBefore === null ? null : p.accuracy - p.bestBefore;
  const mods = playMods(p);
  const best = isBest(p);
  return `
    <button class="cmp-last" type="button" data-id="${esc(p.id)}" data-tip="${t("Open the score in Fumen")}">
      <span class="cmp-grade" style="--c:${g.color}">${g.label}</span>
      <span class="cmp-last-text">
        <b>${esc(p.title ?? p.md5)}</b>
        <span>${esc([p.version ? `[${p.version}]` : "", mods].filter(Boolean).join(" "))}</span>
      </span>
      <span class="cmp-last-acc">
        <b class="num">${pct(p.accuracy)}</b>
        <span class="num${best ? " up" : ""}">${delta === null ? t("First pass") : best ? `+${pct(delta)}` : `−${pct(-delta)}`}</span>
      </span>
    </button>`;
}

function poolHtml(): string {
  const id = store.prefs.companionPool;
  const choice = choices.find((c) => c.id === id);
  const head = `
    <div class="cmp-pool-head">
      <span class="label-caps">${t("Pool")}</span>
      <button class="cmp-pick" type="button">${esc(choice?.name ?? t("Pick a collection"))}${icon("chevron-down")}</button>
    </div>`;
  if (!choice) return `<section class="cmp-pool">${head}<p class="cmp-empty">${t("Pick a collection to work through it: each difficulty is ticked off once you pass it this session.")}</p></section>`;
  const done = pool.filter((r) => r.plays > 0).length;
  return `
    <section class="cmp-pool">
      ${head}
      <div class="cmp-pool-sub num">${t("{done} of {n} passed this session", { done: num(done), n: num(pool.length) })}</div>
      <div class="cmp-pool-rows">${pool
        .map(
          (r) => `
        <div class="cmp-row${r.plays ? " done" : ""}${r.map ? "" : " missing"}">
          <span class="cmp-tick">${r.plays ? icon("check") : ""}</span>
          <span class="cmp-row-text"><b>${esc(r.title ?? t("Not in the library"))}</b><span>${esc(r.version ?? "")}</span></span>
          ${r.stars !== null ? srChip(r.stars, "sm") : ""}
          <span class="cmp-row-acc num" data-tip="${r.best !== null ? t("Best ever {acc}", { acc: pct(r.best) }) : t("No pass yet")}">${r.bestNow !== null ? pct(r.bestNow) : r.best !== null ? `<i>${pct(r.best)}</i>` : "–"}</span>
        </div>`,
        )
        .join("")}</div>
    </section>`;
}

function click(target: Element): void {
  if (target.closest(".cmp-close")) {
    void emitTo("main", "companion-closed").finally(() => void api.closeCompanion());
    return;
  }
  const last = target.closest<HTMLElement>(".cmp-last");
  if (last) {
    void emitTo("main", "show-score", last.dataset.id).then(() => api.showMain());
    return;
  }
  const pick = target.closest<HTMLElement>(".cmp-pick");
  if (pick) {
    const entries: MenuEntry[] = [];
    const groups: [PoolChoice["source"], string][] = [
      ["fumen", t("Your collections")],
      ["lazer", t("In osu!lazer")],
      ["stable", t("In osu!stable")],
    ];
    for (const [source, label] of groups) {
      const list = choices.filter((c) => c.source === source);
      if (!list.length) continue;
      entries.push({ group: label });
      for (const c of list) {
        entries.push({
          label: c.name,
          hint: tn(c.count, "{n} map", "{n} maps"),
          radio: "pool",
          checked: c.id === store.prefs.companionPool,
          action: () => {
            setPrefs({ companionPool: c.id });
            void refresh();
          },
        });
      }
    }
    if (!entries.length) entries.push({ label: t("No collections yet"), disabled: true });
    menuOpen = true;
    void fit(MENU_ROOM).then(() =>
      openMenu(pick, entries, {
        minWidth: 220,
        onClose: () => {
          menuOpen = false;
          void fit();
        },
      }),
    );
  }
}

void boot();
