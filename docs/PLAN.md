# Fumen — plan

> 譜面 (*fumen*): "chart" in Japanese rhythm-game slang.
> A desktop beatmap library for osu! — fast, beautiful, local-first — that grows into a
> mania practice and tournament tool.

## Vision

osu!'s song select is built for *picking a map to play now*. Fumen is built for everything
around that: browsing a 20k-difficulty library, understanding what a chart actually contains,
organising it, practising with intent, and building tournament pools.

Principles:
1. **Your library, safe.** Fumen reads a copy of lazer's database. Writes into lazer (beatmap
   imports now, collections later) run lazer's own code, only while lazer is closed, only on lazer
   versions tested with Fumen, at exactly lazer's database schema, with a backup first.
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
│  ├─ src/db.rs, library.rs   SQLite cache (rusqlite) and the library snapshot
│  ├─ src/lazer.rs      lazer import (via fumen-realm)
│  ├─ src/lazer_import.rs, downloads.rs   sets into lazer (via fumen-import), mirror downloads
│  ├─ src/osu_auth.rs, osu_scores.rs   osu! login (through site/), osu!'s scores merged with lazer's
│  ├─ src/chart.rs, charts.rs, analysis.rs, stars.rs, mma/   .osu parser and chart analysis
│  ├─ src/protocol.rs   fumen:// scheme: serves osu! files by hash, with Range support
│  └─ binaries/         built helpers (fumen-realm sidecar, fumen-import)
├─ sidecar/FumenRealm/  .NET 8 + Realm 20.1 — exports lazer's client.realm to JSON
├─ sidecar/FumenImport/ .NET — runs lazer's BeatmapImporter on lazer's own runtime
├─ lazer-compat.json    lazer versions the import is tested with
├─ site/                fumen.dertesti.dev — homepage, the osu! login's server half, /updates/ (Node, no deps)
└─ docs/
```

**Reading lazer.** lazer stores its library in a Realm database (`client.realm`, file format 24)
that has no Rust reader. A tiny .NET sidecar copies the file to a temp folder, opens the
copy **read-only in dynamic mode** (schema-agnostic, so lazer updates that add fields don't break
it), and emits one JSON document: sets, difficulties, metadata, file-hash maps, scores,
collections. Rust ingests that into SQLite. The live database is never opened, so there's no lock or
upgrade risk.

**Writing to lazer.** Imports run lazer's own `BeatmapImporter`: `fumen-import` is started from a
folder of hard links to the installed lazer (plus lazer's `deps.json` / `runtimeconfig.json`), so it
runs on lazer's .NET with lazer's assemblies and reaches them by reflection — no lazer code is
copied and nothing is pinned to a version. Guards: lazer closed (process check), version in
`lazer-compat.json` (built-in copy + the one on GitHub), database schema exactly lazer's (lazer's
`RealmAccess` would migrate an older file without a backup and replace a newer one), backup of
`client.realm`. `npm run verify-lazer` tests a new lazer version end to end and lists it.

**osu! login.** osu!'s OAuth needs the client secret to issue tokens and has no flow for apps that
can't keep one, so the secret lives only on the site (`.env` on the VPS). Fumen listens on
127.0.0.1, opens osu!'s login with the site's `/oauth/callback` as the way back and
`<port>-<nonce>` as the state; the site forwards the browser to Fumen with the code (storing
nothing), and Fumen trades the code (later the refresh token) for tokens at the site's
`/oauth/token` / `/oauth/refresh`.

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
| 0.4 | You | adding beatmaps from osu! links straight into lazer; lazer scores + osu! API v2 (OAuth); play history; per-pattern skill radar; "practice next" suggestions; goals |
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
- [x] Library-wide cache `chart_stats` keyed by `.osu` hash, background job after imports and on start (~10 s for 22k charts
      with the dan rating and pattern report, ~2 s without)
- [x] Chart panel on the set page: density graph with seek, stats, patterns, chords, columns
- [x] Fullscreen player over the app window (from the player bar or the panel), playfield laid out in
      lazer's 768-unit stage space so it scales uniformly: visualizer (art + Web Audio frequency bars)
      or the playfield at full height with live NPS / pattern / BPM / notes and the density graph;
      scroll speed and direction imported from lazer's `RulesetSetting`s (time = 11485 ms / speed,
      × rate), F3 / F4 override stored in Fumen only
- [x] Search: `pattern=…` (with short forms js/hs/cj), `peak`
- [x] Pattern tags and peak in the library table, sort by peak
- [x] Rate-adjusted view: HT / DT presets and 0.5×–2× in 0.05 steps, shared with the player (like
      lazer's rate mods); stats, times, BPM and star rating at the rate
- [x] osu!mania star rating at any rate (port of lazer's strain calculator, checked against lazer's
      stored values: 99.8 % within 0.005★); HT/DT cached per chart, search `dt>…` / `ht<…`
- [x] Playfield in lazer's skins: every skin of the lazer library (imported with it), lazer's own
      argon / argon pro / triangles / classic / retro and legacy `.osk` skins drawn like lazer's
      mania components (skin.ini [Mania] per key count, @2x, animations, classic fallback), autoplay
- [x] Hitsounds in the playfield, resolved like lazer (banks, custom indexes, per-note files,
      storyboard samples; the set's own samples, then the skin's), with their own volume slider;
      Ogg-in-WAV and ADPCM keysounds decoded too (GSM WAVs stay silent)
- [x] Pattern report and dan rating, ported from ManiaMapAnalyser (MIT, `src-tauri/src/mma`):
      Interlude-style pattern clusters (core + specific patterns, speed, category, RC / LN / HB / Mix,
      SV), Azusa's dan for 4K rice (with Daniel and Sunny), Sunny on the 4K / 6K / 7K / 10K dan
      tables otherwise; checked against the analyser's own JS on 420 charts (same dans, star
      ratings within 1e-14). Dan in the chart panel at any rate, in the set and library rows,
      search `dan=gamma`, `dan>=13`, `category=…`
- [ ] Azusa's marathon correction (needs Etterna's MinaCalc), the analyser's Roxy / Mixed estimators
- [x] osu!taiko playfield: the chart converted like lazer's TaikoBeatmapConverter (rolls, swells,
      strong notes, scroll speed per timing point, bar lines; `src-tauri/src/taiko.rs`, checked on
      7071 charts), lazer's autoplay (alternating hands, strong hits with both, roll and swell
      timing), TaikoPlayfield's layout and scrolling; argon / argon pro / triangles (lazer's drum
      textures, extracted with the hit sounds) and legacy skins over classic (LegacyInputDrum,
      LegacyCirclePiece, LegacyDrumRoll, LegacySwell, LegacyTaikoScroller, pippidon);
      DrumSamplePlayer's sounds (strong second sounds, taiko- lookups, argon's volume banks and
      flourishes)
- [x] osu! playfield: the chart read like lazer (stacking, slider paths and ticks, spinners;
      `src-tauri/src/osu.rs`), OsuAutoGenerator's cursor, the playfield's timing (approach, snaking,
      follow points, spinner spins and SPM); argon / argon pro / triangles / legacy skins (circles,
      bodies, balls, follow circles, reverse arrows, spinners old and new, cursor and trail); slider
      ticks, slides and spinner spins / bonuses as lazer plays them
- [x] osu!catch playfield: CatchBeatmapConverter (juice streams with their tiny droplets, banana
      showers, osu!stable's random offsets), hyperdashes and CatchAutoGenerator
      (`src-tauri/src/catch.rs`); the catcher's plate, dash / hyperdash trails and after-images,
      hit explosions; argon / triangles / legacy skins (fruit textures, LegacyCatcherNew / Old);
      fruits' own sounds, droplets' slider ticks, bananas' rising pitch
- [x] "tech" detection: the pattern report's "Tech" (mixed speeds) and SV

## v0.3 — collections

- [x] Fumen collections: own tables (migration 11, `src/collections.rs`), difficulties by MD5 (ones
      not in the library kept and counted), resolved to library ids for the UI; make / rename /
      delete, add and take out from row menus, drag & drop from the library onto the sidebar (or its
      + for a new one); lazer's collections read-only below them, copyable into Fumen
- [x] Smart collections: the library's filters (text query, ruleset, keys, stars, status, played,
      hidden) saved as JSON in `collections.query`; members computed in the UI with the library
      search (cached per snapshot), so they follow every import; can't take maps by hand; Edit
      search loads them into the library with Save search / Done
- [x] Export: into lazer via `fumen-import collections` (lazer's RealmAccess.Write on its
      BeatmapCollections; lazer closed, tested versions, schema guard, backup first; matched by the
      remembered lazer id (migration 12, also set by "Copy into Fumen"), else by name, else new;
      verify-lazer checks it) and to a stable `collection.db` (written in Rust, via a temp file)
- [x] stable as a source (`src/stable.rs`): osu!.db read in Rust (every version since 2014,
      entry sizes before 20191106, float star ratings since 20250107), backgrounds from each
      chart's [Events], sets with `source = 'stable'`; files get keys from path + size + mtime
      (`stable_files`, migration 13) that the file resolver (`paths::Files`) serves next to lazer's
      hashes, so covers, audio, charts, analysis and hit sounds work unchanged; collection.db as
      "In osu!stable" collections (copyable into Fumen); lazer's copy of a difficulty wins in the
      snapshot; rescans skip stable while osu!.db is unchanged. Scores (scores.db): later

## v0.4 — you

- [x] Adding beatmaps: osu! links (set / beatmap pages, `osu://`, IDs) → set IDs (beatmap links via
      the mirrors' beatmap lookups) → `.osz` from mirrors (checked to be a whole zip) → lazer's own
      import (see *Writing to lazer*) → library rescan; sets already there skipped; per-line
      progress, retry of failed lines; paste anywhere in the app
- [x] Mirrors (0.4.9): nothing is ever fetched from osu!'s servers (IP-ban risk). Six mirrors
      (osu.direct, nekoha.moe, catboy.best, beatconnect.io, sayobot.cn, nerinyan.moe) share a pool:
      each set goes to the least busy, least used one (at most 2 downloads per mirror); 429 rests a
      mirror for its `Retry-After`, errors rest it 20 s doubling, three 403s in a row 5 min; a set
      waits ("held", with a countdown) for a mirror that may still have it, up to 20 min. User
      agent without a URL (catboy.best refuses those). osu.direct allows 200 downloads per hour and
      8 GiB a day per IP; its API keys (`x-ratelimit-key`, raised API limits) aren't public
- [x] After each import, what lazer's BeatmapUpdater does (0.4.9): metadata from lazer's local
      `online.db` only (used only when it's younger than a month, else lazer's code would download
      it), star rating, length, BPM, object counts — lazer's importer leaves that to the game, so
      sets showed as unknown with 0 BPM. `import --repair` finishes sets imported without it
      (first batch of every run, and "Finish them" in Add beatmaps); verify-lazer checks both
- [x] Maps you've played: every set from osu!'s play counts (`most_played`, all pages), top plays
      (200 per ruleset) and the synced scores the Performance view shows, minus what lazer has
      (`find_played_sets`); the import runs three downloads at once next to lazer's importer in
      batches of 20 (one backup, one importer start each; at most 40 sets wait on disk), can be
      stopped (the batch in lazer finishes, the rest is left out), and stops by itself when lazer
      is opened. Cards with set covers, a bar along each card, a sweep while lazer imports,
      overall counts; the list follows the sets on their way
- [x] Tested-version list `lazer-compat.json` + `npm run verify-lazer` (schema guard both ways,
      fresh-library import twice, import into a copy of the real library: +1 set, all else identical,
      every file's hash checked)
- [x] 1× star rating from Fumen's calculator for difficulties lazer hasn't rated yet
- [x] osu! API v2 login: Fumen's OAuth app (client 71003), the secret only on fumen.dertesti.dev
      (`site/`); login in Settings with profile, rank and pp; tokens renewed through the site
- [x] fumen.dertesti.dev: "upcoming project" placeholder, systemd service on the VPS, deploy script
- [x] The site live (domain on Cloudflare, tunnel route, secret set); login checked end to end
- [x] Scores and play history: osu!'s top plays (200 per ruleset), recent plays (24 h, fails too),
      per-ruleset stats and most played into their own tables (`osu_scores.rs`, a library rescan
      never touches them); merged with lazer's local scores (same online id; stable scores by
      difficulty, time and accuracy); only the player's own scores (the logged-in account, else
      lazer's most frequent player). Sync at start (if older than 10 min), after login, by hand;
      per difficulty on its set page. History view (stats, activity, recent / top / most played);
      the library's best per difficulty includes osu!'s scores
- [x] Skill radar (osu!mania, per key mode): the analysis' pattern shares go into the library
      snapshot; a play is worth its chart's star rating at the rate played (Fumen's calculator for
      rates the library has none for, cached in `rate_stars`) at 96% along osu!mania's pp curve;
      skill = share-weighted average of the five best charts with ≥ 15% of the pattern (fewer:
      "a guess"); now vs 90 days ago; the charts behind every number (`src/lib/skills.ts`)
- [x] "Practice next": per pattern, weakest first, charts in the library with ≥ 15% of it whose
      star rating lands 2–12% above the skill, at 1× or at the rate (0.75×–1.5×, where the
      library's ratings hold to ~0.02★) that gets them there; heavy shares first, then closeness,
      new charts and 1× before replays and rates; one difficulty per set, each chart once; with
      the skill a 96% pass would give
- [x] Goals: skill (pattern + key mode), chart (accuracy at a rate or faster, fair passes), osu!
      pp/rank per ruleset; stored as JSON in `goals` (migration 10, `src/goals.rs`), measured in
      `src/lib/goals.ts`, reached ones marked with the time and a toast (`lib/goals-store.ts`)
- [x] Compare skills with another player (0.4.10, `src-tauri/src/player.rs`, `lib/compare.ts`):
      osu! API with the logged-in token (user by name, top 200, firsts, recent passes, most
      played → up to 60 best-score lookups; one request at a time, 350 ms apart), charts from the
      library or single `.osu` files from osu.direct / nekoha / catboy (cached by id + md5,
      dropped after 60 days), analysed like the library's (shares, Fumen's 0.75× / 1.5× / played
      rates; osu!'s 1× rating); skills worked out by the same lib/skills code

## Workflow

- GitHub repo `fumen` (private until 0.1 is solid), `main` branch, small focused commits.
- CI (GitHub Actions): frontend (typecheck, UI tests, build) and backend (windows-latest: helpers
  build, `cargo clippy`, Rust tests), each only when its side changes.
- After a lazer update: `npm run verify-lazer -- --push` with lazer closed.
- Site changes: `node scripts/deploy-site.mjs` (the VPS's `.env` holds the osu! secret, never git).
- Releases: `npm run release -- patch` on the PC (signed NSIS installer → GitHub release in the
  private repo + fumen.dertesti.dev/updates/, which Tauri's updater reads). Built locally, not in
  CI: Windows minutes count double on a private repo.

## Risks

| Risk | Mitigation |
|---|---|
| lazer bumps Realm file format | Pin Realm NuGet to lazer's version; sidecar fails loudly with a clear message; update NuGet |
| Sidecar size | Trimmed single-file publish: ~13 MB. A native Rust Realm reader stays a long-term option |
| Schema field renames in lazer | Dynamic access with per-field fallbacks; missing fields become null, never crash |
| A lazer update changes the import | Imports switch off for untested versions; the importer finds lazer's classes by name and fails loudly; the schema guard never opens a database lazer would migrate; backup before every import; `verify-lazer` before listing a version |
| Large library memory | Compact snapshot (indices instead of ids, no duplicate fields) + virtualised lists; revisit paging if libraries far beyond 50k difficulties show up |
