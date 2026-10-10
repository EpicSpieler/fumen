/* rate.ts — the rate control (HT / 1× / DT presets and a 0.05 stepper), shared by the chart
 * panel and the fullscreen playfield. The rate itself is the player's. */
import { player, RATE_MAX, RATE_MIN, RATE_STEP } from "../player";
import { icon } from "./icons";

const RATE_PRESETS = [
  { rate: 0.75, label: "HT", tip: "Half Time · 0.75×" },
  { rate: 1, label: "1×", tip: "Normal speed" },
  { rate: 1.5, label: "DT", tip: "Double Time · 1.5×" },
];

export function rateControlHtml(): string {
  return `
    <div class="seg-pill rate-presets" role="group" aria-label="Rate">
      ${RATE_PRESETS.map((p) => `<button type="button" data-rate="${p.rate}" data-tip="${p.tip}">${p.label}</button>`).join("")}
    </div>
    <div class="rate-step">
      <button class="icon-btn sm" type="button" data-rate-step="-1" data-tip="Slower" aria-label="Slower">${icon("minus")}</button>
      <span class="rate-val num"></span>
      <button class="icon-btn sm" type="button" data-rate-step="1" data-tip="Faster" aria-label="Faster">${icon("plus")}</button>
    </div>`;
}

/** Shows the player's rate in a control rendered by `rateControlHtml`. */
export function syncRateControl(root: ParentNode): void {
  const r = player.rate;
  root.querySelectorAll<HTMLElement>("[data-rate]").forEach((b) => b.classList.toggle("active", +b.dataset.rate! === r));
  const slower = root.querySelector<HTMLButtonElement>("[data-rate-step='-1']");
  const faster = root.querySelector<HTMLButtonElement>("[data-rate-step='1']");
  if (slower) slower.disabled = r <= RATE_MIN;
  if (faster) faster.disabled = r >= RATE_MAX;
  const val = root.querySelector(".rate-val");
  if (val) val.textContent = `${r.toFixed(2)}×`;
}

/** Handles a click inside a rate control; true when it was one. */
export function rateClick(target: Element): boolean {
  const preset = target.closest<HTMLElement>("[data-rate]");
  if (preset) {
    player.setRate(+preset.dataset.rate!);
    return true;
  }
  const step = target.closest<HTMLElement>("[data-rate-step]");
  if (step) {
    player.setRate(player.rate + +step.dataset.rateStep! * RATE_STEP);
    return true;
  }
  return false;
}

/** Star rating at the player's rate: lazer's value at 1×, Fumen's table otherwise (osu!mania). */
export function starsAtRate(sr: number, table: number[]): number | undefined {
  const r = player.rate;
  return r === 1 ? sr : table[Math.round((r - RATE_MIN) / RATE_STEP)];
}
