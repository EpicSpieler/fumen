/* live.ts — plays as they happen (src-tauri/src/live.rs), for the score page and the companion
 * window: what a session is, its numbers, and how a play reads in a line. */
import { fixed } from "./format";
import type { LivePlay } from "./types";

/** a pause this long between plays starts a new session, ms */
export const SESSION_GAP = 60 * 60 * 1000;

/** When the session began: the plays (newest first) back to the first gap of an hour or more.
 * No play for an hour: a new session starts now. */
export function sessionStart(plays: readonly LivePlay[], now = Date.now()): number {
  if (!plays.length || now - plays[0].date >= SESSION_GAP) return now;
  let start = plays[0].date;
  for (let i = 1; i < plays.length; i++) {
    if (start - plays[i].date >= SESSION_GAP) break;
    start = plays[i].date;
  }
  return start;
}

export interface Session {
  plays: number;
  /** ms of song played (at the plays' rates) */
  time: number;
  /** the plays' mean accuracy */
  accuracy: number | null;
  /** plays better than anything before on their difficulty */
  bests: number;
}

/** The numbers of a session's plays. */
export function summary(plays: readonly LivePlay[]): Session {
  const time = plays.reduce((t, p) => t + (p.length ?? 0) / (p.rate ?? 1), 0);
  const accuracy = plays.length ? plays.reduce((a, p) => a + p.accuracy, 0) / plays.length : null;
  return { plays: plays.length, time, accuracy, bests: plays.filter(isBest).length };
}

/** Better than every play before it on its difficulty. */
export function isBest(p: LivePlay): boolean {
  return p.bestBefore === null || p.accuracy > p.bestBefore + 1e-9;
}

const RATE_MODS: Record<string, number> = { DT: 1.5, NC: 1.5, HT: 0.75, DC: 0.75 };

/** "HD DT 1.2×" (Classic left out: lazer adds it to every imported stable score) */
export function playMods(p: Pick<LivePlay, "mods" | "rate">): string {
  return p.mods
    .filter((m) => m !== "CL")
    .map((m) => (m in RATE_MODS && p.rate !== null && Math.abs(p.rate - RATE_MODS[m]) > 1e-6 ? `${m} ${fixed(p.rate, 2)}×` : m))
    .join(" ");
}

/** lazer's rank by name, as the number the library uses (F -1 … XH 7). */
export function rankNumber(rank: string | null | undefined): number {
  return ["F", "D", "C", "B", "A", "S", "SH", "X", "XH"].indexOf(rank ?? "F") - 1;
}
