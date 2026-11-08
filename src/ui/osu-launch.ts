/* osu-launch.ts — starting osu! from Fumen and closing osu!lazer.
 *
 * The sidebar's Play button starts osu!lazer, or osu!stable when that's picked in its menu (Windows,
 * with stable found). Where Fumen needs lazer closed (adding and deleting beatmaps), a "Close
 * osu!lazer" button asks it to close the way its own close button does; the dialogs see it go
 * through their usual status checks.
 */
import { api, asApiError, isLinux, isMac } from "../lib/api";
import { t } from "../lib/i18n";
import { setPrefs, store } from "../lib/store";
import { openMenu, toast } from "./controls";
import { icon } from "./icons";

type Client = "lazer" | "stable";

/** stable can be started from here: Windows, and its folder is known */
function stableKnown(): boolean {
  const s = store.status?.stable;
  return !isMac && !isLinux && !!(s?.install || s?.defaultPath);
}

function client(): Client {
  return store.prefs.launchClient === "stable" && stableKnown() ? "stable" : "lazer";
}

const NAMES: Record<Client, string> = { lazer: "osu!lazer", stable: "osu!stable" };

export function launchHtml(): string {
  return `
    <div class="side-play">
      <button class="side-play-go" type="button">${icon("play", "side-play-ic")}<span class="side-play-label"></span></button>
      <button class="side-play-pick" type="button" aria-label="${t("Pick which osu! to start")}" data-tip="${t("Pick which osu! to start")}">${icon("chevron-down")}</button>
    </div>`;
}

let starting = false;

async function launch(c: Client): Promise<void> {
  if (starting) return;
  starting = true;
  try {
    await api.launchOsu(c);
    toast(t("Starting {name}…", { name: NAMES[c] }), { timeout: 2500 });
  } catch (e) {
    toast(asApiError(e).message, { kind: "danger", timeout: 5000 });
  } finally {
    // a double click shouldn't start it twice
    setTimeout(() => (starting = false), 1500);
  }
}

/** Wires the sidebar's Play button (call again when the library status changes). */
export function renderLaunch(root: HTMLElement): void {
  const box = root.querySelector<HTMLElement>(".side-play");
  if (!box) return;
  const c = client();
  const label = t("Play {name}", { name: NAMES[c] });
  box.querySelector(".side-play-label")!.textContent = label;
  const go = box.querySelector<HTMLElement>(".side-play-go")!;
  go.setAttribute("aria-label", label);
  // collapsed sidebar: the label is the tip
  if (document.body.classList.contains("sidebar-collapsed")) go.dataset.tip = label;
  else delete go.dataset.tip;
  box.querySelector<HTMLElement>(".side-play-pick")!.hidden = !stableKnown();
  if (box.dataset.wired) return;
  box.dataset.wired = "1";
  go.addEventListener("click", () => void launch(client()));
  const pick = box.querySelector<HTMLElement>(".side-play-pick")!;
  pick.addEventListener("click", () => {
    const now = client();
    openMenu(
      pick,
      (["lazer", "stable"] as Client[]).map((k) => ({
        label: NAMES[k],
        checked: now === k,
        action: () => {
          setPrefs({ launchClient: k });
          renderLaunch(root);
        },
      })),
      { minWidth: 170 },
    );
  });
}

// ── closing osu!lazer ───────────────────────────────────────────────────

let closing = 0;

/** The button that closes osu!lazer, for a "lazer is running" notice. */
export function closeLazerHtml(): string {
  const busy = Date.now() < closing;
  return `<button class="btn btn-sm close-lazer" type="button"${busy ? " disabled" : ""}>${busy ? t("Closing…") : t("Close osu!lazer")}</button>`;
}

/** Wires the close buttons in `root`; `recheck` runs the dialog's status check. */
export function wireCloseLazer(root: HTMLElement, recheck: () => Promise<boolean>): void {
  root.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>(".close-lazer");
    if (!btn || btn.disabled) return;
    void closeLazer(btn, recheck);
  });
}

/** Asks lazer to close, then watches (through `recheck`: true while it still runs) for up to 15 s. */
async function closeLazer(btn: HTMLButtonElement, recheck: () => Promise<boolean>): Promise<void> {
  closing = Date.now() + 15000;
  btn.disabled = true;
  btn.textContent = t("Closing…");
  let asked = 0;
  try {
    asked = await api.closeLazer();
  } catch (e) {
    closing = 0;
    toast(asApiError(e).message, { kind: "danger", timeout: 5000 });
    return void recheck();
  }
  if (!asked) {
    closing = 0;
    void recheck();
    return;
  }
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (!(await recheck())) {
      closing = 0;
      return;
    }
  }
  closing = 0;
  toast(t("osu!lazer is still open. It may be asking something (downloads running?), have a look at it."), { timeout: 7000 });
  void recheck();
}
