# Fumen

譜面 (*fumen*): "chart" in Japanese rhythm-game slang.

Fumen is a desktop beatmap library for osu!. It reads your osu!lazer library and lets you browse,
search, filter and preview all of it quickly, and shows what each osu!mania chart asks of you.
Later versions add collections and tournament pool building (see [docs/PLAN.md](docs/PLAN.md)).

Fumen reads osu!'s data from a private copy of lazer's database. What it puts into lazer is beatmap
sets you add through it and collections you send there, and that is done by lazer's own code, only
while lazer is closed, only on lazer versions tested with Fumen, and with a backup of lazer's
database first (see [Adding beatmaps](#adding-beatmaps)).

## Features

- Imports the osu!lazer library: sets, difficulties, local scores and collections
- …and osu!stable's, when it's installed (Settings can switch it off or pick its folder): its
  osu!.db, the files in its Songs folder and its collection.db, read only. A difficulty that's in
  both games shows once (lazer's); `game=stable` / `game=lazer` in the search tells them apart
- Your own collections: make them with + in the sidebar, drag sets or difficulties onto them, or
  right-click › Add to collection; rename, delete, take maps out. lazer's collections show below
  and can be copied into Fumen to change them. They hold difficulties by their MD5, like lazer's
  and stable's, so nothing is lost on a rescan and they can go into either game later
- Smart collections: any search or filter in the library can be saved as one (Save as smart
  collection); it fills itself with whatever matches, after every import too. Edit search puts it
  back in the library to change and save
- Collections out of Fumen: right-click one › Put into osu!lazer (it updates the lazer collection it
  went into before, or lazer's of the same name, else becomes a new one; same safety as adding
  beatmaps), or Save as collection.db… for osu!stable and Collection Manager (close stable before
  replacing its own, it writes the file when it exits). Settings › Collections does all at once
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
- Chart panel on the set page: a notes-per-second graph (kiai and breaks marked) you can click to
  jump, peak / average density, longest burst
- Fullscreen player (fills the app window), switchable at the top: a visualizer (the art and frequency bars from the song)
  or the osu!mania or osu!taiko playfield with the live numbers beside it (notes per second, the
  pattern of this second, BPM, notes so far, density graph). osu!mania scrolls at your lazer scroll
  speed and direction (read from lazer's settings, rate mods included; F3 / F4 change it for Fumen
  only); osu!taiko scrolls the way the chart sets it, laid out like lazer's taiko playfield
- Pattern read for osu!mania: stream, jumpstream, handstream, chordjack, jacks, long notes, stamina;
  chord mix, jacks, column and hand balance
- Rates: HT, DT or anything from 0.5× to 2× — the song plays at it and the panel shows star rating,
  length, BPM and density at that rate. osu!mania star ratings come from Fumen's own port of lazer's
  calculator (matches lazer's own value within 0.005★ on 99.8 % of a 5.7k-chart library)
- Search by it: `pattern=jumpstream`, `pattern=cj`, `peak>15`, `dt>6`, `ht<3`
- The playfield in your lazer skins: every skin in your lazer library is imported with it and can be
  picked in fullscreen (lazer's own skins and `.osk` skins, drawn like lazer draws them), played by
  lazer's autoplay with the beatmap's hitsounds (custom samples and keysounds included) at their
  own volume. osu!taiko too: argon, argon pro, triangles and legacy skins (drum, notes, rolls,
  swells, explosions, the scroller and pippidon; whatever a skin leaves out comes from lazer's
  classic skin), with the drum's sounds as lazer plays them (taiko- samples, argon's own drums)
- Dan rating for osu!mania: Azusa for 4K rice, Sunny's star rating on the 4K / 6K / 7K / 10K dan
  tables otherwise (with an LN reading for long-note charts), at any rate. Shown in the chart panel
  and the difficulty rows; search `dan=gamma`, `dan>=13`, `dan>="reform 8"`
- Pattern report: the core patterns (stream, chordstream, jacks, LN coordination / density /
  wildcard) with their speed and the specific patterns inside (jumpstream, handstream, rolls,
  minijacks, column lock, inverse …), the chart's category, rice / LN / hybrid and SV;
  search `category=…`

**Adding beatmaps (v0.4)**
- Paste osu! links (set or beatmap pages, `osu://` links, set IDs; several at once, or anywhere in
  the app): Fumen downloads each set from community mirrors (osu.direct, nekoha.moe, catboy.best,
  beatconnect.io, sayobot.cn, nerinyan.moe — never from osu!'s servers), spread over all of them,
  and imports it into osu!lazer, then into its own library. A mirror that says "too many requests"
  rests as long as it asks while the others carry on; a set waits for a free mirror instead of
  failing. Sets you already have are skipped; failed ones can be retried in one click
- Each imported set gets what lazer works out after its own imports, with lazer's code: star
  ratings, length, BPM, object counts, and the ranked status from lazer's local cache of osu!'s
  beatmap data (what isn't in it, lazer looks up on its next start). Sets an older Fumen imported
  without that are finished with the next import, or with "Finish them" in Add beatmaps
- Maps you've played: logged in, Fumen finds every set you've played on osu! (play counts and top
  plays in every ruleset, plus the scores in Performance) that osu!lazer doesn't have, and
  downloads and imports all of them: three downloads at once, into lazer 20 sets at a time, each
  set a card with its cover and progress, the whole run stoppable
- Log in with osu! (Settings): your profile, rank and pp
- History: your plays from osu!lazer's local scores and, logged in, from osu! (other computers,
  stable, pp, top plays, play counts): osu!'s numbers per ruleset (pp, rank over 90 days, accuracy,
  time played), a year of activity, recent plays by day, top plays, most played; difficulties you
  played but don't have get an "Add" button. On a set page, each difficulty shows your plays on
  it with an accuracy-over-time line
- Skills (osu!mania): your skill per pattern (stream, jumpstream, handstream, chordjack, jacks,
  long notes) per key mode, as a radar against 90 days ago. A play counts as the chart's star
  rating at the rate played, at 96% accuracy along osu!'s osu!mania pp curve; a pattern's skill is
  the share-weighted average of your five best charts with it, and every number shows the charts
  behind it. "Practice next" picks charts from your library for your weakest patterns, a little
  above your skill, at 1× or at the Half Time / Double Time speed that gets them there, and shows
  what a 96% pass on each would do to the skill
- Goals: a pattern skill to reach (shown on the radar), an accuracy on a chart at a rate, or your
  osu! pp or rank. Each shows how far along it is, and Fumen ticks it off (with a note) once your
  plays or the next sync get there

## Adding beatmaps

The import runs lazer's own `BeatmapImporter` (through `sidecar/FumenImport`, on the installed
lazer's runtime), so sets land in lazer exactly as if lazer had imported them. Before every import:

- lazer must be closed;
- lazer's version must be listed in [`lazer-compat.json`](lazer-compat.json): after every lazer
  update the import switches itself off until that version is tested. Fumen reads the list built
  into it and the one on GitHub, so a version tested once works for every Fumen;
- lazer's database must be at exactly the schema the installed lazer expects (after an update,
  lazer migrates it on its next start, never Fumen);
- `client.realm` is backed up (Fumen's data folder, `lazer-backups`, the last five).

Testing a new lazer version (lazer closed): `npm run verify-lazer -- --push`. It checks the schema
guard, imports a test set into a fresh library and into a copy of yours (exactly one set more,
nothing else changed, every file intact), writes collections into that copy (one new, one of
yours changed, nothing else touched, no copy on writing again), and on success lists the version
and pushes the file.

## osu! login and the site

osu!'s login hands out tokens only for an app's client secret, and a desktop app can't keep one.
So the secret lives on Fumen's site (`site/`, served at https://fumen.dertesti.dev, which is also
Fumen's homepage) and nowhere else, not in the app and not in this repository. Fumen opens osu!'s
login page in the browser; osu! sends the browser to the site, the site hands the code on to Fumen
(listening on 127.0.0.1), and Fumen trades it for tokens at the site. The tokens stay in Fumen's
data folder (`osu-account.json`).

The site is one dependency-free Node file (`site/server.mjs`, Node 20+) running as the systemd
service `fumen-web` on the VPS, reached through the Cloudflare tunnel. `node scripts/deploy-site.mjs`
deploys it; `node scripts/deploy-site.mjs --secret` types the osu! client secret into the server's
`.env` (hidden).

## Releases and updates

`npm run release -- patch` (or `minor`, or a version) builds the Windows installer, signs it for
the updater, tags the release and puts it on GitHub (a release in the private repo) and on the site,
at `https://fumen.dertesti.dev/updates/`. Installed copies look there when they start and every few
hours; Settings › About checks on demand, and an update shows up above the profile in the sidebar.
Installing restarts Fumen (Tauri's updater checks the signature first; not while beatmaps are
going into lazer). The signing key is `~/.tauri/fumen-updater.key` on the machine that releases,
never in the repo; without it, installed copies can't be updated, so keep a copy somewhere safe.

## Development

Requirements: Node 22+, Rust (stable), .NET 8 SDK, Windows (WebView2).

```bash
npm install
npm run app          # builds the lazer reader sidecar if needed, then `tauri dev`
```

Other scripts:

| Script | What it does |
|---|---|
| `npm run sidecar` | rebuild the .NET helpers: `fumen-realm` (lazer database reader) and `fumen-import` (lazer importer) |
| `node scripts/deploy-site.mjs` | deploy the site to the VPS (`--secret`: set the osu! client secret there) |
| `npm run verify-lazer` | test the import with the installed lazer and list its version (`--check`: only test, `--push`: commit and push) |
| `npm run typecheck` | TypeScript checks |
| `npm test` | UI and Rust unit tests |
| `npm run dev:browser` | UI in a normal browser with Tauri shimmed (see `tools/browser-preview`) |
| `npm run release -- patch` | build, sign, tag and publish a release (see above) |
| `npm run tauri build` | installer only |

### Layout

```
src/              UI (TypeScript, no framework)
src-tauri/        Rust backend: SQLite cache, import, .osu parser + chart analysis, fumen:// protocol
sidecar/          fumen-realm: reads lazer's client.realm (Realm .NET, dynamic + read-only)
                  fumen-import: imports sets with lazer's own code
lazer-compat.json lazer versions the import is tested with
site/             fumen.dertesti.dev: the homepage and the osu! login's server half
tools/            browser preview, CDP helper
docs/PLAN.md      roadmap
```

## Credits

- [osu!](https://github.com/ppy/osu) (MIT, ppy Pty Ltd): the star rating calculator and the mania
  skin components Fumen's ports follow
- Beatmap mirrors [osu.direct](https://osu.direct), [nekoha.moe](https://mirror.nekoha.moe),
  [catboy.best](https://catboy.best), [beatconnect.io](https://beatconnect.io),
  [sayobot.cn](https://osu.sayobot.cn) and [nerinyan.moe](https://nerinyan.moe) for the downloads
- [ManiaMapAnalyser](https://github.com/LeoBlackMT/osumania_map_analyser) by Leo_Black (MIT): the
  pattern report and dan estimators in `src-tauri/src/mma` (licence alongside), which build on
  [Interlude](https://github.com/YAVSRG/YAVSRG)'s pattern analysis,
  [Star-Rating-Rebirth](https://github.com/sunnyxxy/Star-Rating-Rebirth) (Sunny) and
  [Daniel](https://thebagelofman.github.io/Daniel/)
