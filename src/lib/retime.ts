/* retime.ts — where a chart's hitsound goes while a replay plays (lib/hitsounds). */

/** how far a sound and a note may be apart and still belong together, ms */
const SAME = 2;

/** When a sound at `time` plays under a replay's `hits` (sorted [note time, hit]): when its note
 * was hit, null when the note was never pressed, its own time when no note is there (slider
 * ends, storyboard samples, …). */
export function retimed(hits: readonly number[], time: number): number | null {
  // the first note at or after time - SAME
  let lo = 0;
  let hi = hits.length / 2;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hits[mid * 2] < time - SAME) lo = mid + 1;
    else hi = mid;
  }
  // notes at the same time (chords) can't be told apart: the sound comes with the first of them
  // pressed, and not at all when none was
  let found = false;
  let best = NaN;
  for (let i = lo; i < hits.length / 2 && hits[i * 2] <= time + SAME; i++) {
    found = true;
    const at = hits[i * 2 + 1];
    if (!Number.isNaN(at) && (Number.isNaN(best) || at < best)) best = at;
  }
  if (!found) return time;
  return Number.isNaN(best) ? null : best;
}
