/* autoplay.ts — what lazer's autoplay does with a chart, as a timeline: when each column's key
 * is down, and when hits are judged (notes and hold heads at their start, hold tails at their
 * end). The skins animate keys, lights, explosions and judgements from it.
 *
 * Release times follow lazer's ManiaAutoGenerator (MIT, ppy Pty Ltd): a note is let go 20 ms after
 * it, or after 90 % of the gap when the next note in the column comes sooner; holds are let go
 * exactly at their end.
 */

const RELEASE_DELAY = 20;

export class Autoplay {
  /** per column: [press, release, press, release, …], sorted */
  readonly presses: Float64Array[];
  /** per column: judged hit times, sorted */
  readonly hits: Float64Array[];
  /** every judged hit time, sorted (the judgement shows the latest one) */
  readonly allHits: Float64Array;

  /** `notes` is [time, column, length] per object, sorted by time */
  constructor(notes: ArrayLike<number>, keys: number) {
    const presses: number[][] = Array.from({ length: keys }, () => []);
    const hits: number[][] = Array.from({ length: keys }, () => []);
    const all: number[] = [];
    // the next object's start per column, found by walking backwards
    const nextStart = new Float64Array(notes.length / 3).fill(Infinity);
    const seen = new Array<number>(keys).fill(Infinity);
    for (let i = notes.length - 3; i >= 0; i -= 3) {
      const col = notes[i + 1];
      if (col < 0 || col >= keys) continue;
      nextStart[i / 3] = seen[col];
      seen[col] = notes[i];
    }
    for (let i = 0; i < notes.length; i += 3) {
      const start = notes[i];
      const col = notes[i + 1];
      const len = notes[i + 2];
      if (col < 0 || col >= keys) continue;
      const end = start + Math.max(0, len);
      let release: number;
      if (len > 0) release = end;
      else {
        const next = nextStart[i / 3];
        release = next > end + RELEASE_DELAY ? end + RELEASE_DELAY : end + (next - end) * 0.9;
      }
      const p = presses[col];
      // a press at the moment of the previous release keeps the key down
      if (p.length && p[p.length - 1] >= start) p[p.length - 1] = Math.max(p[p.length - 1], release);
      else p.push(start, release);
      hits[col].push(start);
      all.push(start);
      if (len > 0) {
        hits[col].push(end);
        all.push(end);
      }
    }
    this.presses = presses.map((p) => Float64Array.from(p));
    this.hits = hits.map((h) => Float64Array.from(h).sort());
    this.allHits = Float64Array.from(all).sort();
  }

  /** The column's key at `t`: down or not, and when it last went down / up (−∞ if never). */
  key(col: number, t: number): { down: boolean; pressed: number; released: number } {
    const p = this.presses[col];
    // last press ≤ t
    let lo = 0;
    let hi = p.length / 2;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (p[mid * 2] <= t) lo = mid + 1;
      else hi = mid;
    }
    const k = lo - 1;
    if (k < 0) return { down: false, pressed: -Infinity, released: -Infinity };
    const pressed = p[k * 2];
    const released = p[k * 2 + 1];
    return t < released ? { down: true, pressed, released: k > 0 ? p[k * 2 - 1] : -Infinity } : { down: false, pressed, released };
  }

  /** Index of the first value > t in a sorted array. */
  static upper(a: Float64Array, t: number): number {
    let lo = 0;
    let hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The latest judged hit at or before `t`. */
  lastHit(t: number): number {
    const i = Autoplay.upper(this.allHits, t);
    return i > 0 ? this.allHits[i - 1] : -Infinity;
  }
}
