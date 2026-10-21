/* pp.ts — what a difficulty is worth in pp, as osu! works it out (the numbers come from
 * src-tauri/src/pp.rs): which judgements a play is entered in per ruleset, the mods that change
 * pp, and the plays the chart panel asks about at once (its play, accuracy steps and graph). */
import type { PpHits } from "./types";

export type PpKind = "great" | "good" | "ok" | "meh" | "miss" | "tinyMiss";

export interface PpKindInfo {
  kind: PpKind;
  label: string;
  /** OsuColour.ForHitResult */
  color: string;
}

const GREAT = "#66ccff";
const GOOD = "#b3d944";
const OK = "#88b300";
const MEH = "#ffcc22";
const MISS = "#ed1121";

/** The judgements a play is entered in, by ruleset; the best one is whatever is left. */
export function ppKinds(mode: number): PpKindInfo[] {
  switch (mode) {
    case 3:
      return [
        { kind: "great", label: "Great", color: GREAT },
        { kind: "good", label: "Good", color: GOOD },
        { kind: "ok", label: "Ok", color: OK },
        { kind: "meh", label: "Meh", color: MEH },
        { kind: "miss", label: "Miss", color: MISS },
      ];
    case 2:
      return [
        { kind: "miss", label: "Miss", color: MISS },
        { kind: "tinyMiss", label: "Tiny droplet miss", color: MEH },
      ];
    case 1:
      return [
        { kind: "ok", label: "Ok", color: OK },
        { kind: "miss", label: "Miss", color: MISS },
      ];
    default:
      return [
        { kind: "ok", label: "Ok", color: OK },
        { kind: "meh", label: "Meh", color: MEH },
        { kind: "miss", label: "Miss", color: MISS },
      ];
  }
}

/** The lines the graph shows to start with. */
export function ppShownFirst(mode: number): PpKind[] {
  if (mode === 3) return ["good", "miss"];
  if (mode === 2) return ["miss", "tinyMiss"];
  return ["ok", "miss"];
}

/** Whether a play's longest combo changes its pp (osu!, osu!catch). */
export const ppTakesCombo = (mode: number): boolean => mode === 0 || mode === 2;

export type PpMod = "EZ" | "NF" | "HT" | "HR" | "DT" | "HD" | "FL";

export const PP_MOD_NAMES: Record<PpMod, string> = {
  EZ: "Easy",
  NF: "No Fail",
  HT: "Half Time",
  HR: "Hard Rock",
  DT: "Double Time",
  HD: "Hidden",
  FL: "Flashlight",
};

/** The mods that change pp in a ruleset, in lazer's order (osu!mania: only these four do). */
export function ppModsFor(mode: number): PpMod[] {
  return mode === 3 ? ["EZ", "NF", "HT", "DT"] : ["EZ", "NF", "HT", "HR", "DT", "HD", "FL"];
}

/** Whether osu! gives pp for plays on a map with this status (ranked or approved). */
export const givesPp = (status: number): boolean => status === 1 || status === 2;

/** A count a play can't go past: the judgements a play has (osu!catch's tiny droplets apart). */
export const ppLimit = (kind: PpKind, total: number, tiny: number): number => (kind === "tinyMiss" ? tiny : total);

/** 1, 2, 2.5 or 5 times a power of ten, at least `v` */
export function niceCeil(v: number): number {
  if (v <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return Math.round(m * p);
  return Math.round(10 * p);
}

/** How far the graph's count axis goes: about 6% of the judgements, past the play entered. */
export function graphReach(limit: number, count: number): number {
  const want = Math.max(10, limit * 0.06, count * 1.3);
  return Math.max(1, Math.min(limit, niceCeil(want)));
}

/** The counts along the graph's axis: whole numbers, about 48 of them. */
export function graphSteps(reach: number): number[] {
  const n = Math.min(reach, 48);
  const out = new Set<number>();
  for (let i = 0; i <= n; i++) out.add(Math.round((i / n) * reach));
  return [...out];
}

/** The accuracies the panel lists under the perfect play. */
export const PP_STEPS = [99, 98, 97, 95];

export type PpCounts = Record<PpKind, number>;
export const noCounts = (): PpCounts => ({ great: 0, good: 0, ok: 0, meh: 0, miss: 0, tinyMiss: 0 });

/** What the panel asks pp.rs at once, and where each answer lands. */
export interface PpAsk {
  plays: PpHits[];
  /** the play entered */
  play: number;
  /** each accuracy step's index */
  steps: number[];
  /** per line: the counts along the axis and their plays' indices, and the play with one more */
  lines: { kind: PpKind; xs: number[]; at: number[]; next: number }[];
}

/** The panel's questions: the play typed in, the accuracy steps, and each shown line from 0 to
 * `reach` (the other counts as typed in). */
export function ppAsk(mode: number, counts: PpCounts, combo: number | null, shown: readonly PpKind[], reach: number): PpAsk {
  const plays: PpHits[] = [];
  const hits = (c: PpCounts): PpHits => {
    const h: PpHits = {};
    for (const { kind } of ppKinds(mode)) if (c[kind]) h[kind] = c[kind];
    if (combo !== null && ppTakesCombo(mode)) h.combo = combo;
    return h;
  };
  const add = (h: PpHits) => plays.push(h) - 1;
  const play = add(hits(counts));
  const steps = PP_STEPS.map((acc) => add({ acc }));
  const lines = shown.map((kind) => {
    const xs = graphSteps(reach);
    return { kind, xs, at: xs.map((x) => add(hits({ ...counts, [kind]: x }))), next: add(hits({ ...counts, [kind]: counts[kind] + 1 })) };
  });
  return { plays, play, steps, lines };
}
