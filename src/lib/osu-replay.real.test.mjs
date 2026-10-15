// Real osu! replays (exported by `export_real_replays` in src-tauri/src/replay.rs with
// FUMEN_REPLAY_RULESET=osu, folder in FUMEN_OSU_REPLAY_EXPORT): the judging should come out at
// lazer's own counts. Plain JS, as it reads files.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OsuChart } from "../ui/osu/chart";
import { OsuReplay, osuOd, osuUnreplayed } from "./osu-replay";

const dir = process.env.FUMEN_OSU_REPLAY_EXPORT;
describe.skipIf(!dir || !existsSync(dir))("real osu! replays", () => {
  for (const file of dir && existsSync(dir) ? readdirSync(dir) : []) {
    const c = JSON.parse(readFileSync(join(dir, file), "utf8"));
    it.skipIf(osuUnreplayed(c.mods).length > 0)(file, () => {
      const r = new OsuReplay(new OsuChart({ osu: c.osu }), c.frames, osuOd(c.od, c.mods), c.rate);
      const s = r.stats(Infinity).counts;
      const got = [s[1], s[3], s[4], s[5], r.largeTickHit, r.sliderTailHit, r.largeBonus];
      const st = c.statistics ?? {};
      const want = [st.great ?? 0, st.ok ?? 0, st.meh ?? 0, st.miss ?? 0, st.large_tick_hit ?? 0, st.slider_tail_hit ?? 0, st.large_bonus ?? 0];
      const off = Math.abs(got[0] - want[0]) + Math.abs(got[1] - want[1]) + Math.abs(got[2] - want[2]) + Math.abs(got[3] - want[3]);
      console.log(file, c.mods.join("") || "nomod", c.date ? new Date(c.date).toISOString().slice(0, 10) : "", "lazer", want.join("/"), "fumen", got.join("/"));
      const objects = want[0] + want[1] + want[2] + want[3];
      expect(off / 2).toBeLessThanOrEqual(Math.max(2, Math.ceil(objects * 0.002)));
      expect(Math.abs(got[4] - want[4]) + Math.abs(got[5] - want[5])).toBeLessThanOrEqual(2);
    });
  }
});
