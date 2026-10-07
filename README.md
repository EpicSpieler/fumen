# Fumen

譜面 (*fumen*): "chart" in Japanese rhythm-game slang.

Fumen is a desktop beatmap library for osu!. It reads your osu!lazer library and lets you browse,
search, filter and preview all of it quickly. Later versions add mania chart analysis, collections
and tournament pool building (see [docs/PLAN.md](docs/PLAN.md)).

Fumen **only reads** osu!'s data. It works on a private copy of lazer's database and never writes
to osu!'s files.

## Features (v0.1)

- Imports the osu!lazer library: sets, difficulties, local scores and collections
- Cover grid and sortable difficulty table, both virtualised (stays smooth at 20k+ difficulties)
- osu!-style search: `keys=7 sr>4.5 status=ranked creator=… length<2:30 grade>=A played=no`
- Ruleset and key-count filters, star range, status, played / not played
- Set pages with every difficulty, notes, long-note share, notes per second and your best grade
- Audio preview from the map's preview point, straight from lazer's files
- Accent colour and ambient background taken from the artwork (Kodama design language)
- Re-imports automatically when lazer's library changes

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
| `npm test` | Rust unit tests |
| `npm run dev:browser` | UI in a normal browser with Tauri shimmed (see `tools/browser-preview`) |
| `npm run tauri build` | installer |

### Layout

```
src/              UI (TypeScript, no framework)
src-tauri/        Rust backend: SQLite cache, import, fumen:// file + thumbnail protocol
sidecar/          fumen-realm: reads lazer's client.realm (Realm .NET, dynamic + read-only)
tools/            browser preview, CDP helper
docs/PLAN.md      roadmap
```
