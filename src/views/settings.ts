/* settings.ts — osu! account, library source, appearance, about. Adjacent rows merge into one group. */
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { api, asApiError, isLinux } from "../lib/api";
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
import { icon } from "../ui/icons";
import { ACCENT_PRESETS, applyAppearance } from "../ui/theme";
import { openChangelog } from "./changelog";
import { player } from "../player";

// the osu! login outlives the view: it waits for the browser while you look elsewhere
let account: OsuAccount | null = null;
let accountKnown = false;
let waiting = false;
let shown: SettingsView | null = null;

const MODE_INDEX = { osu: 0, taiko: 1, fruits: 2, mania: 3 } as const;

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

  constructor() {
    this.el = document.createElement("section");
    this.el.className = "view settings-view";
    this.render();
    this.offs.push(
      events.on("status", () => this.renderLibrary()),
      events.on("scan", () => this.renderLibrary()),
      updateEvents.on("change", () => this.renderUpdate()),
      collectionEvents.on("collections", () => this.renderCollections()),
    );
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
    this.el.innerHTML = `
      <div class="settings">
        <header class="view-head"><div><h1 class="view-title">${t("Settings")}</h1></div></header>

        <section class="settings-section">
          <div class="label-caps settings-label">osu!</div>
          <div class="setting-row" data-row="account"></div>
        </section>

        <section class="settings-section">
          <div class="label-caps settings-label">${t("Library")}</div>
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

        <section class="settings-section">
          <div class="label-caps settings-label">${t("Collections")}</div>
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

        <section class="settings-section">
          <div class="label-caps settings-label">${t("Appearance")}</div>
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

        <section class="settings-section">
          <div class="label-caps settings-label">${t("Listening")}</div>
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

        <section class="settings-section">
          <div class="label-caps settings-label">${t("While you play")}</div>
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
        </section>

        <section class="settings-section">
          <div class="label-caps settings-label">${t("About")}</div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-title about-version">Fumen ${esc(this.version)}</div>
              <div class="setting-desc">${t("Fumen reads osu!lazer's database from a private copy. Beatmaps and collections you put into lazer go in through lazer's own code, only while lazer is closed, only on lazer versions tested with Fumen, and with a backup of its database first.")}</div>
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
      </div>`;
    this.el.querySelectorAll<HTMLElement>(".seg-pill").forEach((s) => attachSegIndicator(s));
    this.renderLibrary();
    this.renderCollections();
    this.renderAccount();
    this.renderUpdate();
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
