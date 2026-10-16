/* settings.ts — osu! account, library source, appearance, about. Adjacent rows merge into one group. */
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { api, asApiError } from "../lib/api";
import { esc, MODE_LABEL, num, relativeTime } from "../lib/format";
import { collectionEvents, fumenCollections, loadCollections, putIntoLazer, saveCollectionDb } from "../lib/collections";
import { syncHistory } from "../lib/history";
import { canUpdate, checkForUpdate, downloadText, installUpdate, updateEvents, updateState } from "../lib/updater";
import { describeScan, isScanning, runScan } from "../lib/scan";
import { DEFAULT_ACCENT, events, refreshStatus, setPrefs, store } from "../lib/store";
import type { OsuAccount } from "../lib/types";
import { attachSegIndicator, toast, uiConfirm } from "../ui/controls";
import { importSets, openImport } from "./import";
import { icon } from "../ui/icons";
import { ACCENT_PRESETS, applyAppearance } from "../ui/theme";

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
    toast(`Logged in as ${account.username}`, { kind: "success" });
    void syncHistory().then((res) => {
      if (!res.ok) toast(`Couldn't read your scores from osu!: ${res.error.message}`, { kind: "danger", timeout: 6000 });
    });
  } catch (e) {
    const err = asApiError(e);
    if (err.code !== "login-cancelled") toast(err.message, { kind: "danger", timeout: 6000 });
  } finally {
    waiting = false;
    shown?.renderAccount();
  }
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
        <header class="view-head"><div><h1 class="view-title">Settings</h1></div></header>

        <section class="settings-section">
          <div class="label-caps settings-label">osu!</div>
          <div class="setting-row" data-row="account"></div>
        </section>

        <section class="settings-section">
          <div class="label-caps settings-label">Library</div>
          <div class="setting-row" data-row="path"></div>
          <div class="setting-row" data-row="stable"></div>
          <div class="setting-row" data-row="library"></div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-title">Keep up to date</div>
              <div class="setting-desc">Re-import when osu!lazer's or osu!stable's library changed since the last import.</div>
            </div>
            <input type="checkbox" role="switch" data-setting="autoRescan" ${store.settings?.autoRescan !== false ? "checked" : ""} />
          </div>
        </section>

        <section class="settings-section">
          <div class="label-caps settings-label">Collections</div>
          <div class="setting-row" data-row="collections"></div>
          <div class="setting-row" data-row="cloud">
            <div class="setting-text">
              <div class="setting-title">Collections in the cloud</div>
              <div class="setting-desc">Every collection (Fumen's, smart ones, osu!lazer's and osu!stable's) kept on Fumen's server under your osu! login. On another PC, Get them merges them in by name and downloads the sets you don't have.</div>
            </div>
            <div class="setting-actions">
              <button class="btn btn-sm s-cloud-pull" type="button">${icon("download")}Get them</button>
              <button class="btn btn-sm s-cloud-push" type="button">${icon("arrow-up")}Save to the cloud</button>
            </div>
          </div>
        </section>

        <section class="settings-section">
          <div class="label-caps settings-label">Appearance</div>
          <div class="setting-row">
            <div class="setting-text"><div class="setting-title">Theme</div></div>
            <div class="seg-pill" data-seg="theme">
              <button type="button" data-v="dark" class="${p.theme === "dark" ? "active" : ""}">Dark</button>
              <button type="button" data-v="oled" class="${p.theme === "oled" ? "active" : ""}">OLED</button>
              <button type="button" data-v="light" class="${p.theme === "light" ? "active" : ""}">Light</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-title">Accent colour</div>
              <div class="setting-desc">"From artwork" picks it up from the background of what you're looking at or listening to.</div>
            </div>
            <div class="seg-pill" data-seg="accentMode">
              <button type="button" data-v="dynamic" class="${p.accentMode === "dynamic" ? "active" : ""}">From artwork</button>
              <button type="button" data-v="fixed" class="${p.accentMode === "fixed" ? "active" : ""}">Fixed</button>
            </div>
          </div>
          <div class="setting-row setting-swatches"${p.accentMode === "fixed" ? "" : " hidden"}>
            <div class="setting-text"><div class="setting-title">Fixed colour</div></div>
            <div class="swatches">
              ${ACCENT_PRESETS.map((a) => `<button type="button" class="swatch${p.accent === a.color ? " active" : ""}" data-accent="${a.color}" style="--c:${a.color}" data-tip="${a.label}"></button>`).join("")}
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-title">Ambient background</div>
              <div class="setting-desc">A soft, blurred version of the current artwork behind the app.</div>
            </div>
            <input type="checkbox" role="switch" data-pref="ambient" ${p.ambient ? "checked" : ""} />
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-title">Original-language metadata</div>
              <div class="setting-desc">Show titles and artists in their original script (e.g. Japanese) when available.</div>
            </div>
            <input type="checkbox" role="switch" data-pref="unicode" ${p.unicode ? "checked" : ""} />
          </div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-title">Reduce motion</div>
              <div class="setting-desc">Turns off transitions and animations.</div>
            </div>
            <input type="checkbox" role="switch" data-pref="reduceMotion" ${p.reduceMotion ? "checked" : ""} />
          </div>
        </section>

        <section class="settings-section">
          <div class="label-caps settings-label">About</div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-title about-version">Fumen ${esc(this.version)}</div>
              <div class="setting-desc">Fumen reads osu!lazer's database from a private copy. Beatmaps and collections you put into lazer go in through lazer's own code, only while lazer is closed, only on lazer versions tested with Fumen, and with a backup of its database first.</div>
            </div>
          </div>
          <div class="setting-row" data-row="update"></div>
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
    let desc = "Fumen looks for updates when it starts and every few hours. Installing one restarts it.";
    let control = `<button class="btn s-update-check" type="button">Check for updates</button>`;
    if (!canUpdate) {
      desc = "On macOS, Fumen doesn't update itself yet: new versions are on fumen.dertesti.dev.";
      control = "";
    } else if (s.phase === "checking") control = `<button class="btn" type="button" disabled>Checking…</button>`;
    else if (s.phase === "current") desc = `You have the latest version (checked ${relativeTime(s.at)}).`;
    else if (s.phase === "available") {
      desc = `Fumen ${esc(s.version)} is out. Installing it restarts Fumen.`;
      control = `<button class="btn btn-primary s-update-install" type="button">${icon("download")}<span>Update to ${esc(s.version)}</span></button>`;
    } else if (s.phase === "downloading") {
      desc = `Downloading Fumen ${esc(s.version)}…`;
      control = `<button class="btn" type="button" disabled>${downloadText(s)}</button>`;
    } else if (s.phase === "installing") {
      desc = `Installing Fumen ${esc(s.version)}. Fumen closes for a moment and opens again.`;
      control = `<button class="btn" type="button" disabled>Installing…</button>`;
    } else if (s.phase === "error") {
      desc = esc(s.message);
      control = s.version
        ? `<button class="btn btn-primary s-update-install" type="button">${icon("download")}<span>Try again</span></button>`
        : `<button class="btn s-update-check" type="button">Try again</button>`;
    }
    row.innerHTML = `
      <div class="setting-text">
        <div class="setting-title">Updates</div>
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
          <div class="setting-title">osu! account</div>
          <div class="setting-desc">Finish logging in on the page that opened in your browser. Fumen picks it up from there.</div>
        </div>
        <button class="btn btn-ghost btn-sm s-login-cancel" type="button">Cancel</button>`;
    } else if (a) {
      const words = [
        a.rank ? `#${num(a.rank)}` : "No rank",
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
        <button class="btn btn-ghost btn-sm s-logout" type="button">Log out</button>`;
      row.querySelector("img")?.addEventListener("error", (e) => (e.target as HTMLElement).remove());
    } else {
      row.innerHTML = `
        <div class="setting-text">
          <div class="setting-title">osu! account</div>
          <div class="setting-desc">Log in to bring your osu! profile and scores into Fumen: pp, top plays and the plays from your other computers, in History. You log in on osu!'s own page; Fumen never sees your password.</div>
        </div>
        <button class="btn btn-primary btn-sm s-login" type="button"${accountKnown ? "" : " disabled"}>Log in with osu!</button>`;
    }
  }

  private async cloudPush(b: HTMLButtonElement): Promise<void> {
    b.disabled = true;
    try {
      const r = await api.cloudPushCollections();
      toast(`${num(r.collections)} ${r.collections === 1 ? "collection" : "collections"} saved to the cloud`, { kind: "success", timeout: 3000 });
    } catch (e) {
      toast(`Couldn't save them: ${asApiError(e).message}`, { kind: "danger", timeout: 6000 });
    } finally {
      b.disabled = false;
    }
  }

  private async cloudPull(b: HTMLButtonElement): Promise<void> {
    b.disabled = true;
    try {
      const r = await api.cloudPullCollections();
      await loadCollections();
      const words = [`${num(r.collections)} from the cloud`, r.created ? `${num(r.created)} new here` : "", r.added ? `${num(r.added)} difficulties added` : ""].filter(Boolean);
      toast(words.join(", "), { kind: "success", timeout: 4000 });
      if (r.missing.length) {
        const ok = await uiConfirm(`The collections want ${num(r.missing.length)} ${r.missing.length === 1 ? "set" : "sets"} this library doesn't have. Fumen downloads them from the mirrors and puts them into osu!lazer.`, { title: "Download the missing sets?", confirmLabel: "Download them" });
        if (ok && importSets(r.missing.map((m) => ({ id: m.id, title: `Set ${m.id}` }))) !== "none") openImport();
      }
    } catch (e) {
      toast(`Couldn't get them: ${asApiError(e).message}`, { kind: "danger", timeout: 6000 });
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
        <div class="setting-title">Your collections in osu!</div>
        <div class="setting-desc">${n ? `${n === 1 ? "Fumen's collection" : `All ${num(n)} of Fumen's collections`} into osu!lazer's (each one updates the lazer collection it went into before, or the one with its name), or as a collection.db for osu!stable and Collection Manager. Single ones: right-click them in the sidebar.` : "Make a collection in the sidebar first."}</div>
      </div>
      <div class="setting-actions">
        <button class="btn btn-sm s-cols-db" type="button"${n ? "" : " disabled"}>${icon("download")}Save collection.db…</button>
        <button class="btn btn-sm s-cols-lazer" type="button"${n ? "" : " disabled"}>${icon("arrow-right")}Put into osu!lazer</button>
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
      state = `${num(c.sets)} sets, ${num(c.maps)} difficulties, ${num(c.scores)} scores. Imported ${relativeTime(st.scannedAt)}${st.changed ? ". osu! has changed since then." : "."}`;
    } else {
      state = "Not imported yet.";
    }
    pathRow.innerHTML = `
      <div class="setting-text">
        <div class="setting-title">osu!lazer folder</div>
        <div class="setting-desc setting-path">${inst ? esc(inst.storage) : `<span class="is-missing">Not found${custom ? " in the chosen folder" : ""}</span>`}</div>
      </div>
      <div class="setting-actions">
        ${custom ? `<button class="btn btn-ghost btn-sm s-reset-path" type="button">Use default</button>` : ""}
        <button class="btn btn-sm s-pick" type="button">${icon("folder")}Change</button>
      </div>`;
    libRow.innerHTML = `
      <div class="setting-text">
        <div class="setting-title">Library</div>
        <div class="setting-desc num">${esc(state)}</div>
      </div>
      <button class="btn btn-sm s-rescan" type="button"${busy || !(inst || st?.stable?.install) ? " disabled" : ""}>${icon("refresh")}Import now</button>`;

    const stableRow = this.el.querySelector<HTMLElement>('[data-row="stable"]');
    if (!stableRow) return;
    const sst = st?.stable;
    const stableCustom = !!store.settings?.stablePath;
    const on = store.settings?.useStable !== false;
    const sc = sst?.counts;
    const where = sst?.install
      ? `<span class="setting-path">${esc(sst.install.path)}</span>${sc && sst.scannedAt ? `<br>${num(sc.sets)} sets, ${num(sc.maps)} difficulties${sc.scores ? `, ${num(sc.scores)} ${sc.scores === 1 ? "play" : "plays"}` : ""}. Ones lazer has too show once.` : on ? "<br>Its beatmaps come in with the next import." : ""}`
      : on
        ? `<span class="is-missing">Not found${stableCustom ? " in the chosen folder" : sst?.defaultPath ? ` in ${esc(sst.defaultPath)}` : ""}</span>`
        : "Off: only osu!lazer's beatmaps are in the library.";
    stableRow.innerHTML = `
      <div class="setting-text">
        <div class="setting-title">osu!stable</div>
        <div class="setting-desc">${where}</div>
      </div>
      <div class="setting-actions">
        ${stableCustom ? `<button class="btn btn-ghost btn-sm s-stable-reset" type="button">Use default</button>` : ""}
        <button class="btn btn-sm s-stable-pick" type="button">${icon("folder")}Change</button>
        <input type="checkbox" role="switch" data-setting="useStable" aria-label="Use osu!stable's beatmaps" ${on ? "checked" : ""} />
      </div>`;
  }

  /** After stable's folder or switch changed: the library follows (when there is one). */
  private async stableChanged(): Promise<void> {
    await refreshStatus();
    if (!store.status?.scannedAt || isScanning()) return;
    const res = await runScan();
    if (!res.ok) toast(res.error.message, { kind: "danger", timeout: 6000 });
  }

  private async onClick(e: Event): Promise<void> {
    const t = e.target as Element;
    const seg = t.closest<HTMLElement>(".seg-pill [data-v]");
    if (seg) {
      const key = seg.parentElement!.dataset.seg as "theme" | "accentMode";
      seg.parentElement!.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === seg));
      setPrefs({ [key]: seg.dataset.v } as never);
      if (key === "accentMode") this.el.querySelector<HTMLElement>(".setting-swatches")!.hidden = seg.dataset.v !== "fixed";
      applyAppearance();
      return;
    }
    if (t.closest(".s-cloud-push")) return void this.cloudPush(t.closest<HTMLButtonElement>(".s-cloud-push")!);
    if (t.closest(".s-cloud-pull")) return void this.cloudPull(t.closest<HTMLButtonElement>(".s-cloud-pull")!);
    if (t.closest(".s-cols-lazer")) return void putIntoLazer(fumenCollections());
    if (t.closest(".s-cols-db")) return void saveCollectionDb(fumenCollections());
    const sw = t.closest<HTMLElement>(".swatch");
    if (sw) {
      this.el.querySelectorAll(".swatch").forEach((b) => b.classList.toggle("active", b === sw));
      setPrefs({ accent: sw.dataset.accent ?? DEFAULT_ACCENT });
      applyAppearance();
      return;
    }
    if (t.closest(".s-update-check")) return checkForUpdate(true);
    if (t.closest(".s-update-install")) return installUpdate();
    if (t.closest(".s-login")) return loginWithOsu();
    if (t.closest(".s-login-cancel")) return api.osuLoginCancel();
    if (t.closest(".s-logout")) {
      await api.osuLogout().catch((err) => toast(asApiError(err).message, { kind: "danger" }));
      account = null;
      this.renderAccount();
      return;
    }
    if (t.closest(".s-rescan")) {
      const res = await runScan();
      if (res.ok) toast("Library imported", { kind: "success" });
      else toast(res.error.message, { kind: "danger", timeout: 6000 });
      return;
    }
    if (t.closest(".s-pick")) {
      const dir = await open({ directory: true, title: "osu!lazer data folder", defaultPath: store.status?.install?.path ?? store.status?.defaultPath ?? undefined });
      if (typeof dir !== "string") return;
      const inst = await api.inspectLazerPath(dir);
      if (!inst) {
        toast("That folder doesn't contain an osu!lazer database.", { kind: "danger" });
        return;
      }
      store.settings = await api.updateSettings({ lazerPath: dir });
      await refreshStatus();
      return;
    }
    if (t.closest(".s-stable-pick")) {
      const dir = await open({ directory: true, title: "osu!stable folder", defaultPath: store.status?.stable?.install?.path ?? store.status?.stable?.defaultPath ?? undefined });
      if (typeof dir !== "string") return;
      if (!(await api.inspectStablePath(dir))) {
        toast("That folder doesn't hold osu!stable (an osu!.db and a Songs folder).", { kind: "danger" });
        return;
      }
      store.settings = await api.updateSettings({ stablePath: dir, useStable: true });
      return void this.stableChanged();
    }
    if (t.closest(".s-stable-reset")) {
      store.settings = await api.updateSettings({ stablePath: null });
      return void this.stableChanged();
    }
    if (t.closest(".s-reset-path")) {
      store.settings = await api.updateSettings({ lazerPath: null });
      await refreshStatus();
    }
  }

  private onChange(e: Event): void {
    const t = e.target as HTMLInputElement;
    if (t.dataset.pref) {
      setPrefs({ [t.dataset.pref]: t.checked } as never);
      applyAppearance();
    } else if (t.dataset.setting === "autoRescan") {
      api.updateSettings({ autoRescan: t.checked }).then((s) => (store.settings = s));
    } else if (t.dataset.setting === "useStable") {
      void api.updateSettings({ useStable: t.checked }).then((s) => {
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
