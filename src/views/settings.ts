/* settings.ts — library source, appearance, about. Adjacent rows merge into one group. */
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { esc, num, relativeTime } from "../lib/format";
import { describeScan, isScanning, runScan } from "../lib/scan";
import { DEFAULT_ACCENT, events, refreshStatus, setPrefs, store } from "../lib/store";
import { attachSegIndicator, toast } from "../ui/controls";
import { icon } from "../ui/icons";
import { ACCENT_PRESETS, applyAppearance } from "../ui/theme";

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
    );
    this.el.addEventListener("click", (e) => void this.onClick(e));
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
          <div class="label-caps settings-label">Library</div>
          <div class="setting-row" data-row="path"></div>
          <div class="setting-row" data-row="library"></div>
          <div class="setting-row">
            <div class="setting-text">
              <div class="setting-title">Keep up to date</div>
              <div class="setting-desc">Re-import when osu!lazer's library changed since the last import.</div>
            </div>
            <input type="checkbox" role="switch" data-setting="autoRescan" ${store.settings?.autoRescan !== false ? "checked" : ""} />
          </div>
        </section>

        <section class="settings-section">
          <div class="label-caps settings-label">Appearance</div>
          <div class="setting-row">
            <div class="setting-text"><div class="setting-title">Theme</div></div>
            <div class="seg-pill" data-seg="theme">
              <button type="button" data-v="dark" class="${p.theme === "dark" ? "active" : ""}">Dark</button>
              <button type="button" data-v="oled" class="${p.theme === "oled" ? "active" : ""}">OLED</button>
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
              <div class="setting-desc">Fumen reads osu!lazer's database from a private copy. It never writes to osu!'s files.</div>
            </div>
          </div>
        </section>
      </div>`;
    this.el.querySelectorAll<HTMLElement>(".seg-pill").forEach((s) => attachSegIndicator(s));
    this.renderLibrary();
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
      state = `${num(c.sets)} sets, ${num(c.maps)} difficulties, ${num(c.scores)} scores. Imported ${relativeTime(st.scannedAt)}${st.changed ? ". lazer has changed since then." : "."}`;
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
      <button class="btn btn-sm s-rescan" type="button"${busy || !inst ? " disabled" : ""}>${icon("refresh")}Import now</button>`;
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
    const sw = t.closest<HTMLElement>(".swatch");
    if (sw) {
      this.el.querySelectorAll(".swatch").forEach((b) => b.classList.toggle("active", b === sw));
      setPrefs({ accent: sw.dataset.accent ?? DEFAULT_ACCENT });
      applyAppearance();
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
    }
  }

  destroy(): void {
    this.offs.forEach((f) => f());
    this.el.remove();
  }
}
