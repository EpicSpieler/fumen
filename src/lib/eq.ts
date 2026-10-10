/* eq.ts — frequency bars for the fullscreen visualizer, read from the player's own audio.
 *
 * The audio element is routed through Web Audio once, on first use (it must start from a user
 * gesture). The element loads with CORS ("anonymous"; fumen:// answers with
 * Access-Control-Allow-Origin), otherwise the analyser would only ever see silence.
 */
import { player } from "../player";

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let bins: Uint8Array<ArrayBuffer> = new Uint8Array(0);

/** Starts (or resumes) the analyser; false when Web Audio isn't available. */
export function startAnalyser(): boolean {
  try {
    if (!ctx) {
      ctx = new AudioContext();
      const source = ctx.createMediaElementSource(player.audio);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0.7;
      analyser.minDecibels = -88;
      analyser.maxDecibels = -18;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      bins = new Uint8Array(analyser.frequencyBinCount);
    }
    if (ctx.state === "suspended") void ctx.resume();
    return true;
  } catch (e) {
    console.warn("[eq] no analyser", e);
    return false;
  }
}

/**
 * Fills `out` with one level (0–1) per bar, log-spaced from 32 Hz to 16 kHz like a spectrum
 * analyser. Returns false when there's nothing to read.
 */
export function readBars(out: Float32Array): boolean {
  if (!analyser || !ctx) return false;
  analyser.getByteFrequencyData(bins);
  const n = out.length;
  const hzPerBin = ctx.sampleRate / analyser.fftSize;
  const lo = 32;
  const hi = 16000;
  for (let i = 0; i < n; i++) {
    const f0 = lo * Math.pow(hi / lo, i / n);
    const f1 = lo * Math.pow(hi / lo, (i + 1) / n);
    const b0 = Math.max(1, Math.floor(f0 / hzPerBin));
    const b1 = Math.max(b0 + 1, Math.ceil(f1 / hzPerBin));
    let peak = 0;
    for (let b = b0; b < b1 && b < bins.length; b++) peak = Math.max(peak, bins[b]);
    // treble carries less energy; lift it a little so the right side isn't always flat
    const tilt = 0.82 + 0.3 * (i / n);
    out[i] = Math.min(1, (peak / 255) * tilt);
  }
  return true;
}
