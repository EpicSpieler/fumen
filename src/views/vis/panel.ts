/* panel.ts — the visualizer's settings beside it (the style itself is the dropdown in the top bar):
 * colours, how it reacts, the beat, kiai and flashes, the background, the title. Every change is
 * saved at once (prefs `visualizer`). */
import { t } from "../../lib/i18n";
import { DEFAULT_PREFS, setPrefs } from "../../lib/store";
import type { VisPrefs } from "../../lib/types";
import { attachSegIndicator, updateRange } from "../../ui/controls";
import { icon } from "../../ui/icons";
import { OWN_COLORS, setVis, visPrefs } from "./visualizer";
import { follow, type FollowStatus } from "../../lib/tosu-follow";
import { esc } from "../../lib/format";

type Num = "reaction" | "sensitivity" | "pulse" | "bars" | "blur" | "dim" | "offset";
type Seg = "colors" | "flashes" | "background";
type Flag = "kiai" | "mirror" | "title" | "video";

/** sliders: setting, label, min, max, scale to the input's numbers, ends, shown value */
const RANGES: [Num, string, number, number, number, string, string, (v: number) => string][] = [
  ["reaction", t("Reaction"), 0, 100, 100, t("Smooth"), t("Fast"), (v) => `${v}`],
  ["sensitivity", t("Sensitivity"), 0, 100, 100, t("Calm"), t("Strong"), (v) => `${v}`],
  ["pulse", t("Beat pulse"), 0, 100, 100, t("Off"), t("Strong"), (v) => (v ? `${v}` : t("Off"))],
  ["bars", t("Bars"), 24, 128, 1, t("Fewer"), t("More"), (v) => `${v}`],
  ["blur", t("Blur"), 0, 100, 100, t("Sharp"), t("Soft"), (v) => (v ? `${v}` : t("Off"))],
  ["dim", t("Dim the background"), 0, 90, 100, "", "", (v) => `${v} %`],
  ["offset", t("Beat offset"), -100, 100, 1, t("Earlier"), t("Later"), (v) => `${v > 0 ? "+" : ""}${v} ms`],
];

const SEGS: [Seg, string, [string, string][]][] = [
  ["colors", t("Colours"), [["cover", t("From the cover")], ["accent", t("Accent")], ["own", t("Your own")]]],
  ["flashes", t("Flashes in kiai"), [["off", t("Off")], ["soft", t("Soft")], ["full", t("Full")]]],
  ["background", t("Background"), [["blur", t("Blurred")], ["art", t("Cover")], ["black", t("Black")]]],
];

const FLAGS: [Flag, string, string][] = [
  ["kiai", t("Kiai effects"), t("Brighter and livelier in the beatmap's kiai")],
  ["mirror", t("Mirrored"), t("Bass in the middle, highs to both sides")],
  ["title", t("Title"), ""],
  ["video", t("Video"), t("The beatmap's video in place of the cover, when it has one")],
];

export function panelHtml(): string {
  const seg = ([key, label, opts]: (typeof SEGS)[number]) => `
    <div class="vp-row"><span class="fs-k">${label}</span>
      <div class="seg-pill vp-seg" data-vis="${key}" role="group" aria-label="${label}">${opts.map(([v, l]) => `<button type="button" data-v="${v}">${l}</button>`).join("")}</div>
      ${key === "colors" ? `<div class="vp-swatches" hidden>${OWN_COLORS.map((c, i) => `<button type="button" class="vp-swatch" data-own="${i}" aria-label="${c.name}" style="background:linear-gradient(135deg, ${c.a} 0 50%, ${c.b} 50% 100%)"></button>`).join("")}</div>` : ""}
    </div>`;
  const range = ([key, label, min, max, , lo, hi]: (typeof RANGES)[number]) => `
    <div class="vp-row vp-range"><div class="vp-range-top"><label class="fs-k" for="vp-${key}">${label}</label><b class="num" data-val="${key}"></b></div>
      <input type="range" id="vp-${key}" data-vis="${key}" min="${min}" max="${max}" step="1" />
      ${lo || hi ? `<div class="vp-ends"><span>${lo}</span><span>${hi}</span></div>` : ""}
    </div>`;
  return `
    <div class="vp-head"><b>${t("Visualizer")}</b>
      <button class="icon-btn sm vp-close" type="button" aria-label="${t("Close")}">${icon("x")}</button>
    </div>
    <div class="vp-row"><span class="fs-k">${t("Style")}</span><span class="vp-style-host"></span></div>
    <label class="vp-switch vp-follow"><span><b>${t("Follow osu!")}</b><i class="vp-follow-status"></i></span><input type="checkbox" role="switch" data-follow /></label>
    ${seg(SEGS[0])}
    ${RANGES.slice(0, 4).map(range).join("")}
    ${seg(SEGS[1])}
    ${seg(SEGS[2])}
    ${range(RANGES[4])}
    ${range(RANGES[5])}
    <div class="vp-switches">${FLAGS.map(
      ([key, label, sub]) => `<label class="vp-switch"><span><b>${label}</b>${sub ? `<i>${sub}</i>` : ""}</span><input type="checkbox" role="switch" data-vis="${key}" /></label>`,
    ).join("")}</div>
    ${range(RANGES[6])}
    <button class="btn btn-sm vp-reset" type="button">${icon("refresh")}${t("Reset to defaults")}</button>`;
}

/** Wires the panel in `host`; `changed` runs after every change. Returns a function that shows the saved values. */
export function bindPanel(host: HTMLElement, changed: () => void): () => void {
  const set = (patch: Partial<VisPrefs>) => {
    setVis(patch);
    render();
    changed();
  };
  host.querySelectorAll<HTMLElement>(".vp-seg").forEach((el) => {
    attachSegIndicator(el);
    el.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-v]");
      if (b) set({ [el.dataset.vis as Seg]: b.dataset.v } as Partial<VisPrefs>);
    });
  });
  host.querySelectorAll<HTMLButtonElement>(".vp-swatch").forEach((b) => b.addEventListener("click", () => set({ own: +b.dataset.own! })));
  for (const [key, , , , scale] of RANGES) {
    const el = host.querySelector<HTMLInputElement>(`#vp-${key}`)!;
    el.addEventListener("input", () => set({ [key]: +el.value / scale } as Partial<VisPrefs>));
  }
  host.querySelectorAll<HTMLInputElement>("input[role=switch][data-vis]").forEach((el) => el.addEventListener("change", () => set({ [el.dataset.vis as Flag]: el.checked } as Partial<VisPrefs>)));
  host.querySelector(".vp-reset")!.addEventListener("click", () => set({ ...DEFAULT_PREFS.visualizer, style: visPrefs().style }));

  const render = () => {
    const o = visPrefs();
    for (const [key] of SEGS) {
      host.querySelectorAll<HTMLElement>(`.vp-seg[data-vis="${key}"] button`).forEach((b) => {
        const on = b.dataset.v === o[key];
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      });
    }
    host.querySelector<HTMLElement>(".vp-swatches")!.hidden = o.colors !== "own";
    host.querySelectorAll<HTMLElement>(".vp-swatch").forEach((b) => b.classList.toggle("on", +b.dataset.own! === o.own));
    for (const [key, , , , scale, , , show] of RANGES) {
      const el = host.querySelector<HTMLInputElement>(`#vp-${key}`)!;
      const v = Math.round(o[key] * scale);
      if (document.activeElement !== el) el.value = String(v);
      if (key === "blur") el.disabled = o.background !== "blur";
      updateRange(el);
      host.querySelector(`[data-val="${key}"]`)!.textContent = show(v);
    }
    host.querySelectorAll<HTMLInputElement>("input[role=switch][data-vis]").forEach((el) => (el.checked = o[el.dataset.vis as Flag]));
  };
  render();

  const followSwitch = host.querySelector<HTMLInputElement>("input[data-follow]")!;
  followSwitch.addEventListener("change", () => setPrefs({ followOsu: followSwitch.checked }));
  // the panel is built before it's in the page: it lets go once it was there and is gone
  let shown = false;
  const showFollow = (st: FollowStatus) => {
    if (host.isConnected) shown = true;
    else if (shown) return off();
    followSwitch.checked = st.kind !== "off";
    host.querySelector(".vp-follow-status")!.innerHTML = followText(st);
  };
  const off = follow.bus.on("status", showFollow);
  showFollow(follow.status);
  return render;
}

function followText(st: FollowStatus): string {
  switch (st.kind) {
    case "off":
      return t("Plays along with what osu! plays, through tosu");
    case "connecting":
      return t("Waiting for tosu (tosu.app) to run");
    case "waiting":
      return t("tosu is there, osu! has no song yet");
    case "following":
      return esc(st.title);
    case "missing":
      return `${t("Not in your library")}: ${esc(st.title)}`;
  }
}
