# What tosu says (measured 2026-11-09)

Recorded from tosu 4.26.3 with osu!lazer (osu!mania), ~7 minutes: song select with mods, a pass,
a fail and retry, a quit, another pass. For 1.4 Live (src/lib/tosu.ts, src/lib/tosu-follow.ts).

## Rate and fields

- `/websocket/v2` sends a message every ~150 ms (median 154 ms).
- `state.number`: 5 song select, 2 play, 7 results. `session.playCount` stays 0 on lazer.
- `game.paused` is true in the pause menu, on the fail screen, during parts of loading and late on
  the results screen. Better than waiting for the time to stand still.
- `play.failed` turns true the moment health hits 0 (`play.healthBar.normal` 0), while the state stays 2.
- `play` has score, accuracy (0–100), hits by judgement, combo current/max, rank current/max,
  pp current/fc (also detailed), unstableRate, the hit errors. Fresh per attempt.
- `play.mods` (and in song select the mods picked there): `name` ("DT", "HRSD"), `rate`
  (DT/NC 1.5, HT/DC 0.75). Changes show within ~200 ms of clicking.
- `/websocket/v2/precise` (every second in the recording): `keys` k1/k2/m1/m2 with isPressed and
  count (osu! keys, not mania columns), `hitErrors` (all so far). No current time in it.

## A round, step by step

- **Start a map:** state 5 → 2 while `beatmap.time.live` still runs on with the menu's music for
  2–3 s (74744 → … , 51851 → 54593), then jumps to the beginning (14, 27; or -10 with lazer's
  lead-in, with `game.paused` flickering while it loads). Then it runs from there.
- **Loading and lead-in, measured again 2026-11-13 and read in lazer's code (2026.1005.0-lazer)
  and tosu's:** `beatmap.time.live` is lazer's global beatmap clock (`OsuGameBase.BeatmapClock`,
  its final clock: the track's time plus lazer's offsets), and `game.paused` only says that this
  time didn't move since tosu's last read (tosu's `states/global.ts`), not that lazer is paused.
  On the loading screen the menu's music runs on. When it hands over, `PlayerLoader.OnSuspending`
  stops the track (one message frozen, "paused"), and `Player.OnEntering` → `StartGameplay` →
  `GameplayClockContainer.Reset` seeks to the map's start: `min(0, first object − 2000, the
  storyboard's first event, first object − AudioLeadIn)` (`MasterGameplayClockContainer`). That
  jump back is the gameplay screen coming in. Before 0 lazer's gameplay clock runs on its own while
  the track waits at 0, so tosu's time sits at the start (-13 here: 0 plus the offsets, "paused")
  through the lead-in and moves when the song starts: 2 s after the jump for a first note at 0:00
  (1.1 s for one at 0.9 s, 0.3 s at 1.7 s), at once when the first note is 2 s in or later (an
  intro map ran from 281 ms on). So a map begins at the jump, not when the time moves (that's the
  first note on maps without a skip); the OBS pages go by it (`mapBegins` in src/obs/live.ts).
- **Fail:** `play.failed` true at the fail point (live 33656 here), then `game.paused` true (the
  fail screen); the time keeps creeping a little.
- **Retry:** state stays 2, `play.failed` back to false, health 100, accuracy 0, and the time
  jumps back to near the beginning (1856 here: lazer may skip the intro).
- **Quit:** `game.paused` true (pause menu), false, then state 2 → 5 with `failed` false and no
  results. Fail then quit: the same with `failed` true.
- **Pass:** `game.paused` true at the end, then state 2 → 7; `resultsScreen` fills ~100 ms later
  with `scoreId`, score, accuracy, hits, mods, maxCombo, rank, pp and createdAt. On lazer's results
  screen it then flips between this play and older scores of yours (other scoreIds) while you look
  around there: the first scoreId after entering results is the new play.
- **Results → song select:** state 7 → 5, `resultsScreen` empties again ~200 ms later.
- **Song select:** the preview's place (`live`) jumps around as you scroll; it's not a play.
