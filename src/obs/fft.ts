/* fft.ts — a song's spectrum at one moment, the way Web Audio's AnalyserNode reports it (the
 * Web Audio spec: a Blackman window with α 0.16, an FFT, |X[k]| / N in dB, no smoothing). For the
 * OBS pages, which have the song's samples but nothing playing it. */

interface Table {
  rev: Uint32Array;
  cos: Float32Array;
  sin: Float32Array;
  win: Float32Array;
}

const tables = new Map<number, Table>();

function table(n: number): Table {
  let t = tables.get(n);
  if (t) return t;
  const bits = Math.log2(n);
  if (!Number.isInteger(bits)) throw new Error(`fft size ${n} isn't a power of two`);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n);
    sin[k] = Math.sin((2 * Math.PI * k) / n);
  }
  const a = 0.16;
  const win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = (1 - a) / 2 - 0.5 * Math.cos((2 * Math.PI * i) / n) + (a / 2) * Math.cos((4 * Math.PI * i) / n);
  t = { rev, cos, sin, win };
  tables.set(n, t);
  return t;
}

/** The spectrum of the `n` samples ending at `end` (before the start or past the end: silence),
 * in dB per bin into `out` (n / 2 of them). `re` and `im` are work space of `n` each. */
export function spectrumDb(samples: Float32Array, end: number, n: number, out: Float32Array, re: Float32Array, im: Float32Array): void {
  const t = table(n);
  const from = end - n;
  for (let i = 0; i < n; i++) {
    const s = from + i;
    const j = t.rev[i];
    re[j] = s >= 0 && s < samples.length ? samples[s] * t.win[i] : 0;
    im[j] = 0;
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k++) {
        const wr = t.cos[k * step];
        const wi = -t.sin[k * step];
        const a = i + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
  for (let k = 0; k < n / 2 && k < out.length; k++) {
    const m = Math.hypot(re[k], im[k]) / n;
    out[k] = m > 1e-10 ? 20 * Math.log10(m) : -200;
  }
}
