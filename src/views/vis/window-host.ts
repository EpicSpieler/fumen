/* window-host.ts — the window's visualizer plays from Fumen's player: its song through the
 * analysers (lib/eq), at the time you hear it, and answers osu! while Fumen plays along with it
 * (Follow osu!). */
import { api, fileUrl, mediaUrl, thumbUrl } from "../../lib/api";
import { loadChart } from "../../lib/charts";
import { analysers, outputLatency } from "../../lib/eq";
import { follow } from "../../lib/tosu-follow";
import { player } from "../../player";
import { visPrefs, type VisHost } from "./visualizer";

export const windowHost: VisHost = {
  clear: false,
  prefs: visPrefs,
  playing: () => player.playing,
  rate: () => player.rate,
  position: () => player.audio.currentTime,
  latency: outputLatency,
  analysers: () => {
    const a = analysers();
    return a && { rate: a.ctx.sampleRate, long: a.long, short: a.short };
  },
  play: (dt, now) => (follow.alongside ? follow.feel.frame(dt, now) : null),
  artUrl: thumbUrl,
  timing: (map) => loadChart(map).then((d) => ({ beats: d.beats, kiai: d.kiai })),
  video: (map) => api.mapVideo(map).then((v) => v && { url: mediaUrl(v.file) ?? fileUrl(v.file), offset: v.offset }),
};
