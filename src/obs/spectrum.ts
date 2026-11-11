/* spectrum.ts — the song's levels for an OBS page. The page can't hear Fumen, so it loads the
 * song that plays (the overlay server hands out that one only), decodes it once to mono, and
 * reads the moment it's at like the window's two analysers would (lib/eq: 4096 and 2048 samples). */
import type { AnalyserSet, FreqSource } from "../lib/vis/analysis";
import { spectrumDb } from "./fft";

const RATE = 44100;

class Reader implements FreqSource {
  readonly frequencyBinCount: number;
  /** the sample the window ends at */
  end = 0;
  private re: Float32Array;
  private im: Float32Array;

  constructor(
    readonly fftSize: number,
    private readonly song: () => Float32Array,
  ) {
    this.frequencyBinCount = fftSize / 2;
    this.re = new Float32Array(fftSize);
    this.im = new Float32Array(fftSize);
  }

  getFloatFrequencyData(out: Float32Array): void {
    spectrumDb(this.song(), this.end, this.fftSize, out, this.re, this.im);
  }

  getFloatTimeDomainData(out: Float32Array): void {
    const s = this.song();
    const from = this.end - out.length;
    for (let i = 0; i < out.length; i++) {
      const j = from + i;
      out[i] = j >= 0 && j < s.length ? s[j] : 0;
    }
  }
}

export class Spectrum {
  private url = "";
  private samples: Float32Array | null = null;
  private job = 0;
  private readonly long = new Reader(4096, () => this.samples!);
  private readonly short = new Reader(2048, () => this.samples!);
  private readonly set: AnalyserSet = { rate: RATE, long: this.long, short: this.short };

  /** The song to read (its address), null for none; a new one loads in the background. */
  use(url: string | null): void {
    if ((url ?? "") === this.url) return;
    this.url = url ?? "";
    this.samples = null;
    const job = ++this.job;
    if (!url) return;
    void decode(url).then((s) => {
      if (job === this.job) this.samples = s;
    });
  }

  /** The analysers at `seconds` into the song; null until it's loaded. */
  at(seconds: number): AnalyserSet | null {
    if (!this.samples) return null;
    const end = Math.round(seconds * RATE);
    this.long.end = end;
    this.short.end = end;
    return this.set;
  }
}

/** The song at `url`, mono at 44.1 kHz; null when it can't be had. */
async function decode(url: string): Promise<Float32Array | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const bytes = await r.arrayBuffer();
    const buf = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(bytes);
    const out = new Float32Array(buf.length);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels;
    }
    return out;
  } catch (e) {
    console.warn("[obs] no song", e);
    return null;
  }
}
