# Fumen — plan

> 譜面 (*fumen*): "chart" in Japanese rhythm-game slang.
> A desktop beatmap library for osu! — fast, beautiful, local-first — that grows into a
> mania practice and tournament tool.

## Vision

osu!'s song select is built for *picking a map to play now*. Fumen is built for everything
around that: browsing a 20k-difficulty library, understanding what a chart actually contains,
organising it, practising with intent, and building tournament pools.

Principles:
1. **Your library, read-only and safe.** Fumen never writes to osu!'s live database. Every
   write (collections, exports) goes through an explicit export step with a backup.
2. **Fast at 20k+ maps.** Everything is cached in SQLite; the UI is virtualised; a rescan of an
   unchanged library costs nothing.
3. **mania first, other modes welcome.** Filters and analysis lead with mania (keys, LN %,
   patterns), but the library works for every ruleset.
4. **Kodama design language.** Dark, calm, borderless surfaces separated by brightness steps,
   one accent (taken from the map's background), small physical micro-animations.
   Rules: `D:\design-language\kodama-design.md` + the forbidden list in `tracker-design.md`.
5. **Grows in rings.** Each version is useful on its own; nothing is half-built behind a flag.

## Architecture

```
fumen/
├─ src/                 Frontend — TypeScript, vanilla (no framework), Vite
│  ├─ styles/           tokens.css + one file per area
│  ├─ ui/               UI kit: icons, tooltip, select, modal, toast, virtual grid
│  ├─ views/            library, collections, settings (one module per view)
│  └─ lib/              api (typed invoke wrappers), store, format helpers
├─ src-tauri/           Backend — Rust, Tauri v2
│  ├─ src/library/      SQLite cache (rusqlite), queries, filters
│  ├─ src/sources/      lazer (via sidecar), stable (osu!.db) later
│  ├─ src/protocol.rs   fumen:// scheme: serves osu! files by hash, with Range support
│  └─ binaries/         bundled sidecar exe
├─ sidecar/FumenRealm/  .NET 8 + Realm 20.1 — exports lazer's client.realm to JSON
└─ docs/
```

**Reading lazer.** lazer stores its library in a Realm database (`client.realm`, file format 24)
that has no Rust reader. A tiny .NET sidecar copies the file to a temp folder, opens the
copy **read-only in dynamic mode** (schema-agnostic, so lazer updates that add fields don't break
it), and emits one JSON document: sets, difficulties, metadata, file-hash maps, scores,
collections. Rust ingests that into SQLite. The live database is never opened, so there's no lock or
upgrade risk.

**Files.** lazer stores files content-addressed (`files/a/ab/<sha256>`). The realm gives
`Filename → Hash` per set, so backgrounds and audio are resolved to paths and served through
`fumen://file/<hash>` (sniffed MIME + HTTP Range, so audio seeks).

**Change detection.** Rescan only if `client.realm` mtime/size changed. Sets are upserted by
`ID`; removed sets are deleted.

## Roadmap

| Version | Name | What you get |
|---|---|---|
| **0.1** | Library | lazer library in a fast grid/list; search; filters (mode, keys, SR, BPM, length, OD/HP, status); set page with all difficulties; local audio playback; backgrounds; lazer collections (read-only); settings (paths, accent, theme) |
| 0.2 | Charts | `.osu` hit-object parser; mania chart preview (scrolling playfield); density/NPS graph; LN %, chord/jack/stream stats; auto pattern tags ("jumpstream", "LN", "chordjack", "tech") |
| 0.3 | Collections | Fumen collections + smart collections (saved filters); drag & drop; export to `collection.db` (stable / Collection Manager) and to lazer (lazer closed, backup first); stable source (`osu!.db` + Songs) |
| 0.4 | You | lazer scores + osu! API v2 (OAuth); play history; per-pattern skill radar; "practice next" suggestions; goals |
| 0.5 | Pools | Pool builder: NM/HD/HR/DT/FM/TB slots, mod-adjusted SR/BPM/length, look up maps you don't own via API, export to JSON/CSV/sheet + RPRO bot, pool showcase image |
| 0.6 | Tournament | Schedule, mp-link parsing + match results, OBS overlay served locally |
| 1.0 | Release | Installer, auto-update (GitHub Releases), de/en, OLED/Light/High-contrast themes, website |

## v0.1 — detailed scope

**Backend**
- [x] Tauri v2 app `dev.fumen.app`, own window controls, single window, min 1000×640
- [x] Settings in app config dir (lazer data path auto-detected at `%APPDATA%\osu`, `storage.ini` relocation); stable path comes with 0.3
- [x] Sidecar `fumen-realm.exe export <realm> <out.json>` (self-contained single-file, trimmed to ~13 MB)
- [x] Scan job: copy → export → ingest in one SQLite transaction; progress events to UI; auto-rescan when lazer changed
- [x] Schema: `sets`, `maps`, `scores`, `lazer_collections`, `lazer_collection_items`, `meta` (migrations via `user_version`)
- [x] Library snapshot: the whole library as compact JSON in one IPC call; the UI filters/sorts in memory (typing never waits on IPC)
- [x] `fumen://` protocol for file hashes (images + audio, Range) and cached JPEG thumbnails

**Frontend**
- [x] Shell (Kodama layout): full-height sidebar with search, Home/Library, collections box, profile; floating window controls; player under the content
- [x] Home: greeting, shelves (recently played / added, most played, haven't played in a while), quick picks panel
- [x] Library: virtualised cover grid + set list (sets open to show their difficulties); osu!-style query language (keys, sr, bpm, length, od, status, grade, played, …); mode + key-count chips; star range / status / played filters; sort
- [x] Set view: large background, ambient blur, difficulty table (keys, SR colour, OD, HP, notes, LN %, length), play preview
- [x] Player: songs from the beginning, queue from the list you played from (shuffled by default), repeat, seek, volume, media keys; accent from current cover
- [x] Collections view (lazer, read-only)
- [x] Settings: paths, rescan, auto-rescan, accent (dynamic / fixed), theme, ambient, original-language metadata, reduced motion
- [x] Empty / first-run state: detect lazer, one-click first scan with progress

**Done when:** first launch → auto-detect → scan of 21k maps completes in < 30 s; filtering
"7K, 4–5★" is instant; preview audio plays; nothing looks AI-generated.

## v0.2 — charts (in progress)

- [x] `.osu` parser (Rust): timing points, hit objects incl. slider/hold ends, breaks, kiai; tolerant of old formats
- [x] Analysis: density per second, peak (densest 2 s), longest burst; mania: rows/chords, jacks, LN coverage,
      one-second windows classified as stream / jumpstream / handstream / chordjack / jacks / LN; tags ≥ 15 % + stamina
- [x] Library-wide cache `chart_stats` keyed by `.osu` hash, background job after imports and on start (~2 s for 22k charts)
- [x] Chart panel on the set page: density graph with seek, stats, patterns, chords, columns
- [x] Fullscreen player (from the player bar or the panel): visualizer (art + Web Audio frequency bars)
      or the playfield at full height with live NPS / pattern / BPM / notes and the density graph;
      scroll speed and direction imported from lazer's `RulesetSetting`s (time = 11485 ms / speed,
      × rate), F3 / F4 override stored in Fumen only
- [x] Search: `pattern=…` (with short forms js/hs/cj), `peak`
- [x] Pattern tags and peak in the library table, sort by peak
- [x] Rate-adjusted view: HT / DT presets and 0.5×–2× in 0.05 steps, shared with the player (like
      lazer's rate mods); stats, times, BPM and star rating at the rate
- [x] osu!mania star rating at any rate (port of lazer's strain calculator, checked against lazer's
      stored values: 99.8 % within 0.005★); HT/DT cached per chart, search `dt>…` / `ht<…`
- [ ] Taiko / catch / osu! previews
- [ ] "tech" detection (irregular snaps, SV) — needs a better definition than a heuristic guess

## Workflow

- GitHub repo `fumen` (private until 0.1 is solid), `main` branch, small focused commits.
- CI (GitHub Actions, windows-latest): `tsc --noEmit`, `vite build`, `cargo clippy`, sidecar build.
- Releases later via `tauri-action` with the updater.

## Risks

| Risk | Mitigation |
|---|---|
| lazer bumps Realm file format | Pin Realm NuGet to lazer's version; sidecar fails loudly with a clear message; update NuGet |
| Sidecar size | Trimmed single-file publish: ~13 MB. A native Rust Realm reader stays a long-term option |
| Schema field renames in lazer | Dynamic access with per-field fallbacks; missing fields become null, never crash |
| Large library memory | Compact snapshot (indices instead of ids, no duplicate fields) + virtualised lists; revisit paging if libraries far beyond 50k difficulties show up |
