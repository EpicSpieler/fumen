import { describe, expect, it } from "vitest";
import { wavFallback } from "./wav";

/** A RIFF WAVE file with a 16-byte fmt (plus `extra`) and the given data. */
function wav(format: number, channels: number, blockAlign: number, data: number[], extra: number[] = []): ArrayBuffer {
  const fmtLen = 16 + extra.length;
  const bytes = new Uint8Array(12 + 8 + fmtLen + 8 + data.length);
  const v = new DataView(bytes.buffer);
  const tag = (p: number, s: string) => [...s].forEach((ch, i) => (bytes[p + i] = ch.charCodeAt(0)));
  tag(0, "RIFF");
  v.setUint32(4, bytes.length - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, fmtLen, true);
  v.setUint16(20, format, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, 44100, true);
  v.setUint16(32, blockAlign, true);
  bytes.set(extra, 36);
  const d = 36 + extra.length;
  tag(d, "data");
  v.setUint32(d + 4, data.length, true);
  bytes.set(data, d + 8);
  return bytes.buffer;
}

const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const samples = (c: Float32Array) => [...c].map((x) => Math.round(x * 32768));

describe("wavFallback", () => {
  it("hands back the Ogg stream inside a WAV", () => {
    const ogg = [..."OggS"].map((c) => c.charCodeAt(0)).concat([0, 2, 9, 9]);
    const alt = wavFallback(wav(0x674f, 2, 1, ogg));
    expect(alt && "encoded" in alt && [...new Uint8Array(alt.encoded)]).toEqual(ogg);
  });

  it("decodes Microsoft ADPCM", () => {
    // predictor 0 (256, 0), delta 16, sample1 100, sample2 50; nibbles 0 0 1 0
    const block = [0, ...le16(16), ...le16(100), ...le16(50), 0x00, 0x10];
    const alt = wavFallback(wav(0x2, 1, block.length, block));
    expect(alt && "channels" in alt && samples(alt.channels[0])).toEqual([50, 100, 100, 100, 116, 116]);
  });

  it("decodes IMA ADPCM", () => {
    // predictor 0, step index 0; nibbles (low first) 7, then zeros
    const block = [...le16(0), 0, 0, 0x07, 0, 0, 0];
    const alt = wavFallback(wav(0x11, 1, block.length, block));
    expect(alt && "channels" in alt && samples(alt.channels[0])).toEqual([0, 11, 13, 14, 15, 16, 17, 18, 19]);
  });

  it("leaves everything else alone", () => {
    expect(wavFallback(wav(0x1, 1, 2, [1, 2, 3, 4]))).toBeNull();
    expect(wavFallback(wav(0x31, 1, 65, new Array(65).fill(0)))).toBeNull();
    expect(wavFallback(new Uint8Array([1, 2, 3]).buffer)).toBeNull();
  });
});
