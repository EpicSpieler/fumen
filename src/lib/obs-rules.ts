/* obs-rules.ts — when Fumen switches OBS's scene and when it keeps a clip (docs/OBS.md, wired up
 * in views/obs-control.ts). Pure, so the rules can be tried without OBS or osu!. */
import { STATE, type TosuNow } from "./tosu";

/** What osu! shows, as far as scenes go. */
export type OsuScene = "select" | "play" | "results" | "closed";

export const OSU_SCENES: readonly OsuScene[] = ["select", "play", "results", "closed"];

export function sceneOf(now: TosuNow | null): OsuScene {
  if (!now) return "closed";
  if (now.state === STATE.play) return "play";
  if (now.state === STATE.resultScreen) return "results";
  return "select";
}

/** ms a state has to hold before it counts: a map starting switches quickly, going back to song
 * select waits a moment (a retry from the results passes through it), osu! closing waits longer */
export const HOLD: Record<OsuScene, number> = { play: 350, results: 600, select: 900, closed: 3000 };

/**
 * One decision per state osu! settles in: switch to the scene set for it, unless it's on already,
 * nothing is set for it, or OBS shows a scene that isn't one of the four (a BRB scene, picked by
 * hand: left alone). A retry stays in "play", so it switches nothing; flicker shorter than HOLD
 * doesn't count.
 */
export class SceneRules {
  private seen: OsuScene | null = null;
  private since = 0;
  private done = false;

  /** The scene to switch to now, or null. `current` is OBS's (null when not known). */
  decide(state: OsuScene, now: number, current: string | null, scenes: Record<OsuScene, string>): string | null {
    if (state !== this.seen) {
      this.seen = state;
      this.since = now;
      this.done = false;
    }
    if (this.done || now - this.since < HOLD[state]) return null;
    this.done = true;
    const target = scenes[state];
    if (!target || current === target) return null;
    const ours = new Set(OSU_SCENES.map((s) => scenes[s]).filter(Boolean));
    if (current !== null && !ours.has(current)) return null;
    return target;
  }

  /** Forget what was decided (the scenes were set anew, OBS came again). */
  reset(): void {
    this.seen = null;
    this.done = false;
  }
}

/** What a clip is kept for, the best reason first. */
export type ClipReason = "fc" | "best" | "close";

export interface ClipFacts {
  pass: boolean;
  misses: number;
  /** better than every pass before it on the map */
  newBest: boolean;
  /** the least health during the try, 0–1 (null: not known) */
  leastHealth: number | null;
  /** fails since the last pass on the map, before this try */
  failsBefore: number;
}

/** Why this try is worth a clip, with the triggers that are switched on; null: it isn't. */
export function clipReason(f: ClipFacts, on: { fc: boolean; best: boolean; close: boolean }): ClipReason | null {
  if (!f.pass) return null;
  if (on.fc && f.misses === 0) return "fc";
  if (on.best && f.newBest) return "best";
  if (on.close && ((f.leastHealth !== null && f.leastHealth < 0.1) || f.failsBefore >= 3)) return "close";
  return null;
}

/** "Ready Steady [Hi-Fi] FC 2026-11-11 21-05-33" */
export function clipName(title: string, version: string, word: string, at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const when = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}-${p(at.getMinutes())}-${p(at.getSeconds())}`;
  return [title, version ? `[${version}]` : "", word, when].filter(Boolean).join(" ");
}
