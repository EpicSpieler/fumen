/* song-clock.ts — where the song is, for drawing it: moving on smoothly between the positions the
 * audio element reports. WebKitGTK (Linux) has them from GStreamer, in steps and now and then a
 * little back, and everything that fades in or out with the song's time (slider bodies, follow
 * points, the follow circle) flickered with them. The clock never goes back while the song plays,
 * leans gently toward what's reported, and jumps to it after a seek. */

/** further ahead than this (ms): a seek forward, jumped to */
const AHEAD = 100;
/** further behind than this: a seek back (a late report is never this far behind) */
const BEHIND = 300;
/** how much of the difference to the report is taken each frame */
const PULL = 0.1;

export class SongClock {
  private ms = Number.NaN;
  private at = 0;
  private reported = Number.NaN;
  /** how often the reported position went back while playing (the frame meter shows it) */
  backSteps = 0;

  /** The position to draw at, ms: `reported` from the audio element at `now` (performance.now()). */
  read(reported: number, now: number, rate: number, playing: boolean): number {
    if (playing && reported < this.reported - 0.5) this.backSteps++;
    this.reported = reported;
    if (!playing || Number.isNaN(this.ms)) return this.set(reported, now);
    const predicted = this.ms + (now - this.at) * rate;
    const off = reported - predicted;
    if (off > AHEAD || off < -BEHIND) return this.set(reported, now);
    return this.set(Math.max(this.ms, predicted + off * PULL), now);
  }

  private set(ms: number, now: number): number {
    this.ms = ms;
    this.at = now;
    return ms;
  }
}
