/* lines.ts — what the end of a try means against the ones before it, for the live overlay (/obs/hud):
 * a word under the rank on the left ("First pass after 9 tries", "Ended here 5 times now") and
 * one under the pp on the right ("New best, +14 pp", "Your best stays 99.10%"). Pure. */
import { pct } from "../lib/format";
import { t } from "../lib/i18n";
import type { ObsBest, ObsTries } from "../lib/obs-parts";

export type Tone = "plain" | "accent" | "danger";

export interface Said {
  text: string;
  icon: "repeat" | "flag" | "star" | "check";
  tone: Tone;
}

export interface EndInput {
  /** your tries at the map before this one */
  tries: ObsTries | null;
  /** your best on it before this one */
  best: ObsBest | null;
  /** where the try ended, song ms */
  at: number;
  kind: "fc" | "pass" | "fail";
  score: number;
  pp: number | null;
}

export function endWords(i: EndInput): { left: Said | null; right: Said | null } {
  const tr = i.tries;
  const n = tr?.count ?? 0;
  if (i.kind === "fail") {
    const s = tr?.spot;
    const there = s && i.at >= s.a - 1500 && i.at <= s.b + 1500;
    return { left: there ? { text: t("Ended here {n} times now", { n: s.stops + 1 }), icon: "flag", tone: "danger" } : null, right: null };
  }
  const left: Said | null = tr && n && !tr.passes ? { text: t("First pass after {n} tries", { n: n + 1 }), icon: "check", tone: "accent" } : null;
  const b = i.best;
  if (!b) return { left: left ?? { text: t("First pass"), icon: "check", tone: "accent" }, right: null };
  if (newBest(i, b)) {
    const gain = i.pp !== null && b.pp !== null ? Math.round(i.pp - b.pp) : null;
    return { left, right: { text: gain !== null && gain > 0 ? t("New best, +{pp} pp", { pp: gain }) : t("New best"), icon: "star", tone: "accent" } };
  }
  return { left, right: { text: t("Your best stays {acc}", { acc: pct(b.accuracy) }), icon: "star", tone: "plain" } };
}

/** A pass beats the best before it: more pp when both have them, else more score. */
export function newBest(e: { score: number; pp: number | null }, b: ObsBest): boolean {
  if (e.pp !== null && b.pp !== null && Math.abs(e.pp - b.pp) > 0.5) return e.pp > b.pp;
  return e.score > b.score;
}
