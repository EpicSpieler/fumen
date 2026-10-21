/* beat.ts — the beat from the beatmap, for the visualizer: where a moment of the song sits in its
 * beat and bar, from the uninherited timing points (flat [time, beat length, meter], as
 * ChartData.beats has them), and whether it's in kiai ([start, end] pairs). Song milliseconds
 * throughout, so rate mods don't change anything here. */

export interface Beat {
  /** counts beats across the whole song: a new value is a new beat */
  key: number;
  /** 0 at the beat, up to 1 just before the next */
  phase: number;
  /** the beat's place in its bar, 0 = the bar's first */
  inBar: number;
  /** the timing point's beat length, ms */
  length: number;
  meter: number;
  bpm: number;
}

/** The beat at `t`. Every timing point starts a new bar, as in osu!; before the first one its
 * beats count backwards from it. */
export function beatAt(beats: readonly number[], t: number): Beat | null {
  if (beats.length < 3) return null;
  let i = 0;
  while (i + 3 < beats.length && beats[i + 3] <= t) i += 3;
  const len = beats[i + 1];
  if (!(len > 0)) return null;
  const meter = beats[i + 2] > 0 ? beats[i + 2] : 4;
  const b = (t - beats[i]) / len;
  const whole = Math.floor(b);
  return {
    key: (i / 3) * 1e7 + whole,
    phase: b - whole,
    inBar: ((whole % meter) + meter) % meter,
    length: len,
    meter,
    bpm: 60_000 / len,
  };
}

/** Whether `t` falls in one of the kiai sections. */
export function inKiai(kiai: readonly number[], t: number): boolean {
  for (let i = 0; i + 1 < kiai.length; i += 2) {
    if (t < kiai[i]) return false;
    if (t < kiai[i + 1]) return true;
  }
  return false;
}
