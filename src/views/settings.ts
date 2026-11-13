/* settings.ts — osu! account, library source, appearance, about. The categories in a list beside
 * them, one shown at a time; the search goes through all of them. Adjacent rows merge into one
 * group. */
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { api, asApiError, isLinux, isMac, isTauri } from "../lib/api";
import { openUrl } from "@tauri-apps/plugin-opener";
import { follow } from "../lib/tosu-follow";
import { heart, type HeartDevice } from "../lib/heart";
import { lang, LANGS, switchLang, t, tn } from "../lib/i18n";
import { esc, fixed, MODE_LABEL, num, relativeTime } from "../lib/format";
import { collectionEvents, fumenCollections, loadCollections, putIntoLazer, saveCollectionDb } from "../lib/collections";
import { syncHistory } from "../lib/history";
import { canUpdate, checkForUpdate, downloadText, installUpdate, updateEvents, updateState } from "../lib/updater";
import { describeScan, isScanning, runScan } from "../lib/scan";
import { DEFAULT_ACCENT, events, flushPrefs, refreshStatus, setPrefs, store } from "../lib/store";
import type { OsuAccount, UiPrefs } from "../lib/types";
import { attachSegIndicator, openMenu, toast, uiConfirm, uiPrompt } from "../ui/controls";
import { importSets, openImport } from "./import";
import { icon, type IconName } from "../ui/icons";
import type { SettingsSection } from "../lib/router";
import { ACCENT_PRESETS, applyAppearance } from "../ui/theme";
import { openChangelog } from "./changelog";
import { player } from "../player";
import { openHudEditor } from "./hud-editor";
import { cue, newSession } from "./obs-feed";
import { mountObsSettings } from "./obs-settings";
import { overlayEvents, overlayPort, startOverlay, stopOverlay, syncKeys } from "./overlay";

// the osu! login outlives the view: it waits for the browser while you look elsewhere
let account: OsuAccount | null = null;
let accountKnown = false;
let waiting = false;
let shown: SettingsView | null = null;

const MODE_INDEX = { osu: 0, taiko: 1, fruits: 2, mania: 3 } as const;

/** the categories, in the list's order */
const SECTIONS: { id: SettingsSection; icon: IconName; label: () => string }[] = [
  { id: "osu", icon: "user", label: () => "osu!" },
  { id: "library", icon: "library", label: () => t("Library") },
  { id: "collections", icon: "collection", label: () => t("Collections") },
  { id: "appearance", icon: "sun", label: () => t("Appearance") },
  { id: "listening", icon: "music", label: () => t("Listening") },
  { id: "play", icon: "play", label: () => t("While you play") },
  { id: "stream", icon: "radar", label: () => t("Stream & OBS") },
  { id: "about", icon: "info", label: () => t("About") },
];

/** the category open last (Settings opens there again while Fumen runs) */
let lastSection: SettingsSection = "osu";

/** lower case without accents, for the search ("uber" finds "Über") */
const norm = (s: string): string =>
  s
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");

/** Logs in through the browser (from here or elsewhere); the scores from osu! follow. */
export async function loginWithOsu(): Promise<void> {
  if (waiting) return;
  waiting = true;
  shown?.renderAccount();
  try {
    account = await api.osuLogin();
    accountKnown = true;
    toast(t("Logged in as {name}", { name: account.username }), { kind: "success" });
    void syncHistory().then((res) => {
      if (!res.ok) toast(t("Couldn't read your scores from osu!: {error}", { error: res.error.message }), { kind: "danger", timeout: 6000 });
    });
  } catch (e) {
    const err = asApiError(e);
    if (err.code !== "login-cancelled") toast(err.message, { kind: "danger", timeout: 6000 });
  } finally {
    waiting = false;
    shown?.renderAccount();
  }
}

/** a signal's strength in words, from dBm */
const signal = (rssi: number): string => (rssi >= -60 ? t("strong") : rssi >= -75 ? t("good") : t("weak"));

/** "Off", or seconds */
const fadeLabel = (v: number): string => (v > 0 ? t("{s} s", { s: fixed(v, 1) }) : t("Off"));

/** A setting row with a 0–5 s slider (prefs fadeIn / fadeOut, in tenths on the slider). */
function fadeRow(key: "fadeIn" | "fadeOut", title: string, desc: string, v: number): string {
  return `
    <div class="setting-row">
      <div class="setting-text">
        <div class="setting-title">${title}</div>
        <div class="setting-desc">${desc}</div>
      </div>
      <div class="setting-range">
        <input type="range" data-fade="${key}" min="0" max="50" step="1" value="${Math.round(v * 10)}" style="--pct:${(v / 5) * 100}%" aria-label="${title}" />
        <b class="num s-fade-val">${fadeLabel(v)}</b>
      </div>
    </div>`;
}

export class SettingsView {
  readonly el: HTMLElement;
  private offs: (() => void)[] = [];
  private version = "";
  private section: SettingsSection;
  /** the search's words (none: one category shown) */
  private words: string[] = [];
  private filterQueued = false;

  constructor(section?: SettingsSection) {
    this.el = document.createElement("section");
    this.el.className = "view settings-view";
    this.section = section ?? lastSection;
    this.render();
    this.show(this.section);
    this.wireSearch();
    this.offs.push(
      events.on("status", () => this.renderLibrary()),
      events.on("scan", () => this.renderLibrary()),
      updateEvents.on("change", () => this.renderUpdate()),
      collectionEvents.on("collections", () => this.renderCollections()),
      follow.bus.on("status", () => void this.renderTosu()),
      overlayEvents.on("change", () => this.renderObs()),
      heart.bus.on("status", () => this.renderHeart()),
      heart.bus.on("reading", () => this.renderPulse()),
    );
    // tosu comes and goes on its own
    const tosuTimer = window.setInterval(() => void this.renderTosu(), 3000);
    this.offs.push(() => clearInterval(tosuTimer));
    this.el.addEventListener("click", (e) => void this.onClick(e));
    shown = this;
    void this.loadAccount();
    this.el.addEventListener("change", (e) => this.onChange(e));
    this.el.addEventListener("input", (e) => {
      const input = e.target as HTMLInputElement;
      const key = input.dataset.fade as "fadeIn" | "fadeOut" | undefined;
      if (!key) return;
      const v = +input.value / 10;
      setPrefs({ [key]: v } as Pick<UiPrefs, typeof key>);
      input.parentElement!.querySelector(".s-fade-val")!.textContent = fadeLabel(v);
    });
    getVersion()
      .then((v) => {
        this.version = v;
        const el = this.el.querySelector(".about-version");
        if (el) el.textContent = `Fumen ${v}`;
      })
      .catch(() => {});
  }

  private render(): void {
    const p = store.prefs;
    const head = (id: SettingsSection): string => `<h2 class="settings-title">${SECTIONS.find((s) => s.id === id)!.label()}</h2>`;
    this.el.innerHTML = `
      <div class="settings">
        <header class="view-head"><div><h1 class="view-title">${t("Settings")}</h1></div></header>
        <div class="settings-body">
        <nav class="settings-nav" aria-label="${t("Settings")}">
          <label class="settings-search">${icon("search")}<input type="search" spellcheck="false" placeholder="${t("Search settings")}" aria-label="${t("Search settings")}" /></label>
          <div class="settings-nav-list" role="tablist" aria-orientation="vertical">
            ${SECTIONS.map(
              (s) =>
                `<button type="button" class="set-nav-item" role="tab" data-goto="${s.id}" aria-selected="false">${icon(s.icon)}<span class="set-nav-label">${s.label()}</span><span class="set-nav-count num"></span></button>`,
            ).join("")}
          </div>
        </nav>
        <div class="settings-pages">

        <section class="settings-section" data-section="osu" role="tabpanel">
          ${head("osu")}
          <div class="setting-row" data-row="account"></div>
        </section>

        <section class="settings-section" data-section="library" role="tabpanel">
          ${head("library")}
          <div class="setting-row" data-row="path"></div>
          <div class="setting-row" data-row="stable"></div>
          <div class="setting-row" data-row="library"></div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-title">${t("Keep up to date")}</div>
              <div class="setting-desc">${t("Re-import when osu!lazer's or osu!stable's library changed since the last import.")}</div>
            </div>
            <input type="checkbox" role="switch" data-setting="autoRescan" ${store.settings?.autoRescan !== false ? "checked" : ""} />
          </div>
        </section>

        <section class="settings-section" data-section="collections" role="tabpanel">
          ${head("collections")}
          <div class="setting-row" data-row="collections"></div>
          <div class="setting-row" data-row="cloud">
            <div class="setting-text">
              <div class="setting-title">${t("Collections in the cloud")}</div>
              <div class="setting-desc">${t("Every collection (Fumen's, smart ones, osu!lazer's and osu!stable's) kept on Fumen's server under your osu! login. On another PC, Get them merges them in by name and downloads the sets you don't have.")}</div>
            </div>
            <div class="setting-actions">
              <button class="btn btn-sm s-cloud-pull" type="button">${icon("download")}${t("Get them")}</button>
              <button class="btn btn-sm s-cloud-push" type="button">${icon("arrow-up")}${t("Save to the cloud")}</button>
            </div>
          </div>
        </section>

        <section class="settings-section" data-section="appearance" role="tabpanel">
          ${head("appearance")}
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-title">${t("Language")}</div>
              <div class="setting-desc">${t("Fumen's window starts again in it.")}</div>
            </div>
            <div class="seg-pill" data-seg="lang">
              ${LANGS.map((l) => `<button type="button" data-v="${l.id}" class="${lang === l.id ? "active" : ""}" lang="${l.id}">${l.label}</button>`).join("")}
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text"><div class="setting-title">${t("Theme")}</div></div>
            <div class="seg-pill" data-seg="theme">
              <button type="button" data-v="dark" class="${p.theme === "dark" ? "active" : ""}">${t("Dark")}</button>
              <button type="button" data-v="oled" class="${p.theme === "oled" ? "active" : ""}">OLED</button>
              <button type="button" data-v="light" class="${p.theme === "light" ? "active" : ""}">${t("Light")}</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-title">${t("Accent colour")}</div>
              <div class="setting-desc">${t("\"From artwork\" picks it up from the background of what you're looking at or listening to.")}</div>
            </div>
            <div class="seg-pill" data-seg="accentMode">
              <button type="button" data-v="dynamic" class="${p.accentMode === "dynamic" ? "active" : ""}">${t("From artwork")}</button>
              <button type="button" data-v="fixed" class="${p.accentMode === "fixed" ? "active" : ""}">${t("Fixed")}</button>
            </div>
          </div>
          <div class="setting-row setting-swatches"${p.accentMode === "fixed" ? "" : " hidden"}>
            <div class="setting-text"><div class="setting-title">${t("Fixed colour")}</div></div>
            <div class="swatches">
              ${ACCENT_PRESETS.map((a) => `<button type="button" class="swatch${p.accent === a.color ? " active" : ""}" data-accent="${a.color}" style="--c:${a.color}" data-tip="${a.label}"></button>`).join("")}
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-title">${t("Ambient background")}</div>
              <div class="setting-desc">${t("A soft, blurred version of the current artwork behind the app.")}</div>
            </div>
            <input type="checkbox" role="switch" data-pref="ambient" ${p.ambient ? "checked" : ""} />
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-title">${t("Original-language metadata")}</div>
              <div class="setting-desc">${t("Show titles and artists in their original script (e.g. Japanese) when available.")}</div>
            </div>
            <input type="checkbox" role="switch" data-pref="unicode" ${p.unicode ? "checked" : ""} />
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-title">${t("Reduce motion")}</div>
              <div class="setting-desc">${t("Turns off transitions and animations.")}</div>
            </div>
            <input type="checkbox" role="switch" data-pref="reduceMotion" ${p.reduceMotion ? "checked" : ""} />
          </div>
        </section>

        <section class="settings-section" data-section="listening" role="tabpanel">
          ${head("listening")}
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-title">${t("Skip the silence at the start")}</div>
              <div class="setting-desc">${t("A song starts where its sound does, not in the quiet before it.")}</div>
            </div>
            <input type="checkbox" role="switch" data-pref="skipSilence" aria-label="${t("Skip the silence at the start")}" ${p.skipSilence ? "checked" : ""} />
          </div>
          ${fadeRow("fadeIn", t("Fade in"), t("How softly a song comes in after another one."), p.fadeIn)}
          ${fadeRow("fadeOut", t("Fade out"), t("How softly a song goes before the next one: at its end, and when you skip it."), p.fadeOut)}
        </section>

        <section class="settings-section" data-section="play" role="tabpanel">
          ${head("play")}
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-title">${t("Show the score after a play")}</div>
              <div class="setting-desc">${t("When you pass a map in osu!lazer, Fumen opens its score: where the accuracy went, the timing, the replay. Only while Fumen isn't the window in front; otherwise it offers it.")}</div>
            </div>
            <input type="checkbox" role="switch" data-pref="scoreAuto" aria-label="${t("Show the score after a play")}" ${p.scoreAuto ? "checked" : ""} />
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-title">${t("Companion window")}</div>
              <div class="setting-desc">${t("A small window in the corner, on top of the game: this session, your last play and a pool to work through. It shows over osu!lazer in borderless or windowed mode. With the cursor over it, clicks go through to the game; hold Ctrl to click it.")}</div>
            </div>
            <input type="checkbox" role="switch" data-pref-companion aria-label="${t("Companion window")}" ${p.companion ? "checked" : ""} />
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-title">${t("Follow osu!")}</div>
              <div class="setting-desc">${t("With tosu (tosu.app) running next to osu!, Fumen plays along with what osu! plays, without sound. The visualizer opens when you start a map, and a pass in osu!lazer opens its score.")}</div>
            </div>
            <input type="checkbox" role="switch" data-pref="followOsu" aria-label="${t("Follow osu!")}" ${p.followOsu ? "checked" : ""} />
          </div>
          <div class="setting-row" data-row="tosu" hidden></div>
          <div class="setting-row" data-row="tosu-auto" hidden>
            <div class="setting-text">
              <div class="setting-title">${t("Start tosu with osu!")}</div>
              <div class="setting-desc">${t("When osu! runs and tosu doesn't, Fumen starts it in the background.")}</div>
            </div>
            <input type="checkbox" role="switch" data-pref="tosuAutostart" aria-label="${t("Start tosu with osu!")}" ${p.tosuAutostart ? "checked" : ""} />
          </div>
          <div class="setting-row" data-row="heart"></div>
        </section>

        <section class="settings-section" data-section="stream" role="tabpanel">
          ${head("stream")}
          <div class="label-caps settings-sub">${t("Browser sources")}</div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-title">${t("Sources for OBS")}</div>
              <div class="setting-desc">${t("Pages for OBS's browser sources, from this PC only and while Fumen runs. In OBS: Sources, +, Browser, the address below, 1920 × 1080.")}</div>
            </div>
            <input type="checkbox" role="switch" data-obs="serve" aria-label="${t("Sources for OBS")}" ${overlayPort() ? "checked" : ""} />
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-title">${t("Keys for the live overlay")}</div>
              <div class="setting-desc">${t("The live overlay's key part shows the keys you play with. For that Fumen reads the keyboard, but only the keys osu!lazer has you play with and only while osu! is the window in front. Nothing of it is kept.")}</div>
            </div>
            <input type="checkbox" role="switch" data-obs="keys" aria-label="${t("Keys for the live overlay")}" ${store.prefs.obs?.keys === true ? "checked" : ""} />
          </div>
          <div class="obs-sources" data-row="obs-sources"></div>
          <div class="label-caps settings-sub">${t("OBS itself")}</div>
          <div class="obs-link" data-row="obs-link"></div>
        </section>

        <section class="settings-section" data-section="about" role="tabpanel">
          ${head("about")}
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-title about-version">Fumen ${esc(this.version)}</div>
              <div class="setting-desc">${t("Fumen reads osu!lazer's database from a private copy. Beatmaps and collections you put into lazer go in through lazer's own code: while lazer is closed only on versions tested with Fumen and with a backup of its database first, while it's open beatmaps are handed to lazer, which adds them itself.")}</div>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-title">${t("Changelog")}</div>
              <div class="setting-desc">${t("What each update added or changed.")}</div>
            </div>
            <button class="btn s-changelog" type="button">${t("Open")}</button>
          </div>
          <div class="setting-row" data-row="update"></div>
          ${
            isLinux
              ? `<div class="setting-row">
            <div class="setting-text">
              <div class="setting-title">${t("Inspector")}</div>
              <div class="setting-desc">${t("WebKit's developer tools. Its Timelines show what makes Fumen slow on this PC.")}</div>
            </div>
            <button class="btn s-inspector" type="button">${t("Open")}</button>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-title">${t("Render test")}</div>
              <div class="setting-desc">${t("A plain moving canvas in Fumen's window with its frames per second, the same as the test page on fumen.dertesti.dev, with or without the song that's loaded. Back to Fumen with the button at the top.")}</div>
            </div>
            <button class="btn s-render-test" type="button">${t("Open")}</button>
          </div>`
              : ""
          }
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-title">${t("Count me in")}</div>
              <div class="setting-desc">${t("When Fumen starts, it tells fumen.dertesti.dev that it did: a random number made on this PC and Fumen's version, nothing else. That's how many people use it.")}</div>
            </div>
            <input type="checkbox" role="switch" data-setting="startPing" aria-label="${t("Count me in")}" ${store.settings?.startPing !== false ? "checked" : ""} />
          </div>
        </section>
        <p class="settings-empty" hidden></p>
        </div>
        </div>
      </div>`;
    this.el.querySelectorAll<HTMLElement>(".seg-pill").forEach((s) => attachSegIndicator(s));
    this.renderLibrary();
    this.renderCollections();
    this.renderAccount();
    this.renderUpdate();
    void this.renderTosu();
    this.renderHeart();
    this.renderObs();
    const link = this.el.querySelector<HTMLElement>('[data-row="obs-link"]');
    if (link) this.offs.push(mountObsSettings(link));
  }

  /** Shows one category (the search, if any, goes). */
  private show(id: SettingsSection): void {
    this.section = lastSection = id;
    const input = this.el.querySelector<HTMLInputElement>(".settings-search input");
    if (input && input.value) {
      input.value = "";
      this.words = [];
      this.filter();
    }
    for (const s of this.el.querySelectorAll<HTMLElement>(".settings-section")) s.classList.toggle("on", s.dataset.section === id);
    for (const b of this.el.querySelectorAll<HTMLElement>(".set-nav-item")) {
      const on = b.dataset.goto === id;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    }
  }

  /** The search: as you type, Ctrl+F (or /) to get there while Settings is open. */
  private wireSearch(): void {
    const input = this.el.querySelector<HTMLInputElement>(".settings-search input")!;
    input.addEventListener("input", () => {
      this.words = norm(input.value).split(/\s+/).filter(Boolean);
      this.filter();
    });
    input.addEventListener("keydown", (e) => {
      // Enter: to the category of the first match
      if (e.key !== "Enter" || !this.words.length) return;
      const first = this.el.querySelector<HTMLElement>(".settings-section:not(.s-miss)");
      if (first?.dataset.section) this.show(first.dataset.section as SettingsSection);
    });
    const keys = (e: KeyboardEvent): void => {
      if (!this.el.isConnected || this.el.hidden || document.querySelector(".modal-backdrop")) return;
      const typing = (e.target as HTMLElement).closest("input, textarea, [contenteditable]");
      if (((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "f") || (e.key === "/" && !typing)) {
        e.preventDefault();
        e.stopPropagation();
        input.focus();
        input.select();
      }
    };
    window.addEventListener("keydown", keys, true);
    this.offs.push(() => window.removeEventListener("keydown", keys, true));
    // rows drawn again (the library, tosu, OBS) are searched again
    const pages = this.el.querySelector<HTMLElement>(".settings-pages")!;
    const watch = new MutationObserver(() => {
      if (!this.words.length || this.filterQueued) return;
      this.filterQueued = true;
      queueMicrotask(() => {
        this.filterQueued = false;
        this.filter();
      });
    });
    for (const s of pages.querySelectorAll(".settings-section")) watch.observe(s, { childList: true, subtree: true });
    this.offs.push(() => watch.disconnect());
  }

  /** Every category's rows that have all the search's words (a category's name brings all of it). */
  private filter(): void {
    const words = this.words;
    const searching = words.length > 0;
    const has = (text: string): boolean => words.every((w) => text.includes(w));
    this.el.querySelector(".settings")!.classList.toggle("searching", searching);
    let total = 0;
    for (const sec of this.el.querySelectorAll<HTMLElement>(".settings-section")) {
      const whole = searching && has(norm(sec.querySelector(".settings-title")?.textContent ?? ""));
      let found = 0;
      let before = false;
      for (const row of sec.querySelectorAll<HTMLElement>(".setting-row, .obs-source")) {
        // a row of controls without a title of its own belongs to the one above it
        const match: boolean = !searching || whole || (row.querySelector(".setting-title") ? has(norm(row.textContent ?? "")) : before);
        row.classList.toggle("s-miss", !match);
        before = match;
        if (match && !row.hidden) found++;
      }
      sec.classList.toggle("s-miss", searching && !found);
      total += found;
      const nav = this.el.querySelector<HTMLElement>(`.set-nav-item[data-goto="${sec.dataset.section}"]`);
      if (nav) {
        nav.classList.toggle("none", searching && !found);
        const count = nav.querySelector(".set-nav-count")!;
        const text = searching && found ? String(found) : "";
        if (count.textContent !== text) count.textContent = text;
      }
    }
    const empty = this.el.querySelector<HTMLElement>(".settings-empty")!;
    empty.hidden = !searching || total > 0;
    const said = searching ? t("No setting matches “{q}”.", { q: this.el.querySelector<HTMLInputElement>(".settings-search input")!.value.trim() }) : "";
    if (empty.textContent !== said) empty.textContent = said;
  }

  /** The OBS pages: each with its address while the server is on, and what can be done with it. */
  private renderObs(): void {
    const el = this.el.querySelector<HTMLElement>('[data-row="obs-sources"]');
    if (!el) return;
    const port = overlayPort();
    const sw = this.el.querySelector<HTMLInputElement>('[data-obs="serve"]');
    if (sw) sw.checked = !!port;
    const base = port ? `http://127.0.0.1:${port}/obs/` : "";
    const source = (name: string, desc: string, path: string, actions = ""): string => `
      <div class="obs-source">
        <div class="setting-text">
          <div class="setting-title">${name}</div>
          <div class="setting-desc">${desc}</div>
          ${port ? `<div class="ov-url obs-url"><code>${esc(base + path)}</code><button class="icon-btn sm" type="button" data-copy="${esc(base + path)}" aria-label="${t("Copy")}" data-tip="${t("Copy")}">${icon("copy")}</button></div>` : ""}
        </div>
        ${actions ? `<div class="setting-actions">${actions}</div>` : ""}
      </div>`;
    el.innerHTML = [
      source(t("Visualizer"), t("The visualizer as in Fumen, answering the play, while a map runs. With ?bg=none at the end of the address the game shows through it, with ?idle=1 it stays on in song select and for Fumen's player."), "stage"),
      source(
        t("Live overlay"),
        t("Over the game: progress, combo, accuracy, pp, health, and what your tries before mean. Each part goes where your skin leaves room."),
        "hud",
        `<button class="btn btn-sm" type="button" data-obs-act="arrange">${icon("sliders")}${t("Arrange")}</button>`,
      ),
      source(
        t("Song card"),
        t("For a few seconds when a map starts: cover, title, mapper, stars, BPM, length, your best."),
        "card",
        port ? `<button class="btn btn-sm btn-ghost" type="button" data-obs-act="card">${t("Show now")}</button>` : "",
      ),
      source(
        t("Session card"),
        t("For a break or the end: tries, passes, your best plays, the map that cost the most, every try on one line."),
        "session",
        port ? `<button class="btn btn-sm btn-ghost" type="button" data-obs-act="session">${t("Show now")}</button><button class="btn btn-sm btn-ghost" type="button" data-obs-act="new-session">${t("New session")}</button>` : "",
      ),
    ].join("");
  }

  /** Where tosu is and whether it runs, under Follow osu! (while that's on). */
  /** the heart rate monitors the last search found (null: none made, or one picked since) */
  private heartFound: HeartDevice[] | null = null;
  private heartSearching = false;
  private heartError: string | null = null;

  /** The heart rate monitor: the one used and how it's going, or a search for one. */
  private renderHeart(): void {
    const row = this.el.querySelector<HTMLElement>('[data-row="heart"]');
    if (!row) return;
    const picked = store.prefs.heart?.id ? store.prefs.heart : null;
    const s = heart.status;
    const name = esc(s.name ?? picked?.name ?? "");
    let desc: string;
    if (!picked)
      desc = t("A Bluetooth chest strap or watch that shares your pulse, like Moofit's, Polar's or Garmin's. Fumen keeps your pulse with every try at a map and shows it after the play and in History. The live overlay can show it too.");
    else if (s.state === "on")
      desc = `<span class="s-tosu-on">${t("Connected")}</span> · ${name} · <span class="s-heart-now">${this.pulseText()}</span>${s.battery !== null ? ` · ${t("Battery {n} %", { n: s.battery })}` : ""}`;
    else if (s.state === "lost")
      desc = `${t("{name} isn't there right now. Fumen keeps trying.", { name })}${s.message ? `<br><span class="setting-path">${esc(s.message)}</span>` : ""}`;
    else desc = t("Connecting to {name}…", { name });
    const found = this.heartFound;
    let list = "";
    if (this.heartError) list = `<p class="heart-note is-missing">${esc(this.heartError)}</p>`;
    else if (found && !found.length)
      list = `<p class="heart-note">${t("Nothing found. Is it on and worn? A strap shares its pulse with one app at a time, so close its own app on your phone first.")}</p>`;
    else if (found)
      list = `<div class="heart-devs">${found
        .map((d, i) => `<button type="button" class="heart-dev" data-heart="${i}">${icon("heart")}<span>${esc(d.name)}</span>${d.rssi !== null ? `<small>${signal(d.rssi)}</small>` : ""}</button>`)
        .join("")}</div>`;
    const search = this.heartSearching
      ? `<button class="btn btn-sm" type="button" disabled>${t("Searching…")}</button>`
      : `<button class="btn btn-sm s-heart-search" type="button">${icon("search")}${picked ? t("Another device") : t("Search")}</button>`;
    row.innerHTML = `
      <div class="setting-text">
        <div class="setting-title">${t("Heart rate monitor")}</div>
        <div class="setting-desc">${desc}</div>
        ${list}
      </div>
      <div class="setting-actions">
        ${search}
        ${picked ? `<button class="btn btn-ghost btn-sm s-heart-forget" type="button">${t("Remove")}</button>` : ""}
      </div>`;
  }

  /** The pulse now, in words. */
  private pulseText(): string {
    const bpm = heart.bpm;
    if (bpm !== null) return `${icon("heart-fill")}<b class="num">${bpm}</b> bpm`;
    return heart.last?.contact === false ? t("Not touching skin") : t("No pulse yet");
  }

  /** A reading came: only the number changes. */
  private renderPulse(): void {
    const el = this.el.querySelector<HTMLElement>(".s-heart-now");
    if (el) el.innerHTML = this.pulseText();
  }

  private async heartSearch(): Promise<void> {
    this.heartSearching = true;
    this.heartError = null;
    this.renderHeart();
    try {
      this.heartFound = await api.heartScan();
    } catch (e) {
      this.heartFound = null;
      this.heartError = asApiError(e).message;
    } finally {
      this.heartSearching = false;
      this.renderHeart();
    }
  }

  private async renderTosu(): Promise<void> {
    const row = this.el.querySelector<HTMLElement>('[data-row="tosu"]');
    const auto = this.el.querySelector<HTMLElement>('[data-row="tosu-auto"]');
    if (!row || !auto) return;
    const on = store.prefs.followOsu;
    row.hidden = auto.hidden = !on;
    if (!on) return;
    const st = isTauri ? await api.tosuStatus().catch(() => null) : { running: follow.connected, path: null };
    if (!st) return;
    const running = st.running || follow.connected;
    const where = st.path ? `<br><span class="setting-path">${esc(st.path)}</span>` : "";
    const desc = running
      ? `<span class="s-tosu-on">${t("Running")}</span>${follow.connected ? ` · ${t("Fumen hears it")}` : ""}${where}`
      : st.path
        ? `${t("Not running. It starts with osu! when that's on below, or start it now.")}${where}`
        : t("Not found. tosu is a free app that reads osu! while it runs, made for stream overlays. Get it from tosu.app, unzip it anywhere and pick tosu.exe here; Fumen remembers it.");
    const html = `
      <div class="setting-text">
        <div class="setting-title">tosu</div>
        <div class="setting-desc">${desc}</div>
      </div>
      <div class="setting-actions">
        ${st.path || running ? "" : `<button class="btn btn-ghost btn-sm s-tosu-get" type="button">${icon("external")}${t("Get tosu")}</button>`}
        ${!running && st.path ? `<button class="btn btn-sm s-tosu-start" type="button">${icon("play")}${t("Start")}</button>` : ""}
        <button class="btn btn-sm s-tosu-pick" type="button">${icon("folder")}${st.path ? t("Change") : t("Pick tosu.exe")}</button>
      </div>`;
    // the poll rewrites only when something changed (a hovered button stays put)
    if (row.dataset.html !== html) {
      row.dataset.html = html;
      row.innerHTML = html;
    }
  }

  private renderUpdate(): void {
    const row = this.el.querySelector<HTMLElement>('[data-row="update"]');
    if (!row) return;
    const s = updateState();
    let desc = t("Fumen looks for updates when it starts and every few hours. Installing one restarts it.");
    let control = `<button class="btn s-update-check" type="button">${t("Check for updates")}</button>`;
    if (!canUpdate) {
      desc = isLinux
        ? t("On Linux, Fumen doesn't update itself yet: install it again the way you did (the AppImage, the .deb or the Arch command from fumen.dertesti.dev).")
        : t("On macOS, Fumen doesn't update itself yet: new versions are on fumen.dertesti.dev.");
      control = "";
    } else if (s.phase === "checking") control = `<button class="btn" type="button" disabled>${t("Checking…")}</button>`;
    else if (s.phase === "current") desc = t("You have the latest version (checked {when}).", { when: relativeTime(s.at) });
    else if (s.phase === "available") {
      desc = t("Fumen {version} is out. Installing it restarts Fumen.", { version: esc(s.version) });
      control = `<button class="btn btn-primary s-update-install" type="button">${icon("download")}<span>${t("Update to {version}", { version: esc(s.version) })}</span></button>`;
    } else if (s.phase === "downloading") {
      desc = t("Downloading Fumen {version}…", { version: esc(s.version) });
      control = `<button class="btn" type="button" disabled>${downloadText(s)}</button>`;
    } else if (s.phase === "installing") {
      desc = t("Installing Fumen {version}. Fumen closes for a moment and opens again.", { version: esc(s.version) });
      control = `<button class="btn" type="button" disabled>${t("Installing…")}</button>`;
    } else if (s.phase === "error") {
      desc = esc(s.message);
      control = s.version
        ? `<button class="btn btn-primary s-update-install" type="button">${icon("download")}<span>${t("Try again")}</span></button>`
        : `<button class="btn s-update-check" type="button">${t("Try again")}</button>`;
    }
    row.innerHTML = `
      <div class="setting-text">
        <div class="setting-title">${t("Updates")}</div>
        <div class="setting-desc${s.phase === "error" ? " is-error" : ""}">${desc}</div>
      </div>
      ${control}`;
  }

  private async loadAccount(): Promise<void> {
    try {
      // what's stored first, then osu!'s current numbers
      account = await api.osuAccount();
      accountKnown = true;
      this.renderAccount();
      if (account && !waiting) account = await api.osuRefreshAccount();
    } catch (e) {
      console.warn("[osu] account", asApiError(e).message);
      accountKnown = true;
    }
    this.renderAccount();
  }

  renderAccount(): void {
    const row = this.el.querySelector<HTMLElement>('[data-row="account"]');
    if (!row) return;
    const a = account;
    if (waiting) {
      row.innerHTML = `
        <div class="setting-text">
          <div class="setting-title">${t("osu! account")}</div>
          <div class="setting-desc">${t("Finish logging in on the page that opened in your browser. Fumen picks it up from there.")}</div>
        </div>
        <button class="btn btn-ghost btn-sm s-login-cancel" type="button">${t("Cancel")}</button>`;
    } else if (a) {
      const words = [
        a.rank ? `#${num(a.rank)}` : t("No rank"),
        a.countryRank && a.country ? `#${num(a.countryRank)} ${a.country}` : "",
        a.pp ? `${num(Math.round(a.pp))}pp` : "",
        a.mode ? MODE_LABEL[MODE_INDEX[a.mode]] : "",
      ].filter(Boolean);
      row.innerHTML = `
        <div class="account">
          <span class="account-avatar">${esc(a.username.slice(0, 1).toUpperCase())}${a.avatar ? `<img src="${esc(a.avatar)}" alt="" />` : ""}</span>
          <div class="setting-text">
            <div class="setting-title">${esc(a.username)}</div>
            <div class="setting-desc meta-line num">${words.map((w) => `<span>${esc(w)}</span>`).join("")}</div>
          </div>
        </div>
        <button class="btn btn-ghost btn-sm s-logout" type="button">${t("Log out")}</button>`;
      row.querySelector("img")?.addEventListener("error", (e) => (e.target as HTMLElement).remove());
    } else {
      row.innerHTML = `
        <div class="setting-text">
          <div class="setting-title">${t("osu! account")}</div>
          <div class="setting-desc">${t("Log in to bring your osu! profile and scores into Fumen: pp, top plays and the plays from your other computers, in History. You log in on osu!'s own page; Fumen never sees your password.")}</div>
        </div>
        <button class="btn btn-primary btn-sm s-login" type="button"${accountKnown ? "" : " disabled"}>${t("Log in with osu!")}</button>`;
    }
  }

  private async cloudPush(b: HTMLButtonElement): Promise<void> {
    b.disabled = true;
    try {
      const r = await api.cloudPushCollections();
      toast(tn(r.collections, "{n} collection saved to the cloud", "{n} collections saved to the cloud"), { kind: "success", timeout: 3000 });
    } catch (e) {
      toast(t("Couldn't save them: {error}", { error: asApiError(e).message }), { kind: "danger", timeout: 6000 });
    } finally {
      b.disabled = false;
    }
  }

  private async cloudPull(b: HTMLButtonElement): Promise<void> {
    b.disabled = true;
    try {
      const r = await api.cloudPullCollections();
      await loadCollections();
      const words = [t("{n} from the cloud", { n: num(r.collections) }), r.created ? t("{n} new here", { n: num(r.created) }) : "", r.added ? tn(r.added, "{n} difficulty added", "{n} difficulties added") : ""].filter(Boolean);
      toast(words.join(", "), { kind: "success", timeout: 4000 });
      if (r.missing.length) {
        const ok = await uiConfirm(tn(r.missing.length, "The collections want {n} set this library doesn't have. Fumen downloads it from the mirrors and puts it into osu!lazer.", "The collections want {n} sets this library doesn't have. Fumen downloads them from the mirrors and puts them into osu!lazer."), { title: t("Download the missing sets?"), confirmLabel: t("Download them") });
        if (ok && importSets(r.missing.map((m) => ({ id: m.id, title: t("Set {id}", { id: m.id }) }))) !== "none") openImport();
      }
    } catch (e) {
      toast(t("Couldn't get them: {error}", { error: asApiError(e).message }), { kind: "danger", timeout: 6000 });
    } finally {
      b.disabled = false;
    }
  }

  private renderCollections(): void {
    const row = this.el.querySelector<HTMLElement>('[data-row="collections"]');
    if (!row) return;
    const n = fumenCollections().length;
    row.innerHTML = `
      <div class="setting-text">
        <div class="setting-title">${t("Your collections in osu!")}</div>
        <div class="setting-desc">${n ? tn(n, "Fumen's collection into osu!lazer's (it updates the lazer collection it went into before, or the one with its name), or as a collection.db for osu!stable and Collection Manager. Single ones: right-click them in the sidebar.", "All {n} of Fumen's collections into osu!lazer's (each one updates the lazer collection it went into before, or the one with its name), or as a collection.db for osu!stable and Collection Manager. Single ones: right-click them in the sidebar.") : t("Make a collection in the sidebar first.")}</div>
      </div>
      <div class="setting-actions">
        <button class="btn btn-sm s-cols-db" type="button"${n ? "" : " disabled"}>${icon("download")}${t("Save collection.db…")}</button>
        <button class="btn btn-sm s-cols-lazer" type="button"${n ? "" : " disabled"}>${icon("arrow-right")}${t("Put into osu!lazer")}</button>
      </div>`;
  }

  private renderLibrary(): void {
    const pathRow = this.el.querySelector<HTMLElement>('[data-row="path"]');
    const libRow = this.el.querySelector<HTMLElement>('[data-row="library"]');
    if (!pathRow || !libRow) return;
    const st = store.status;
    const inst = st?.install;
    const custom = !!store.settings?.lazerPath;
    const busy = isScanning();
    const c = st?.counts;
    let state: string;
    if (busy) {
      const { label, fraction } = describeScan(store.scan);
      state = `${label}… ${Math.round(fraction * 100)}%`;
    } else if (st?.scannedAt && c) {
      state = `${tn(c.sets, "{n} set", "{n} sets")}, ${tn(c.maps, "{n} difficulty", "{n} difficulties")}, ${tn(c.scores, "{n} score", "{n} scores")}. ${st.changed ? t("Imported {when}. osu! has changed since then.", { when: relativeTime(st.scannedAt) }) : t("Imported {when}.", { when: relativeTime(st.scannedAt) })}`;
    } else {
      state = t("Not imported yet.");
    }
    pathRow.innerHTML = `
      <div class="setting-text">
        <div class="setting-title">${t("osu!lazer folder")}</div>
        <div class="setting-desc setting-path">${inst ? esc(inst.storage) : `<span class="is-missing">${custom ? t("Not found in the chosen folder") : t("Not found")}</span>`}</div>
      </div>
      <div class="setting-actions">
        ${custom ? `<button class="btn btn-ghost btn-sm s-reset-path" type="button">${t("Use default")}</button>` : ""}
        <button class="btn btn-sm s-pick" type="button">${icon("folder")}${t("Change")}</button>
      </div>`;
    libRow.innerHTML = `
      <div class="setting-text">
        <div class="setting-title">${t("Library")}</div>
        <div class="setting-desc num">${esc(state)}</div>
      </div>
      <button class="btn btn-sm s-rescan" type="button"${busy || !(inst || st?.stable?.install) ? " disabled" : ""}>${icon("refresh")}${t("Import now")}</button>`;

    const stableRow = this.el.querySelector<HTMLElement>('[data-row="stable"]');
    if (!stableRow) return;
    const sst = st?.stable;
    const stableCustom = !!store.settings?.stablePath;
    const on = store.settings?.useStable !== false;
    const sc = sst?.counts;
    const where = sst?.install
      ? `<span class="setting-path">${esc(sst.install.path)}</span>${sc && sst.scannedAt ? `<br>${tn(sc.sets, "{n} set", "{n} sets")}, ${tn(sc.maps, "{n} difficulty", "{n} difficulties")}${sc.scores ? `, ${tn(sc.scores, "{n} play", "{n} plays")}` : ""}. ${t("Ones lazer has too show once.")}` : on ? `<br>${t("Its beatmaps come in with the next import.")}` : ""}`
      : on
        ? `<span class="is-missing">${stableCustom ? t("Not found in the chosen folder") : sst?.defaultPath ? t("Not found in {path}", { path: esc(sst.defaultPath) }) : t("Not found")}</span>`
        : t("Off: only osu!lazer's beatmaps are in the library.");
    const importing = !!store.settings?.stableImport && !!sst?.install;
    stableRow.innerHTML = `
      <div class="setting-text">
        <div class="setting-title">osu!stable</div>
        <div class="setting-desc">${where}${importing ? `<br><span class="is-missing">${t("Add beatmaps can put sets into its Songs folder.")}</span>` : ""}</div>
      </div>
      <div class="setting-actions">
        ${sst?.install ? `<button class="icon-btn sm s-stable-more" type="button" aria-label="${t("More")}">${icon("more-vert")}</button>` : ""}
        ${stableCustom ? `<button class="btn btn-ghost btn-sm s-stable-reset" type="button">${t("Use default")}</button>` : ""}
        <button class="btn btn-sm s-stable-pick" type="button">${icon("folder")}${t("Change")}</button>
        <input type="checkbox" role="switch" data-setting="useStable" aria-label="${t("Use osu!stable's beatmaps")}" ${on ? "checked" : ""} />
      </div>`;
  }

  /** stable's hidden menu: imports into osu!stable, the one place Fumen writes into stable's files */
  private stableMenu(anchor: HTMLElement): void {
    const on = !!store.settings?.stableImport;
    openMenu(anchor, [
      on
        ? { label: t("Stop importing into osu!stable"), action: () => void this.setStableImport(false) }
        : { label: t("Import into osu!stable…"), action: () => void this.turnOnStableImport() },
    ]);
  }

  /** two warnings, then on */
  private async turnOnStableImport(): Promise<void> {
    const first = await uiConfirm(
      t("Fumen never writes into osu!stable's files, with this one exception: Add beatmaps and Browse can then put downloaded sets into stable's Songs folder, and stable imports them with its own code the next time it starts. Fumen can't check or undo that import, and it doesn't make backups of stable."),
      { title: t("Import into osu!stable?"), confirmLabel: t("I understand"), danger: true },
    );
    if (!first) return;
    const word = t("stable");
    const typed = await uiPrompt(
      t("Nothing in the Songs folder is ever replaced or removed; a set that's already there is left alone. Type “{word}” to turn it on.", { word }),
      { title: t("Turn on importing into osu!stable"), placeholder: word, confirmLabel: t("Turn on"), maxLength: 20 },
    );
    if (typed === null) return;
    if (typed.trim().toLowerCase() !== word.toLowerCase()) {
      toast(t("Not turned on: that wasn't “{word}”.", { word }));
      return;
    }
    await this.setStableImport(true);
  }

  private async setStableImport(on: boolean): Promise<void> {
    try {
      store.settings = await api.updateSettings({ stableImport: on });
      this.renderLibrary();
      toast(on ? t("Imports can go into osu!stable now. Pick it at the top of Add beatmaps.") : t("Imports go only into osu!lazer again."), { kind: on ? "success" : undefined });
    } catch (e) {
      toast(asApiError(e).message, { kind: "danger" });
    }
  }

  /** After stable's folder or switch changed: the library follows (when there is one). */
  private async stableChanged(): Promise<void> {
    await refreshStatus();
    if (!store.status?.scannedAt || isScanning()) return;
    const res = await runScan();
    if (!res.ok) toast(res.error.message, { kind: "danger", timeout: 6000 });
  }

  private async onClick(e: Event): Promise<void> {
    const target = e.target as Element;
    const goto = target.closest<HTMLElement>("[data-goto]");
    if (goto) {
      this.show(goto.dataset.goto as SettingsSection);
      this.el.scrollTo({ top: 0 });
      return;
    }
    const seg = target.closest<HTMLElement>(".seg-pill [data-v]");
    if (seg) {
      const key = seg.parentElement!.dataset.seg as "theme" | "accentMode" | "lang";
      seg.parentElement!.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === seg));
      if (key === "lang") {
        switchLang(seg.dataset.v as "en" | "de", (l) => {
          setPrefs({ lang: l });
          return flushPrefs();
        });
        return;
      }
      setPrefs({ [key]: seg.dataset.v } as never);
      if (key === "accentMode") this.el.querySelector<HTMLElement>(".setting-swatches")!.hidden = seg.dataset.v !== "fixed";
      applyAppearance();
      return;
    }
    const obsAct = target.closest<HTMLElement>("[data-obs-act]")?.dataset.obsAct;
    if (obsAct === "arrange") return openHudEditor();
    if (obsAct === "card" || obsAct === "session") {
      cue(obsAct);
      return void toast(t("Shown in OBS"), { kind: "success", timeout: 1600 });
    }
    if (obsAct === "new-session") {
      newSession();
      return void toast(t("A new session starts now"), { kind: "success", timeout: 1800 });
    }
    const copy = target.closest<HTMLElement>("[data-copy]");
    if (copy)
      return void navigator.clipboard.writeText(copy.dataset.copy!).then(
        () => toast(t("Copied"), { kind: "success", timeout: 1600 }),
        () => toast(t("Couldn't access the clipboard"), { kind: "danger" }),
      );
    if (target.closest(".s-heart-search")) return void this.heartSearch();
    const dev = target.closest<HTMLElement>("[data-heart]");
    if (dev && this.heartFound) {
      const d = this.heartFound[Number(dev.dataset.heart)];
      this.heartFound = null;
      if (d) void heart.use(d).catch((err) => toast(asApiError(err).message, { kind: "danger", timeout: 6000 }));
      return this.renderHeart();
    }
    if (target.closest(".s-heart-forget")) {
      this.heartFound = null;
      void heart.forget().catch(() => {});
      return this.renderHeart();
    }
    if (target.closest(".s-cloud-push")) return void this.cloudPush(target.closest<HTMLButtonElement>(".s-cloud-push")!);
    if (target.closest(".s-cloud-pull")) return void this.cloudPull(target.closest<HTMLButtonElement>(".s-cloud-pull")!);
    if (target.closest(".s-cols-lazer")) return void putIntoLazer(fumenCollections());
    if (target.closest(".s-cols-db")) return void saveCollectionDb(fumenCollections());
    const sw = target.closest<HTMLElement>(".swatch");
    if (sw) {
      this.el.querySelectorAll(".swatch").forEach((b) => b.classList.toggle("active", b === sw));
      setPrefs({ accent: sw.dataset.accent ?? DEFAULT_ACCENT });
      applyAppearance();
      return;
    }
    if (target.closest(".s-update-check")) return checkForUpdate(true);
    if (target.closest(".s-changelog")) return openChangelog();
    if (target.closest(".s-render-test")) {
      // the song that's loaded, for the test with sound
      if (player.audio.currentSrc) sessionStorage.setItem("fumen.renderTestSong", player.audio.currentSrc);
      return void (location.href = "/canvas-test.html");
    }
    if (target.closest(".s-inspector")) return void api.openInspector().catch((e) => toast(asApiError(e).message, { kind: "danger" }));
    if (target.closest(".s-update-install")) return installUpdate();
    if (target.closest(".s-login")) return loginWithOsu();
    if (target.closest(".s-login-cancel")) return api.osuLoginCancel();
    if (target.closest(".s-logout")) {
      await api.osuLogout().catch((err) => toast(asApiError(err).message, { kind: "danger" }));
      account = null;
      this.renderAccount();
      return;
    }
    if (target.closest(".s-rescan")) {
      const res = await runScan();
      if (res.ok) toast(t("Library imported"), { kind: "success" });
      else toast(res.error.message, { kind: "danger", timeout: 6000 });
      return;
    }
    if (target.closest(".s-pick")) {
      const dir = await open({ directory: true, title: t("osu!lazer data folder"), defaultPath: store.status?.install?.path ?? store.status?.defaultPath ?? undefined });
      if (typeof dir !== "string") return;
      const inst = await api.inspectLazerPath(dir);
      if (!inst) {
        toast(t("That folder doesn't contain an osu!lazer database."), { kind: "danger" });
        return;
      }
      store.settings = await api.updateSettings({ lazerPath: dir });
      await refreshStatus();
      return;
    }
    if (target.closest(".s-stable-pick")) {
      const dir = await open({ directory: true, title: t("osu!stable folder"), defaultPath: store.status?.stable?.install?.path ?? store.status?.stable?.defaultPath ?? undefined });
      if (typeof dir !== "string") return;
      if (!(await api.inspectStablePath(dir))) {
        toast(t("That folder doesn't hold osu!stable (an osu!.db and a Songs folder)."), { kind: "danger" });
        return;
      }
      store.settings = await api.updateSettings({ stablePath: dir, useStable: true });
      return void this.stableChanged();
    }
    if (target.closest(".s-stable-more")) return this.stableMenu(target.closest<HTMLElement>(".s-stable-more")!);
    if (target.closest(".s-stable-reset")) {
      store.settings = await api.updateSettings({ stablePath: null });
      return void this.stableChanged();
    }
    if (target.closest(".s-tosu-get")) return void openUrl("https://tosu.app");
    if (target.closest(".s-tosu-start")) {
      await api.startTosu().catch((err) => toast(asApiError(err).message, { kind: "danger" }));
      setTimeout(() => void this.renderTosu(), 1500);
      return;
    }
    if (target.closest(".s-tosu-pick")) {
      const file = await open({ title: t("Where is tosu?"), filters: isLinux ? [] : [{ name: "tosu", extensions: ["exe"] }] });
      if (typeof file !== "string") return;
      try {
        store.settings = await api.setTosuPath(file);
      } catch (err) {
        toast(asApiError(err).message, { kind: "danger" });
      }
      return void this.renderTosu();
    }
    if (target.closest(".s-reset-path")) {
      store.settings = await api.updateSettings({ lazerPath: null });
      await refreshStatus();
    }
  }

  private onChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    if (input.dataset.pref) {
      setPrefs({ [input.dataset.pref]: input.checked } as never);
      applyAppearance();
      if (input.dataset.pref === "followOsu") void this.renderTosu();
    } else if (input.dataset.obs === "serve") {
      setPrefs({ obs: { ...store.prefs.obs, serve: input.checked } });
      void (input.checked ? startOverlay() : stopOverlay());
    } else if (input.dataset.obs === "keys") {
      setPrefs({ obs: { ...store.prefs.obs, keys: input.checked } });
      void syncKeys();
    } else if ("prefCompanion" in input.dataset) {
      setPrefs({ companion: input.checked });
      void (input.checked ? api.openCompanion() : api.closeCompanion()).catch((err) => toast(asApiError(err).message, { kind: "danger" }));
    } else if (input.dataset.setting === "startPing") {
      api.updateSettings({ startPing: input.checked }).then((s) => (store.settings = s));
    } else if (input.dataset.setting === "autoRescan") {
      api.updateSettings({ autoRescan: input.checked }).then((s) => (store.settings = s));
    } else if (input.dataset.setting === "useStable") {
      void api.updateSettings({ useStable: input.checked }).then((s) => {
        store.settings = s;
        return this.stableChanged();
      });
    }
  }

  destroy(): void {
    if (shown === this) shown = null;
    this.offs.forEach((f) => f());
    this.el.remove();
  }
}
