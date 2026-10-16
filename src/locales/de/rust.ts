/** What Fumen's Rust side says (errors, lazer's state, import rows), as src-tauri writes it.
 * `{name}` stands for whatever Rust fills in there (named here, `{}` there); what it fills in is
 * looked up too, so "{what} failed: {msg}" finds "Importing into lazer". `fromRust()` in
 * src/lib/i18n.ts reads this; `i18n.test.ts` checks it against src-tauri/src. */
export const rust: Record<string, string> = {
  // charts, skins, the library
  "This difficulty has no chart file.": "Dieser Schwierigkeitsgrad hat keine Chart-Datei.",
  "This difficulty's .osu file is missing.": "Die .osu-Datei dieses Schwierigkeitsgrads fehlt.",
  "This difficulty isn't in the library anymore.": "Dieser Schwierigkeitsgrad ist nicht mehr in der Bibliothek.",
  "This skin isn't in lazer anymore.": "Dieser Skin ist nicht mehr in lazer.",
  "A scan is already running": "Ein Scan läuft schon",
  "The library is being updated; try again in a moment.": "Die Bibliothek wird gerade aktualisiert; versuch es gleich nochmal.",
  "osu!lazer's data folder wasn't found. Pick it in Settings.": "Der Datenordner von osu!lazer wurde nicht gefunden. Wähle ihn in den Einstellungen.",
  "lazer's data folder wasn't found. Pick it in Settings.": "lazers Datenordner wurde nicht gefunden. Wähle ihn in den Einstellungen.",
  "The lazer reader is missing ({path}). Run `npm run sidecar`.": "Der lazer-Leser fehlt ({path}). Führ `npm run sidecar` aus.",
  "Reading lazer's database failed: {message}": "Lesen von lazers Datenbank ist fehlgeschlagen: {message}",
  "Unexpected export format {format} (expected {expected})": "Unerwartetes Exportformat {format} (erwartet {expected})",
  "osu!stable's {what} couldn't be read (an unknown version, or damaged).": "{what} von osu!stable ließ sich nicht lesen (unbekannte Version oder beschädigt).",

  // osu!lazer, importing and deleting
  "osu!lazer's installation wasn't found.": "Die Installation von osu!lazer wurde nicht gefunden.",
  "osu!lazer's installation wasn't found (it's looked for in {where}).": "Die Installation von osu!lazer wurde nicht gefunden (gesucht wird in {where}).",
  "Applications as osu!.app": "Programme als osu!.app",
  "osu!lazer {version} isn't tested with Fumen's import yet; importing stays off until it is.":
    "osu!lazer {version} ist noch nicht mit Fumens Import getestet; Importieren bleibt aus, bis es das ist.",
  "osu!lazer is running. Close it to import.": "osu!lazer läuft. Schließ es, um zu importieren.",
  "{what} failed: {msg}": "{what} ist fehlgeschlagen: {msg}",
  "Importing into lazer": "Importieren in lazer",
  "Writing lazer's collections": "Schreiben von lazers Sammlungen",
  "Deleting in lazer": "Löschen in lazer",
  Cancelled: "Abgebrochen",
  "Not an osu! beatmap link": "Kein osu!-Beatmap-Link",
  "Same set as above": "Dasselbe Set wie oben",
  "Already in your library": "Schon in deiner Bibliothek",
  "The importer didn't report on this set": "Der Importer hat zu diesem Set nichts gemeldet",
  "lazer found no beatmaps in the download": "lazer hat im Download keine Beatmaps gefunden",

  // the mirrors
  "Beatmap {beatmap} wasn't found on the mirrors": "Beatmap {beatmap} wurde auf den Mirrors nicht gefunden",
  "Couldn't find beatmap {beatmap}'s set ({why})": "Das Set von Beatmap {beatmap} wurde nicht gefunden ({why})",
  "Couldn't get difficulty {beatmap} ({why})": "Schwierigkeitsgrad {beatmap} ließ sich nicht holen ({why})",
  "The mirrors are busy for a while (rate limits); try this set again later ({why})":
    "Die Mirrors sind eine Weile ausgelastet (Rate Limits); versuch dieses Set später nochmal ({why})",
  "No download mirror has this set ({why})": "Kein Download-Mirror hat dieses Set ({why})",
  "No download mirror could deliver this set ({why})": "Kein Download-Mirror konnte dieses Set liefern ({why})",
  "The mirrors couldn't search right now (osu.direct {direct}, catboy.best {why})":
    "Die Mirrors konnten gerade nicht suchen (osu.direct {direct}, catboy.best {why})",

  // osu! and the login
  "A login is already waiting for your browser.": "Eine Anmeldung wartet schon auf deinen Browser.",
  "The browser didn't open: {e}": "Der Browser ging nicht auf: {e}",
  "The login was cancelled.": "Die Anmeldung wurde abgebrochen.",
  "The login was cancelled on osu!.": "Die Anmeldung wurde auf osu! abgebrochen.",
  "The browser didn't come back from osu! in time.": "Der Browser kam nicht rechtzeitig von osu! zurück.",
  "Your osu! login has run out. Log in again.": "Deine osu!-Anmeldung ist abgelaufen. Melde dich neu an.",
  "osu! didn't accept the login. Log in again.": "osu! hat die Anmeldung nicht akzeptiert. Melde dich neu an.",
  "Fumen's login server sent no tokens.": "Fumens Anmeldeserver hat keine Tokens geschickt.",
  "Fumen's login server said {status}.": "Fumens Anmeldeserver sagte {status}.",
  "No random numbers: {e}": "Keine Zufallszahlen: {e}",
  "You're not logged in to osu!.": "Du bist nicht bei osu! angemeldet.",
  "Log in to osu! in Settings first.": "Melde dich zuerst in den Einstellungen bei osu! an.",
  "Log in with osu! in Settings first.": "Melde dich zuerst in den Einstellungen mit osu! an.",
  "Fumen is already reading your scores from osu!.": "Fumen liest deine Scores schon von osu!.",
  "osu! doesn't have this.": "osu! hat das nicht.",
  "osu! asked Fumen to slow down. Try again in a minute.": "osu! hat Fumen gebeten, langsamer zu machen. Versuch es in einer Minute nochmal.",
  "osu! said {s}.": "osu! sagte {s}.",
  "osu! didn't answer fully ({e}).": "osu! hat nicht vollständig geantwortet ({e}).",
  "osu!'s answer wasn't readable ({e}).": "Die Antwort von osu! war nicht lesbar ({e}).",
  "osu! doesn't let Fumen download this replay.": "osu! lässt Fumen dieses Replay nicht herunterladen.",
  "osu! doesn't have this replay.": "osu! hat dieses Replay nicht.",
  "Type a player's name.": "Gib den Namen einer Person ein.",
  "osu! has no player called {name}.": "Auf osu! gibt es niemanden namens {name}.",
  "Another comparison is still stopping; try again in a moment.": "Ein anderer Vergleich stoppt noch; versuch es gleich nochmal.",

  // replays
  "This difficulty isn't on osu!.": "Dieser Schwierigkeitsgrad ist nicht auf osu!.",
  "lazer has no replay for this score.": "lazer hat kein Replay zu diesem Score.",
  "The replay file isn't in lazer's files any more. Update the library.": "Die Replay-Datei ist nicht mehr in lazers Dateien. Aktualisiere die Bibliothek.",
  "The replay file couldn't be read.": "Die Replay-Datei ließ sich nicht lesen.",

  // collections, goals, the cloud
  "That isn't a search Fumen can keep.": "Diese Suche kann Fumen nicht speichern.",
  "That collection doesn't exist any more.": "Diese Sammlung gibt es nicht mehr.",
  "That smart collection doesn't exist any more.": "Diese smarte Sammlung gibt es nicht mehr.",
  "A smart collection fills itself from its search.": "Eine smarte Sammlung füllt sich aus ihrer Suche.",
  "A collection needs a name.": "Eine Sammlung braucht einen Namen.",
  "A goal needs an id and the time it was set.": "Ein Ziel braucht eine ID und den Zeitpunkt, an dem es gesetzt wurde.",
  "That goal is too big.": "Dieses Ziel ist zu groß.",
  "Fumen's server didn't answer ({e})": "Fumens Server hat nicht geantwortet ({e})",
  "Fumen's server answered {status}": "Fumens Server antwortete {status}",
  "Nothing saved in the cloud yet.": "In der Cloud ist noch nichts gespeichert.",

  // rarely seen
  "No executable dir": "Kein Programmordner",
  "Dropped for newer thumbnails": "Für neuere Vorschaubilder verworfen",
};
