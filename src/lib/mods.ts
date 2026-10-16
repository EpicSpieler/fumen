/* mods.ts — lazer's mods as Fumen's playfield plays them (MIT, ppy Pty Ltd): which ones each ruleset
 * has, which don't go together, what they do to a difficulty's numbers, and which of them change
 * the chart itself (Easy, Hard Rock, Mirror: built in Rust, src-tauri/src/mods.rs; the playfield
 * draws Hidden, Fade In and Flashlight). Rate mods are the player's rate. */
import { t } from "./i18n";

export type Mod = "EZ" | "HR" | "HD" | "FI" | "FL" | "MR";

/** lazer's order (reductions, increases, conversions) */
export const MOD_ORDER: readonly Mod[] = ["EZ", "HR", "HD", "FI", "FL", "MR"];

/** Each ruleset's mods, by mode (0 osu!, 1 osu!taiko, 2 osu!catch, 3 osu!mania). */
const BY_RULESET: Record<number, readonly Mod[]> = {
  0: ["EZ", "HR", "HD", "FL", "MR"],
  1: ["EZ", "HR", "HD", "FL"],
  2: ["EZ", "HR", "HD", "FL", "MR"],
  3: ["EZ", "HR", "HD", "FI", "FL", "MR"],
};

export const modsFor = (mode: number): readonly Mod[] => BY_RULESET[mode] ?? [];

export const MOD_NAMES: Record<Mod, string> = {
  EZ: "Easy",
  HR: "Hard Rock",
  HD: "Hidden",
  FI: "Fade In",
  FL: "Flashlight",
  MR: "Mirror",
};

/** What a mod does in a ruleset, for its tooltip. */
export function modEffect(m: Mod, mode: number): string {
  switch (m) {
    case "EZ":
      return mode === 1 ? t("Slower scroll, OD and HP halved") : mode === 3 ? t("Wider hit windows, HP halved") : t("CS, AR, OD and HP halved");
    case "HR":
      if (mode === 0) return t("CS ×1.3, AR, OD and HP ×1.4, flipped top to bottom");
      if (mode === 1) return t("Faster scroll, OD and HP ×1.4");
      if (mode === 2) return t("CS ×1.3, AR, OD and HP ×1.4, fruits pushed further apart");
      return t("Tighter hit windows, HP ×1.4");
    case "HD":
      if (mode === 0) return t("No approach circles, objects fade out");
      if (mode === 1) return t("Notes fade out on their way");
      if (mode === 2) return t("Fruits fade out as they fall");
      return t("Notes fade out before the hit line, more as the combo grows");
    case "FI":
      return t("Notes appear out of nowhere, later as the combo grows");
    case "FL":
      if (mode === 0) return t("Only around the cursor, smaller as the combo grows");
      if (mode === 1) return t("Only around the hit target, smaller as the combo grows");
      if (mode === 2) return t("Only around the catcher, smaller as the combo grows");
      return t("Only a band across the middle");
    case "MR":
      return mode === 3 ? t("Columns flipped") : mode === 2 ? t("Fruits flipped left to right") : t("Flipped left to right");
  }
}

/** Mods lazer won't take together in a ruleset. */
function clash(a: Mod, b: Mod, mode: number): boolean {
  const pair = (x: Mod, y: Mod) => (a === x && b === y) || (a === y && b === x);
  if (pair("EZ", "HR")) return true;
  if (mode === 0 && pair("HR", "MR")) return true;
  // osu!mania: the covers and the flashlight are one each
  return mode === 3 && (pair("HD", "FI") || pair("HD", "FL") || pair("FI", "FL"));
}

const ordered = (mods: Iterable<Mod>): Mod[] => {
  const set = new Set(mods);
  return MOD_ORDER.filter((m) => set.has(m));
};

/** The picked mods that work in a ruleset; of two that don't go together, the first in lazer's order. */
export function activeMods(mods: readonly Mod[], mode: number): Mod[] {
  const own = modsFor(mode);
  const out: Mod[] = [];
  for (const m of ordered(mods)) if (own.includes(m) && !out.some((o) => clash(o, m, mode))) out.push(m);
  return out;
}

/** Turns a mod on or off in a ruleset; turning one on turns off those it doesn't go with there. */
export function toggleMod(mods: readonly Mod[], m: Mod, mode: number): Mod[] {
  if (mods.includes(m)) return ordered(mods.filter((x) => x !== m));
  return ordered([...mods.filter((x) => !clash(x, m, mode)), m]);
}

/** The mods that change the chart itself in a ruleset, as the backend takes them. */
export interface ChartMods {
  easy: boolean;
  hardRock: boolean;
  mirror: boolean;
}

export function chartMods(mods: readonly Mod[], mode: number): ChartMods {
  const on = activeMods(mods, mode);
  return {
    easy: mode !== 3 && on.includes("EZ"),
    hardRock: mode !== 3 && on.includes("HR"),
    mirror: mode !== 1 && on.includes("MR"),
  };
}

export const chartModsKey = (c: ChartMods): string => (c.easy ? "EZ" : "") + (c.hardRock ? "HR" : "") + (c.mirror ? "MR" : "");

/** Whether a star rating holds with these mods: osu!mania's doesn't change with them (Fumen works
 * out its rates); for the others only lazer's own number is known, without difficulty mods. */
export const starsKnown = (mods: readonly Mod[], mode: number): boolean => mode === 3 || activeMods(mods, mode).every((m) => m === "MR");

export interface Difficulty {
  cs: number;
  ar: number;
  od: number;
  hp: number;
}

/** IBeatmapDifficultyInfo.DifficultyRange and its inverse */
const range = (d: number, min: number, mid: number, max: number): number => (d > 5 ? mid + ((max - mid) * (d - 5)) / 5 : d < 5 ? mid - ((mid - min) * (5 - d)) / 5 : mid);
const inverse = (v: number, min: number, mid: number, max: number): number =>
  Math.sign(v - mid) === Math.sign(max - mid) ? 5 + (5 * (v - mid)) / (max - mid) : 5 - (5 * (mid - v)) / (mid - min);
const f32 = Math.fround;

/**
 * A difficulty's settings with mods and a rate, as lazer's song select shows them: Easy halves,
 * Hard Rock ×1.4 (CS ×1.3) up to 10 (osu!mania: only HP, its hit windows change instead); at a
 * rate, AR from the approach time (osu!, osu!catch) and OD from the great window (osu!, osu!taiko).
 */
export function adjustDifficulty(d: Difficulty, mods: readonly Mod[], mode: number, rate = 1): Difficulty {
  const on = activeMods(mods, mode);
  const hr = on.includes("HR");
  const ez = on.includes("EZ");
  const scale = (v: number, ratio = 1.4) => (hr ? Math.min(f32(f32(v) * f32(ratio)), 10) : ez ? f32(v) * 0.5 : v);
  const out: Difficulty = { ...d };
  out.hp = scale(d.hp);
  if (mode !== 3) {
    out.od = scale(d.od);
    if (mode === 0 || mode === 2) {
      out.cs = scale(d.cs, 1.3);
      out.ar = scale(d.ar);
    }
  }
  if (rate !== 1) {
    if (mode === 0 || mode === 2) out.ar = inverse(range(out.ar, 1800, 1200, 450) / rate, 1800, 1200, 450);
    if (mode === 0) out.od = inverse(range(out.od, 80, 50, 20) / rate, 80, 50, 20);
    if (mode === 1) out.od = inverse(range(out.od, 50, 35, 20) / rate, 50, 35, 20);
  }
  return out;
}
