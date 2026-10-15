// Real osu!taiko replays (exported by `export_real_replays` in src-tauri/src/replay.rs with
// FUMEN_REPLAY_RULESET=taiko, folder in FUMEN_TAIKO_REPLAY_EXPORT): the judging should come out at
// lazer's own counts. Plain JS, as it reads files.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TaikoReplay, taikoOd, taikoUnreplayed } from "./taiko-replay";

const dir = process.env.FUMEN_TAIKO_REPLAY_EXPORT;
describe.skipIf(!dir || !existsSync(dir))("real osu!taiko replays", () => {
  for (const file of dir && existsSync(dir) ? readdirSync(dir) : []) {
    const c = JSON.parse(readFileSync(join(dir, file), "utf8"));
    it.skipIf(taikoUnreplayed(c.mods).length > 0)(file, () => {
      const r = new TaikoReplay(c.taiko, c.frames, taikoOd(c.od, c.mods), c.mods);
      const s = r.stats(Infinity).counts;
      const got = [s[1], s[3], s[5], r.largeBonus, r.smallBonus];
      const st = c.statistics ?? {};
      const want = [st.great ?? 0, st.ok ?? 0, st.miss ?? 0, st.large_bonus ?? 0, st.small_bonus ?? 0];
      const off = Math.abs(got[0] - want[0]) + Math.abs(got[1] - want[1]) + Math.abs(got[2] - want[2]);
      console.log(file, c.mods.join("") || "nomod", c.date ? new Date(c.date).toISOString().slice(0, 10) : "", "lazer", want.join("/"), "fumen", got.join("/"));
      expect(off / 2).toBeLessThanOrEqual(Math.max(2, Math.ceil((want[0] + want[1] + want[2]) * 0.002)));
    });
  }
});
