/* eq.ts — the song in Web Audio: the analysers the fullscreen visualizer reads (lib/vis/analysis),
 * and the context the playfield's hitsounds play in (on the song's clock and output path, so they
 * line up with it).
 *
 * The audio element is routed through Web Audio once, on first use (it must start from a user
 * gesture). The element loads with CORS ("anonymous"; fumen:// answers with
 * Access-Control-Allow-Origin), otherwise the analysers would only ever see silence. From then on
 * the player's volume is a gain after the analysers, so they hear the song at full level however
 * loud it's played.
 */
import { player } from "../player";

let ctx: AudioContext | null = null;
let long: AnalyserNode | null = null;
let short: AnalyserNode | null = null;

/** The context the song plays through (set up on first use), or null without Web Audio. */
export function audioContext(): AudioContext | null {
  return startAnalyser() ? ctx : null;
}

/** Starts (or resumes) the analysers; false when Web Audio isn't available. */
export function startAnalyser(): boolean {
  try {
    if (!ctx) {
      ctx = new AudioContext();
      const source = ctx.createMediaElementSource(player.audio);
      // exact in the bass (an 85 ms window at 48 kHz), quick above it (43 ms); no smoothing of their own
      long = ctx.createAnalyser();
      long.fftSize = 4096;
      long.smoothingTimeConstant = 0;
      short = ctx.createAnalyser();
      short.fftSize = 2048;
      short.smoothingTimeConstant = 0;
      const volume = ctx.createGain();
      source.connect(long);
      long.connect(short);
      short.connect(volume);
      volume.connect(ctx.destination);
      player.useGain(volume);
    }
    if (ctx.state === "suspended") void ctx.resume();
    return true;
  } catch (e) {
    console.warn("[eq] no analyser", e);
    return false;
  }
}

/** The analysers, once the song runs through Web Audio. */
export function analysers(): { ctx: AudioContext; long: AnalyserNode; short: AnalyserNode } | null {
  return ctx && long && short && ctx.state === "running" ? { ctx, long, short } : null;
}

/** How far the sound you hear lags behind the context's clock, seconds. */
export function outputLatency(): number {
  return ctx ? (ctx.outputLatency || 0) + (ctx.baseLatency || 0) : 0;
}
