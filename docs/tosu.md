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
