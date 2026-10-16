/* star-range.ts — a dual-thumb star rating range (0–10, 10 meaning "and up") for the top of a
 * filters menu: the library's and Browse's. */
import { fixed } from "../lib/format";
import { updateRange } from "./controls";
import { t } from "../lib/i18n";

const MAX = 10;

/** `value.max` Infinity: no upper end. `change` hears the range a moment after it moves. */
export function starRange(value: { min: number; max: number }, change: (min: number, max: number) => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "sr-range";
  wrap.innerHTML = `
    <div class="menu-group">${t("Star rating")}</div>
    <div class="sr-range-val num"></div>
    <div class="sr-range-track">
      <input type="range" class="sr-lo" min="0" max="${MAX}" step="0.1" aria-label="${t("Minimum stars")}" />
      <input type="range" class="sr-hi" min="0" max="${MAX}" step="0.1" aria-label="${t("Maximum stars")}" />
    </div>`;
  const lo = wrap.querySelector<HTMLInputElement>(".sr-lo")!;
  const hi = wrap.querySelector<HTMLInputElement>(".sr-hi")!;
  const val = wrap.querySelector<HTMLElement>(".sr-range-val")!;
  lo.value = String(value.min);
  hi.value = String(value.max === Infinity ? MAX : value.max);
  const paint = () => {
    const a = +lo.value;
    const b = +hi.value;
    wrap.style.setProperty("--lo", `${(a / MAX) * 100}%`);
    wrap.style.setProperty("--hi", `${(b / MAX) * 100}%`);
    val.textContent = b >= MAX ? (a > 0 ? t("{sr}+ stars", { sr: fixed(a, 1) }) : t("Any")) : t("{lo} – {hi} stars", { lo: fixed(a, 1), hi: fixed(b, 1) });
  };
  let timer = 0;
  const commit = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => change(+lo.value, +hi.value >= MAX ? Infinity : +hi.value), 60);
  };
  lo.addEventListener("input", () => {
    if (+lo.value > +hi.value) lo.value = hi.value;
    paint();
    commit();
  });
  hi.addEventListener("input", () => {
    if (+hi.value < +lo.value) hi.value = lo.value;
    paint();
    commit();
  });
  [lo, hi].forEach(updateRange);
  paint();
  return wrap;
}
