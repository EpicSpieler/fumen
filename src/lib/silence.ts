/* silence.ts — where a song's sound starts, so the player can start there instead of in the
 * silence many songs open with. Only the start of the file is read (a range request on fumen://)
 * and decoded; a file that can't be decoded that way just starts at 0. */

/** quieter than this (about −50 dBFS) counts as silence */
const THRESHOLD = 0.003;
/** a lead-in shorter than this isn't worth skipping (encoder padding is ~50 ms) */
const MIN_SKIP = 0.3;
/** starts this much before the first sound, so its attack stays whole */
const MARGIN = 0.06;
/** bytes read: a quarter of a minute of a 192 kbps MP3 */
const BYTES = 384 * 1024;

/** Seconds into `channels` (at `rate` Hz) where the sound starts; 0 when it's at once or never. */
export function soundStart(channels: readonly Float32Array[], rate: number): number {
  const n = channels[0]?.length ?? 0;
  for (let i = 0; i < n; i++) {
    for (const c of channels) {
      if (Math.abs(c[i]) > THRESHOLD) {
        const at = i / rate;
        return at >= MIN_SKIP ? Math.max(0, at - MARGIN) : 0;
      }
    }
  }
  return 0;
}

const cache = new Map<string, Promise<number>>();

/** Seconds of silence at the start of the audio at `url` (cached per file). */
export function leadingSilence(url: string): Promise<number> {
  let p = cache.get(url);
  if (!p) {
    p = read(url).catch(() => 0);
    cache.set(url, p);
  }
  return p;
}

async function read(url: string): Promise<number> {
  const res = await fetch(url, { headers: { Range: `bytes=0-${BYTES - 1}` } });
  if (!res.ok) return 0;
  const data = await res.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const buf = await ctx.decodeAudioData(data);
  const channels: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c));
  return soundStart(channels, buf.sampleRate);
}
