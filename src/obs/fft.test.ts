import { describe, expect, it } from "vitest";
import { spectrumDb } from "./fft";

const N = 2048;
const work = () => ({ out: new Float32Array(N / 2), re: new Float32Array(N), im: new Float32Array(N) });

describe("spectrumDb", () => {
  it("puts a sine in its bin, about where Web Audio would (−13.5 dB for full scale)", () => {
    const rate = 44100;
    const bin = 93;
    const hz = (bin * rate) / N;
    const s = Float32Array.from({ length: rate }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate));
    const { out, re, im } = work();
    spectrumDb(s, rate, N, out, re, im);
    const peak = out.indexOf(Math.max(...out));
    expect(peak).toBe(bin);
    expect(out[bin]).toBeGreaterThan(-14);
    expect(out[bin]).toBeLessThan(-13);
    // far from it the window keeps it quiet
    expect(out[bin + 40]).toBeLessThan(-90);
  });

  it("hears silence before the song starts and after it ends", () => {
    const s = new Float32Array(10_000).fill(0.5);
    const { out, re, im } = work();
    spectrumDb(s, 0, N, out, re, im);
    expect(Math.max(...out)).toBe(-200);
    spectrumDb(s, 30_000, N, out, re, im);
    expect(Math.max(...out)).toBe(-200);
  });
});
