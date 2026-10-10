# Fumen

譜面 (*fumen*): "chart" in Japanese rhythm-game slang.

Fumen is a desktop beatmap library for osu!. It reads your osu!lazer library and lets you browse,
search, filter and preview all of it quickly, and shows what each osu!mania chart asks of you.
Later versions add collections and tournament pool building (see [docs/PLAN.md](docs/PLAN.md)).

Fumen **only reads** osu!'s data. It works on a private copy of lazer's database and never writes
to osu!'s files.

## Features

- Imports the osu!lazer library: sets, difficulties, local scores and collections
- Cover grid and a list of beatmap sets that open to show their difficulties, both virtualised
  (stays smooth at 20k+ difficulties)
- osu!-style search: `keys=7 sr>4.5 status=ranked creator=… length<2:30 grade>=A played=no`
- Ruleset and key-count filters, star range, status, played / not played
- Set pages with every difficulty, notes, long-note share, notes per second and your best grade
- Plays the songs straight from lazer's files, from the beginning
- Accent colour and ambient background taken from the artwork (Kodama design language)
- Re-imports automatically when lazer's library changes
- Home page: recently played and added, most played, sets you haven't played in a while, quick picks
- Player with a queue from the list you played from, shuffle / repeat and media keys

**Charts (v0.2)**
- Every difficulty's `.osu` is analysed once in the background (all ~22k in a few seconds)
- Chart panel on the set page: an osu!mania playfield that follows the song, a notes-per-second
  graph (kiai and breaks marked) you can click to jump, peak / average density, longest burst
- Pattern read for osu!mania: stream, jumpstream, handstream, chordjack, jacks, long notes, stamina;
  chord mix, jacks, column and hand balance
- Rates: HT, DT or anything from 0.5× to 2× — the song plays at it and the panel shows star rating,
  length, BPM and density at that rate. osu!mania star ratings come from Fumen's own port of lazer's
  calculator (matches lazer's own value within 0.005★ on 99.8 % of a 5.7k-chart library)
- Search by it: `pattern=jumpstream`, `pattern=cj`, `peak>15`, `dt>6`, `ht<3`

## Development

Requirements: Node 22+, Rust (stable), .NET 8 SDK, Windows (WebView2).

```bash
npm install
npm run app          # builds the lazer reader sidecar if needed, then `tauri dev`
```

Other scripts:

| Script | What it does |
|---|---|
| `npm run sidecar` | rebuild `fumen-realm` (the .NET lazer database reader) |
| `npm run typecheck` | TypeScript checks |
| `npm test` | UI and Rust unit tests |
| `npm run dev:browser` | UI in a normal browser with Tauri shimmed (see `tools/browser-preview`) |
| `npm run tauri build` | installer |

### Layout

```
src/              UI (TypeScript, no framework)
src-tauri/        Rust backend: SQLite cache, import, .osu parser + chart analysis, fumen:// protocol
sidecar/          fumen-realm: reads lazer's client.realm (Realm .NET, dynamic + read-only)
tools/            browser preview, CDP helper
docs/PLAN.md      roadmap
```
