# OBS (1.4 Live)

Fumen as part of a stream: four browser sources for OBS and a connection to OBS itself. Planned
2026-11-11, built on branch `1.4`, ships with 1.4.0 (nothing of it as a patch before).

## The pieces

| # | What | Where |
|---|------|-------|
| 1 | The visualizer as a browser source (Stage with its reactions, all six styles; see-through over gameplay) | `/obs/stage` |
| 2 | Live overlay: combo, accuracy, pp, health, with what only Fumen knows (try N, where tries ended, further than ever, new best) | `/obs/hud` |
| 3 | Scenes switched by what osu! shows (song select, playing, results, osu! closed) | obs-websocket |
| 4 | Song card when a map starts: cover, title, mapper, stars, BPM, length, dan, patterns, your best | `/obs/card` |
| 5 | Highlight clips: the replay buffer saved after a full combo, a new best or a close pass; a chapter marker | obs-websocket |
| 6 | Session card for a break or the end: tries, passes, fails, best plays, the costliest map, a timeline of every try | `/obs/session` |

Each page is its own source so it can sit anywhere in any scene. Dropped from the first list: a
bigger tournament overlay (the one in Pools stays as it is).

## How it fits together

- **One server.** The stream overlay's server (`src-tauri/src/overlay.rs`, 127.0.0.1:24180–24189,
  this computer only, host checked) also serves the OBS pages. It starts with Fumen once switched on.
- **Real Fumen code.** The pages are a Vite entry of their own (`obs.html`, like the companion
  window), so Stage, Feel and the palette are the same code as in the window. The packaged app
  serves them from its embedded files; a dev build points the page at Vite and lets it talk back.
- **Live numbers straight from tosu.** Each page opens its own tosu connection and runs its own
  `Feel`. Fumen's window is throttled when it's in the background (1–4 fps seen in testing); OBS's
  sources aren't, so the moments land on time.
- **What only Fumen knows** (tries on this map and where they ended, your best, patterns and dan,
  beats and kiai, the session) is pushed by the window to the server and handed to the pages at
  once as server-sent events (`/obs/events`), no polling.
- **Sound for the visualizer.** A source can't hear Fumen. It loads the song that's playing (only
  that one is served) and works out the spectrum itself at tosu's song time, so it's in step with
  osu! at any rate and doesn't need Fumen to play along. With osu! closed it follows Fumen's own
  player (music in a BRB scene).
- **OBS** is reached over obs-websocket v5 (built into OBS 28+) from the window: address, password
  (sealed like the osu! login), status in words. OBS on this computer for now.

## Look

Kodama as Fumen has it, adjusted for OBS:

- Dark surfaces without outlines, text by white's opacity (t1–t4), small uppercase labels in t3,
  Instrument Sans, tabular numbers with a slightly tight spacing.
- One accent, taken from the cover of the map that plays (clamped so it stays readable), gliding
  over 0.9 s on a map change.
- No glass: a browser source can't see the scene behind it, so surfaces are solid and get their
  depth from shadows.
- No glow everywhere, nothing pulsing for its own sake, no LIVE badges. Things move when something
  happens in the play, and then with weight: digits roll, lines are uncovered rather than faded,
  springs instead of linear fades. Reduced motion is respected.

## 1. Visualizer source (`/obs/stage`)

- Parameters: `style` (default: the one set in Fumen), `bg=none` (see-through: only the lamp strip
  and the title over gameplay), `title=0`, `stats=0`.
- Stage reacts as in the window: misses, breaks, milestones, full combo, pass, fail, low health,
  the lamps ringing out.

## 2. Live overlay (`/obs/hud`)

- Combo large (rolling digits), accuracy, pp, health as a thin bar, the song's progress below with
  small ticks where your earlier tries on this map ended.
- One Fumen line at a time, rolling on a change: "Try 7 on this map"; a few seconds before the part
  where most tries ended, "3 tries ended here"; past your furthest point, "Further than ever";
  after a pass, "New best, +14 pp" or "First pass after 9 tries".
- Moments: a miss drops the combo away in red and the lost combo rises briefly; a milestone pops;
  low health turns the bar red and lets it beat; a fail greys everything; a pass or full combo
  opens the panel to rank, accuracy and pp.

## 3. Scenes

- Four states, each mapped to an OBS scene or to "don't switch": song select, playing, results,
  osu! closed.
- Fumen only switches while one of those scenes is on: a scene you picked yourself (BRB, starting
  soon) is left alone. A retry doesn't switch; a state has to hold a moment before it counts.

## 4. Song card (`/obs/card`)

- Lower third: cover, title, artist, mapper, difficulty, stars in osu!'s colour, BPM and length at
  the rate played, dan and patterns (mania), your best on the map.
- In: an accent line draws from the left, the cover lands with a slight overshoot, the lines are
  uncovered one after another, the stars count up. Out: short and clean. On a new map only, not on
  every retry. `delay` and `hold` as parameters.

## 5. Clips

- Triggers, each switchable: full combo, new best, close pass (health under 10 % at some point, or
  the first pass after 3 or more fails).
- About 3 s after the end (so the moment is in it) the replay buffer is saved; one clip per play.
- Optional: the clip named after the map, a chapter marker in the recording (OBS 30.2+, Hybrid MP4).
- "Clip saved" with "Show in folder". If the replay buffer is off, Fumen says so and can start it.

## 6. Session card (`/obs/session`)

- Duration, tries, passes, fails, left early, the best three plays, the map that cost the most,
  clips saved.
- A timeline of the session: each try a stroke, its height how far it got, passes in the accent.
- When the scene goes live the card builds up: numbers roll, the timeline draws from the left, the
  plays slide in. Background: the blurred cover, or none.
- A session runs from the last hour-long pause (as on Home); "New session" starts one by hand.

## Order

1. This plan.
2. Foundation: server routes, events, the `obs.html` entry, the Settings section.
3. Visualizer source. 4. Live overlay. 5. Song card. 6. Session card.
7. OBS connection and scenes. 8. Clips.

Tests for the logic (obs-websocket's handshake and password hash, scene rules, clip triggers, the
spectrum, the session summary), Rust tests for the server, and a fake OBS next to the fake tosu in
`tools/browser-preview/` to try scenes and clips without OBS.

## Status (2026-11-11)

All six pieces are built on `1.4` (3d8f188 to af87d93) and tried against the fake tosu and the
fake OBS in the browser preview. Open: the review by eye (frames, German texts) and a run with the
real OBS and osu!.

How they turned out, where it differs from the plan above:

- **Live overlay.** Every part (progress, title, stars, combo, health, accuracy, pp, the lines, the
  lamps) is pinned on its own and placed in Fumen: Settings, Stream & OBS, Arrange, over a pasted
  screenshot of the skin while a made-up try plays. The part where most tries ended is a flag on
  the progress line with how many ended there; it lights up 6 s before, gets a tick when you're
  through, and counts one more on a fail there. "Further than ever" rides along the line. After
  the end: "Ended here N times now", "First pass after N tries", "New best, +N pp", "Your best
  stays N". osu!'s fail screen counts as the end (tosu still says playing).
  After the first test (2026-11-11): it comes in when the map really runs (the song moving for a
  few messages, not the menu's music or the loading screen); on osu!'s results the title, the
  stars, the line and the health go; nothing across the whole screen any more (no sweeps, no
  closing dark: Stage keeps them); the lamps only while a map runs or just ended.
- **Visualizer source.** Shows while a map runs and on its results only; `?idle=1` keeps it on in
  song select and for Fumen's player (music in a BRB scene).
- **Song card.** Comes 1 s after the map really runs. The window sends the map before reading its
  chart, and the card waits for it as long as the map runs (after 4 s it goes with osu!'s words).
  The same map again within 10 s of leaving it counts as a retry: no card.
- **Scenes.** A state has to hold before it switches: playing 0.35 s, results 0.6 s, song select
  0.9 s, osu! closed 3 s. Only from one of the four scenes set; a retry stays in playing.
- **Clips.** Close pass: health under 10 % at some point, or the first pass after 3 or more fails.
  Saved 3 s after the try is kept, once per try. Named "Title [Difficulty] Full combo 2026-11-11
  21-05-33" if wanted; the chapter marker only while OBS records. The password is sealed like the
  osu! login (`obs_password_set` / `obs_password_get`); clips are renamed and shown only inside
  the folder OBS wrote them to (`src-tauri/src/clips.rs`).
- **Session card.** "Show now" sends the session as it is that moment. A map the library doesn't
  know (played in stable, downloaded since the last look at lazer) goes by the name osu! gave it
  while Fumen ran, or stays off the card.
- **Tests.** The obs-websocket client is TypeScript (`src/lib/obs-ws.ts`), so its handshake and
  password hash are tested there (`src/lib/obs-rules.test.ts`), with the scene rules and clip
  triggers; tries, bests and the session start in `src/lib/obs-parts.test.ts`; the spectrum in
  `src/obs/fft.test.ts`; the server in `overlay.rs`; clip files in `clips.rs`. The fake OBS:
  `node tools/browser-preview/fake-obs.mjs 4466 --password hunter2 [--no-replay]`.

## After the dev build's feedback (2026-11-13)

Two more parts for the live overlay, placed in Arrange like the others; both go on osu!'s results
like the title.

- **Judgements** (`judges`): each judgement with its count, as osu! names them for the ruleset
  played (osu!mania: Max, 300, 200, 100, 50, Miss). A miss pops briefly, the rest just count.
- **Keys** (`keys`): a cap per key with its presses in this try, lit while held, a trail rising for
  each press, and keys per second. tosu knows osu!'s K1/K2/M1/M2 only, not osu!mania's columns, so
  Fumen reads the keyboard itself (`src-tauri/src/keys.rs`): off until switched on in Settings,
  Stream & OBS; only the keys lazer binds to play (from lazer's key bindings, exported by the
  sidecar with the library); only while osu! is the window in front; nothing kept. Keys are told
  apart by scan code like osu!framework does, and the caps are named in the keyboard's layout.
- **Coming in.** Measured again (docs/tosu.md): lazer's time sits at the start while the loading
  screen is up, so the overlay now comes in with the first step forward, its parts a little quicker.
