/* wav.ts — WAV files the webview can't decode but lazer plays (its audio library and Windows'
 * codecs do), common in keysounded charts:
 *
 *  - Ogg Vorbis or MP3 inside a WAV container (format 0x674f …, 0x55): the data chunk is a plain
 *    Ogg / MP3 stream, handed back for the browser to decode;
 *  - Microsoft ADPCM (0x2) and IMA ADPCM (0x11): decoded here, to the samples ffmpeg gives.
 *
 * Anything else (GSM, …) stays undecodable: that sound is silent.
 */

export type WavFallback = { encoded: ArrayBuffer } | { channels: Float32Array[]; rate: number };

interface Fmt {
  format: number;
  channels: number;
  rate: number;
  blockAlign: number;
  /** bytes after the basic 16-byte fmt (cbSize onwards) */
  extra: DataView;
}

const MS_ADPCM = 0x2;
const IMA_ADPCM = 0x11;
const MP3 = 0x55;
const EXTENSIBLE = 0xfffe;

/** What to decode instead, for a WAV the browser rejected; null when there's nothing to try. */
export function wavFallback(buf: ArrayBuffer): WavFallback | null {
  const wav = chunks(buf);
  if (!wav?.fmt || !wav.data) return null;
  const { fmt, data } = wav;
  const magic = String.fromCharCode(...data.subarray(0, 4));
  if (magic === "OggS") return { encoded: copy(data) };
  if (fmt.format === MP3 || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0) || magic.startsWith("ID3")) return { encoded: copy(data) };
  if (fmt.channels < 1 || fmt.channels > 8 || fmt.rate < 1000 || fmt.blockAlign < 1) return null;
  let channels: Float32Array[] | null = null;
  if (fmt.format === MS_ADPCM) channels = msAdpcm(fmt, data);
  else if (fmt.format === IMA_ADPCM) channels = imaAdpcm(fmt, data);
  return channels && channels[0].length ? { channels, rate: fmt.rate } : null;
}

function copy(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

/** The fmt and data chunks of a RIFF WAVE file. */
function chunks(buf: ArrayBuffer): { fmt: Fmt | null; data: Uint8Array | null } | null {
  const bytes = new Uint8Array(buf);
  const v = new DataView(buf);
  const tag = (p: number) => String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let fmt: Fmt | null = null;
  let data: Uint8Array | null = null;
  for (let p = 12; p + 8 <= bytes.length; ) {
    const id = tag(p);
    const len = v.getUint32(p + 4, true);
    const body = p + 8;
    // a data chunk longer than the file (truncated writes) ends with the file
    const end = Math.min(bytes.length, body + len);
    if (id === "fmt " && len >= 16) {
      let format = v.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the sub-format GUID's first two bytes
      if (format === EXTENSIBLE && len >= 26) format = v.getUint16(body + 24, true);
      fmt = {
        format,
        channels: v.getUint16(body + 2, true),
        rate: v.getUint32(body + 4, true),
        blockAlign: v.getUint16(body + 12, true),
        extra: new DataView(buf, body + 16, Math.max(0, end - body - 16)),
      };
    } else if (id === "data") {
      data = bytes.subarray(body, end);
      break;
    }
    p = body + len + (len & 1);
  }
  return { fmt, data };
}

const clamp16 = (x: number): number => (x > 32767 ? 32767 : x < -32768 ? -32768 : x);

// ── Microsoft ADPCM ──────────────────────────────────────────────────────

const MS_ADAPTATION = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];
const MS_COEFS: [number, number][] = [
  [256, 0],
  [512, -256],
  [0, 0],
  [192, 64],
  [240, 0],
  [460, -208],
  [392, -232],
];

function msAdpcm(fmt: Fmt, data: Uint8Array): Float32Array[] | null {
  const ch = fmt.channels;
  if (ch > 2) return null;
  const header = 7 * ch;
  const block = fmt.blockAlign;
  if (block <= header) return null;
  // coefficients from the fmt chunk when it has them
  let coefs = MS_COEFS;
  const x = fmt.extra;
  if (x.byteLength >= 6) {
    const n = x.getUint16(4, true);
    if (n > 0 && x.byteLength >= 6 + n * 4) {
      coefs = [];
      for (let i = 0; i < n; i++) coefs.push([x.getInt16(6 + i * 4, true), x.getInt16(8 + i * 4, true)]);
    }
  }
  const perBlock = ((block - header) * 2) / ch + 2;
  const blocks = Math.ceil(data.length / block);
  const out = Array.from({ length: ch }, () => new Float32Array(blocks * perBlock));
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let n = 0;
  for (let b = 0; b * block + header <= data.length; b++) {
    const p = b * block;
    const end = Math.min(data.length, p + block);
    const c1: number[] = [];
    const c2: number[] = [];
    const delta: number[] = [];
    const s1: number[] = [];
    const s2: number[] = [];
    for (let c = 0; c < ch; c++) {
      const pred = coefs[data[p + c]] ?? coefs[0];
      c1.push(pred[0]);
      c2.push(pred[1]);
      delta.push(v.getInt16(p + ch + c * 2, true));
      s1.push(v.getInt16(p + 3 * ch + c * 2, true));
      s2.push(v.getInt16(p + 5 * ch + c * 2, true));
    }
    // the two header samples come first, the older one first
    for (let c = 0; c < ch; c++) out[c][n] = s2[c] / 32768;
    for (let c = 0; c < ch; c++) out[c][n + 1] = s1[c] / 32768;
    n += 2;
    // nibbles: high one first; in stereo, high = left, low = right
    let c = 0;
    const step = (nibble: number) => {
      const signed = nibble & 8 ? nibble - 16 : nibble;
      const predicted = Math.trunc((s1[c] * c1[c] + s2[c] * c2[c]) / 256);
      const sample = clamp16(predicted + signed * delta[c]);
      s2[c] = s1[c];
      s1[c] = sample;
      delta[c] = Math.max(16, (MS_ADAPTATION[nibble] * delta[c]) >> 8);
      out[c][n] = sample / 32768;
      if (++c === ch) {
        c = 0;
        n++;
      }
    };
    for (let i = p + header; i < end; i++) {
      step(data[i] >> 4);
      step(data[i] & 15);
    }
  }
  return out.map((o) => o.subarray(0, n));
}

// ── IMA ADPCM ────────────────────────────────────────────────────────────

const IMA_STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173,
  190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
  2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818,
  18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

function imaAdpcm(fmt: Fmt, data: Uint8Array): Float32Array[] | null {
  const ch = fmt.channels;
  const header = 4 * ch;
  const block = fmt.blockAlign;
  // data comes in 4-byte words per channel
  if (block <= header || (block - header) % (4 * ch) !== 0) return null;
  const perBlock = ((block - header) * 2) / ch + 1;
  const blocks = Math.ceil(data.length / block);
  const out = Array.from({ length: ch }, () => new Float32Array(blocks * perBlock));
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let n = 0;
  for (let b = 0; b * block + header <= data.length; b++) {
    const p = b * block;
    const end = Math.min(data.length, p + block);
    const pred: number[] = [];
    const index: number[] = [];
    for (let c = 0; c < ch; c++) {
      pred.push(v.getInt16(p + c * 4, true));
      index.push(Math.min(88, data[p + c * 4 + 2]));
      out[c][n] = pred[c] / 32768;
    }
    n++;
    const nibble = (c: number, k: number): number => {
      const s = IMA_STEPS[index[c]];
      let diff = s >> 3;
      if (k & 1) diff += s >> 2;
      if (k & 2) diff += s >> 1;
      if (k & 4) diff += s;
      pred[c] = clamp16(k & 8 ? pred[c] - diff : pred[c] + diff);
      index[c] = Math.min(88, Math.max(0, index[c] + IMA_INDEX[k]));
      return pred[c] / 32768;
    };
    // per channel, 4 bytes = 8 samples, low nibble first
    const words = Math.floor((end - p - header) / (4 * ch));
    for (let w = 0; w < words; w++) {
      for (let c = 0; c < ch; c++) {
        const q = p + header + (w * ch + c) * 4;
        for (let i = 0; i < 4; i++) {
          out[c][n + i * 2] = nibble(c, data[q + i] & 15);
          out[c][n + i * 2 + 1] = nibble(c, data[q + i] >> 4);
        }
      }
      n += 8;
    }
  }
  return out.map((o) => o.subarray(0, n));
}
