/* welcome.ts — first run: find osu!lazer, import the library. */
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { esc, num, relativeTime } from "../lib/format";
import { goSection } from "../lib/router";
import { describeScan, isScanning, runScan } from "../lib/scan";
import { events, refreshStatus, store } from "../lib/store";
import type { ApiError } from "../lib/types";
import { toast } from "../ui/controls";
import { icon } from "../ui/icons";

export class WelcomeView {
  readonly el: HTMLElement;
  private error: ApiError | null = null;
  private offs: (() => void)[] = [];

  constructor() {
    this.el = document.createElement("section");
    this.el.className = "view welcome-view";
    this.render();
    this.offs.push(
      events.on("scan", () => this.renderProgress()),
      events.on("status", () => this.render()),
    );
    this.el.addEventListener("click", (e) => this.onClick(e));
  }

  private render(): void {
    const st = store.status;
    const inst = st?.install;
    const stable = st?.stable?.install;
    const busy = isScanning();
    const stableBlock = stable
      ? `<div class="welcome-found">
          <div class="label-caps">osu!stable</div>
          <div class="welcome-path">${esc(stable.path)}</div>
          <div class="welcome-meta">Its beatmaps come in too (Settings can switch that off). Ones lazer has as well show once.</div>
        </div>`
      : "";
    this.el.innerHTML = `
      <div class="welcome">
        <div class="welcome-mark">${icon("lanes-duo")}</div>
        <h1 class="welcome-title">Welcome to Fumen</h1>
        <p class="welcome-sub">Your osu! library, all in one place: search it, filter it, listen to it.</p>
        <div class="panel welcome-panel">
          ${
            inst
              ? `<div class="welcome-found">
                  <div class="label-caps">osu!lazer</div>
                  <div class="welcome-path">${esc(inst.storage)}</div>
                  <div class="welcome-meta">Database ${(inst.realmSize / 1048576).toFixed(0)} MB, last changed ${relativeTime(inst.realmModified)}</div>
                </div>
                ${stableBlock}
                <div class="welcome-actions">
                  <button class="btn btn-primary btn-lg w-import" type="button"${busy ? " disabled" : ""}>Import library</button>
                  <button class="btn btn-ghost w-pick" type="button"${busy ? " disabled" : ""}>Use another folder</button>
                </div>`
              : `<div class="welcome-found">
                  <div class="label-caps">osu!lazer</div>
                  <div class="welcome-path is-missing">Not found${st?.defaultPath ? ` in ${esc(st.defaultPath)}` : ""}</div>
                  <div class="welcome-meta">Pick the folder osu!lazer stores its files in. In lazer: Settings, Maintenance, "Open osu! folder".</div>
                </div>
                ${stableBlock}
                <div class="welcome-actions">
                  ${stable ? `<button class="btn btn-primary btn-lg w-import" type="button"${busy ? " disabled" : ""}>Import osu!stable</button>` : ""}
                  <button class="btn ${stable ? "btn-ghost" : "btn-primary btn-lg"} w-pick" type="button">Choose lazer's folder</button>
                </div>`
          }
          <div class="welcome-progress" hidden>
            <div class="welcome-progress-row"><span class="wp-label"></span><span class="wp-pct num"></span></div>
            <div class="bar"><i class="wp-fill"></i></div>
          </div>
          <div class="welcome-error" hidden></div>
        </div>
        <p class="welcome-foot">${icon("info")}Fumen only reads osu!'s data. It never changes anything in osu!.</p>
      </div>`;
    this.renderProgress();
    this.renderError();
  }

  private renderProgress(): void {
    const box = this.el.querySelector<HTMLElement>(".welcome-progress");
    if (!box) return;
    const busy = isScanning();
    box.hidden = !busy;
    this.el.querySelectorAll<HTMLButtonElement>(".welcome-actions button").forEach((b) => (b.disabled = busy));
    if (!busy) return;
    const { label, fraction } = describeScan(store.scan);
    box.querySelector(".wp-label")!.textContent = label;
    box.querySelector(".wp-pct")!.textContent = `${Math.round(fraction * 100)}%`;
    const fill = box.querySelector<HTMLElement>(".wp-fill")!;
    fill.style.animation = "none";
    fill.style.transform = `scaleX(${fraction})`;
  }

  private renderError(): void {
    const box = this.el.querySelector<HTMLElement>(".welcome-error");
    if (!box) return;
    box.hidden = !this.error;
    box.innerHTML = this.error ? `${icon("alert")}<span>${esc(this.error.message)}</span>` : "";
  }

  private async onClick(e: Event): Promise<void> {
    const t = e.target as Element;
    if (t.closest(".w-import")) {
      this.error = null;
      this.renderError();
      const res = await runScan();
      if (res.ok) {
        const c = store.status?.counts;
        if (c) toast(`Imported ${num(c.sets)} sets and ${num(c.maps)} difficulties`, { kind: "success" });
        goSection({ name: "home" });
      } else {
        this.error = res.error;
        this.renderError();
        this.renderProgress();
      }
    } else if (t.closest(".w-pick")) {
      const dir = await open({ directory: true, title: "osu!lazer data folder", defaultPath: store.status?.defaultPath ?? undefined });
      if (typeof dir !== "string") return;
      const inst = await api.inspectLazerPath(dir);
      if (!inst) {
        this.error = { code: "lazer-not-found", message: "That folder doesn't contain an osu!lazer database (client.realm and a files folder)." };
        this.renderError();
        return;
      }
      this.error = null;
      store.settings = await api.updateSettings({ lazerPath: dir });
      await refreshStatus();
    }
  }

  destroy(): void {
    this.offs.forEach((f) => f());
    this.el.remove();
  }
}
