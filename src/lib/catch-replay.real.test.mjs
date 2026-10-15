// Real osu!catch replays (exported by `export_real_replays` in src-tauri/src/replay.rs with
// FUMEN_REPLAY_RULESET=fruits, folder in FUMEN_CATCH_REPLAY_EXPORT): the judging should come out
// at lazer's own counts. Plain JS, as it reads files.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CatchChart } from "../ui/catch/chart";
import { CatchReplay, catchUnreplayed } from "./catch-replay";

const dir = process.env.FUMEN_CATCH_REPLAY_EXPORT;
describe.skipIf(!dir || !existsSync(dir))("real osu!catch replays", () => {
  for (const file of dir && existsSync(dir) ? readdirSync(dir) : []) {
    const c = JSON.parse(readFileSync(join(dir, file), "utf8"));
    it.skipIf(catchUnreplayed(c.mods).length > 0)(file, () => {
      const r = new CatchReplay(new CatchChart({ catch: c.catch, kiai: [] }), c.frames);
      const got = [r.great, r.miss, r.largeTickHit, r.largeTickMiss, r.smallTickHit, r.smallTickMiss, r.largeBonus];
      const st = c.statistics ?? {};
      const want = [st.great ?? 0, st.miss ?? 0, st.large_tick_hit ?? 0, st.large_tick_miss ?? 0, st.small_tick_hit ?? 0, st.small_tick_miss ?? 0, st.large_bonus ?? 0];
      console.log(file, c.mods.join("") || "nomod", "lazer", want.join("/"), "fumen", got.join("/"), "accuracy", c.accuracy, r.stats(Infinity).accuracy);
      const off = got.slice(0, 6).reduce((s, v, k) => s + Math.abs(v - want[k]), 0);
      expect(off / 2).toBeLessThanOrEqual(2);
    });
  }
});
