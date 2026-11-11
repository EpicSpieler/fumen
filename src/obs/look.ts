/* look.ts — what the OBS pages share in looks: the accent from the cover of what plays (as the
 * window does it, ui/theme), gliding over on a change; Fumen's own when there's no cover. */
import { colorFromImage, deriveAccent } from "../ui/theme";
import { parts } from "./link";

let job = 0;
let shown = "";

function apply(color: string): void {
  if (color === shown) return;
  shown = color;
  const a = deriveAccent(color);
  const root = document.documentElement.style;
  root.setProperty("--accent", a.accent);
  root.setProperty("--accent-ink", a.ink);
  root.setProperty("--on-accent", a.onAccent);
}

/** The accent from the cover at `url` (null: Fumen's own). */
export function accentFrom(url: string | null): void {
  const mine = ++job;
  const fallback = parts.config?.accent ?? "#8b7cff";
  if (!url) return apply(fallback);
  void colorFromImage(url).then((c) => {
    if (mine === job) apply(c ?? fallback);
  });
}
