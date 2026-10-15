// Real replays (exported by `export_real_replays` in src-tauri/src/replay.rs, folder in
// FUMEN_REPLAY_EXPORT): the judging should come out at lazer's own counts. Plain JS, as it reads files.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { maniaWindows, ManiaReplay, playedNotes, RESULTS } from "./replay";

const dir = process.env.FUMEN_REPLAY_EXPORT;
describe.skipIf(!dir || !existsSync(dir))("real replays", () => {
  for (const file of dir && existsSync(dir) ? readdirSync(dir) : []) {
    it(file, () => {
      const c = JSON.parse(readFileSync(join(dir, file), "utf8"));
      const r = new ManiaReplay(playedNotes(c.notes, c.mods), c.keys, c.frames, maniaWindows(c.od, c.mods, c.rate));
      const got = r.stats(Infinity).counts;
      const want = RESULTS.map((k) => c.statistics?.[k] ?? 0);
      // replays keep whole milliseconds, lazer judged the moment itself: a judgement or two at a
      // window's edge can land on the other side
      const off = got.reduce((s, n, i) => s + Math.abs(n - want[i]), 0) / 2;
      console.log(file, c.mods.join("") || "nomod", "lazer", want.join("/"), "fumen", got.join("/"), "acc", c.accuracy?.toFixed(4), r.stats(Infinity).accuracy.toFixed(4));
      expect(off).toBeLessThanOrEqual(Math.max(2, Math.ceil(want.reduce((s, n) => s + n, 0) * 0.002)));
    });
  }
});
