/* ranks.ts — what a rank from tosu or a score is called on the OBS pages, and its colour (osu!'s). */
export const RANKS: Record<string, { label: string; color: string }> = {
  XH: { label: "SS", color: "#e4e4ee" },
  SSH: { label: "SS", color: "#e4e4ee" },
  X: { label: "SS", color: "#ff5fc8" },
  SS: { label: "SS", color: "#ff5fc8" },
  SH: { label: "S", color: "#d4e2e8" },
  S: { label: "S", color: "#2fd6e3" },
  A: { label: "A", color: "#9be33a" },
  B: { label: "B", color: "#f0bf3c" },
  C: { label: "C", color: "#ff9b6a" },
  D: { label: "D", color: "#ff6b6b" },
  F: { label: "F", color: "#ff6b6b" },
};

export const rankOf = (r: string | null | undefined): { label: string; color: string } | null => (r ? (RANKS[r] ?? { label: r, color: "#fff" }) : null);
