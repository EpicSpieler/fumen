/** Settings. */
export const settings: Record<string, string> = {
  // osu! account
  "osu! account": "osu!-Konto",
  "Logged in as {name}": "Angemeldet als {name}",
  "Couldn't read your scores from osu!: {error}": "Deine Scores ließen sich nicht von osu! lesen: {error}",
  "Finish logging in on the page that opened in your browser. Fumen picks it up from there.":
    "Schließ die Anmeldung auf der Seite ab, die sich in deinem Browser geöffnet hat. Fumen übernimmt sie von dort.",
  "No rank": "Kein Rang",
  "Log out": "Abmelden",
  "Log in to bring your osu! profile and scores into Fumen: pp, top plays and the plays from your other computers, in History. You log in on osu!'s own page; Fumen never sees your password.":
    "Melde dich an, um dein osu!-Profil und deine Scores in Fumen zu holen: pp, Top-Plays und die Plays von deinen anderen Computern, im Verlauf. Du meldest dich auf osu!s eigener Seite an; Fumen sieht dein Passwort nie.",
  "Log in with osu!": "Mit osu! anmelden",

  // library
  "Keep up to date": "Aktuell halten",
  "Count me in": "Mitzählen",
  "Counting who uses Fumen": "Wer Fumen nutzt",
  "When it starts, Fumen tells fumen.dertesti.dev that it did: a random number made on this PC and Fumen's version, nothing else. That's how many people use it gets counted. You can turn it off here or later in Settings › About.":
    "Beim Start sagt Fumen fumen.dertesti.dev Bescheid: eine Zufallszahl, die auf diesem PC entsteht, und Fumens Version, sonst nichts. So lässt sich zählen, wie viele Fumen nutzen. Du kannst das hier oder später unter Einstellungen › Über ausschalten.",
  "Turn it off": "Ausschalten",
  "When Fumen starts, it tells fumen.dertesti.dev that it did: a random number made on this PC and Fumen's version, nothing else. That's how many people use it.":
    "Beim Start sagt Fumen fumen.dertesti.dev Bescheid: eine Zufallszahl, die auf diesem PC entsteht, und Fumens Version, sonst nichts. So lässt sich zählen, wie viele Fumen nutzen.",
  "Re-import when osu!lazer's or osu!stable's library changed since the last import.":
    "Neu importieren, wenn sich die Bibliothek von osu!lazer oder osu!stable seit dem letzten Import geändert hat.",
  "osu!lazer folder": "osu!lazer-Ordner",
  "osu!lazer data folder": "Datenordner von osu!lazer",
  "osu!stable folder": "osu!stable-Ordner",
  "Not found": "Nicht gefunden",
  "Not found in the chosen folder": "Im gewählten Ordner nicht gefunden",
  "Not found in {path}": "Nicht gefunden in {path}",
  "Use default": "Standard verwenden",
  "Import now": "Jetzt importieren",
  "Library imported": "Bibliothek importiert",
  "Imported {when}.": "Importiert {when}.",
  "Imported {when}. osu! has changed since then.": "Importiert {when}. osu! hat sich seitdem geändert.",
  "Not imported yet.": "Noch nicht importiert.",
  "Ones lazer has too show once.": "Was lazer auch hat, erscheint nur einmal.",
  "Its beatmaps come in with the next import.": "Seine Beatmaps kommen mit dem nächsten Import dazu.",
  "Off: only osu!lazer's beatmaps are in the library.": "Aus: Nur die Beatmaps aus osu!lazer sind in der Bibliothek.",
  "Use osu!stable's beatmaps": "Beatmaps aus osu!stable verwenden",
  "That folder doesn't contain an osu!lazer database.": "In diesem Ordner liegt keine Datenbank von osu!lazer.",
  "That folder doesn't hold osu!stable (an osu!.db and a Songs folder).":
    "In diesem Ordner liegt kein osu!stable (eine osu!.db und ein Songs-Ordner).",

  // collections
  "Collections in the cloud": "Sammlungen in der Cloud",
  "Every collection (Fumen's, smart ones, osu!lazer's and osu!stable's) kept on Fumen's server under your osu! login. On another PC, Get them merges them in by name and downloads the sets you don't have.":
    "Alle Sammlungen (die aus Fumen, smarte, die aus osu!lazer und osu!stable) auf Fumens Server, unter deinem osu!-Login. Auf einem anderen PC führt Holen sie nach Namen zusammen und lädt die Sets herunter, die dir fehlen.",
  "Get them": "Holen",
  "Save to the cloud": "In der Cloud speichern",
  "{n} collection saved to the cloud|{n} collections saved to the cloud":
    "{n} Sammlung in der Cloud gespeichert|{n} Sammlungen in der Cloud gespeichert",
  "Couldn't save them: {error}": "Speichern hat nicht geklappt: {error}",
  "{n} from the cloud": "{n} aus der Cloud",
  "{n} new here": "{n} neu hier",
  "{n} difficulty added|{n} difficulties added": "{n} Schwierigkeitsgrad hinzugefügt|{n} Schwierigkeitsgrade hinzugefügt",
  "The collections want {n} set this library doesn't have. Fumen downloads it from the mirrors and puts it into osu!lazer.|The collections want {n} sets this library doesn't have. Fumen downloads them from the mirrors and puts them into osu!lazer.":
    "Die Sammlungen brauchen {n} Set, das in dieser Bibliothek fehlt. Fumen lädt es von den Mirrors herunter und fügt es in osu!lazer ein.|Die Sammlungen brauchen {n} Sets, die in dieser Bibliothek fehlen. Fumen lädt sie von den Mirrors herunter und fügt sie in osu!lazer ein.",
  "Download the missing sets?": "Fehlende Sets herunterladen?",
  "Download them": "Herunterladen",
  "Couldn't get them: {error}": "Holen hat nicht geklappt: {error}",
  "Your collections in osu!": "Deine Sammlungen in osu!",
  "Fumen's collection into osu!lazer's (it updates the lazer collection it went into before, or the one with its name), or as a collection.db for osu!stable and Collection Manager. Single ones: right-click them in the sidebar.|All {n} of Fumen's collections into osu!lazer's (each one updates the lazer collection it went into before, or the one with its name), or as a collection.db for osu!stable and Collection Manager. Single ones: right-click them in the sidebar.":
    "Deine Fumen-Sammlung zu denen von osu!lazer (sie aktualisiert die lazer-Sammlung, in die sie vorher kam, oder die mit ihrem Namen), oder als collection.db für osu!stable und Collection Manager. Einzelne: Rechtsklick in der Seitenleiste.|Alle {n} Fumen-Sammlungen zu denen von osu!lazer (jede aktualisiert die lazer-Sammlung, in die sie vorher kam, oder die mit ihrem Namen), oder als collection.db für osu!stable und Collection Manager. Einzelne: Rechtsklick in der Seitenleiste.",
  "Make a collection in the sidebar first.": "Leg zuerst eine Sammlung in der Seitenleiste an.",
  "Save collection.db…": "collection.db speichern…",
  "Put into osu!lazer": "In osu!lazer einfügen",

  // appearance
  Appearance: "Darstellung",
  Language: "Sprache",
  "Fumen's window starts again in it.": "Fumens Fenster startet damit neu.",
  Theme: "Design",
  Dark: "Dunkel",
  Light: "Hell",
  "Accent colour": "Akzentfarbe",
  '"From artwork" picks it up from the background of what you\'re looking at or listening to.':
    "„Aus dem Artwork“ nimmt sie aus dem Hintergrund dessen, was du gerade ansiehst oder hörst.",
  "From artwork": "Aus dem Artwork",
  Fixed: "Fest",
  "Fixed colour": "Feste Farbe",
  "Ambient background": "Ambient-Hintergrund",
  "A soft, blurred version of the current artwork behind the app.": "Eine weiche, verschwommene Version des aktuellen Artworks hinter der App.",
  "Original-language metadata": "Metadaten in Originalsprache",
  "Show titles and artists in their original script (e.g. Japanese) when available.":
    "Titel und Artists in ihrer Originalschrift zeigen (z. B. Japanisch), wenn vorhanden.",
  "Reduce motion": "Bewegung reduzieren",
  "Turns off transitions and animations.": "Schaltet Übergänge und Animationen aus.",

  // about and updates
  About: "Über",
  "Fumen reads osu!lazer's database from a private copy. Beatmaps and collections you put into lazer go in through lazer's own code, only while lazer is closed, only on lazer versions tested with Fumen, and with a backup of its database first.":
    "Fumen liest die Datenbank von osu!lazer aus einer eigenen Kopie. Beatmaps und Sammlungen, die du in lazer einfügst, gehen durch lazers eigenen Code, nur solange lazer geschlossen ist, nur bei lazer-Versionen, die mit Fumen getestet sind, und mit einem Backup seiner Datenbank vorher.",
  Updates: "Updates",
  "Fumen looks for updates when it starts and every few hours. Installing one restarts it.":
    "Fumen sucht beim Start und alle paar Stunden nach Updates. Eins zu installieren startet Fumen neu.",
  "Check for updates": "Nach Updates suchen",
  "On Linux, Fumen doesn't update itself yet: install it again the way you did (the AppImage, the .deb or the Arch command from fumen.dertesti.dev).":
    "Unter Linux aktualisiert sich Fumen noch nicht selbst: Installier es einfach nochmal so wie beim ersten Mal (AppImage, .deb oder der Arch-Befehl von fumen.dertesti.dev).",
  Inspector: "Inspector",
  Open: "Öffnen",
  "Render test": "Rendertest",
  "A plain moving canvas in Fumen's window with its frames per second, the same as the test page on fumen.dertesti.dev, with or without the song that's loaded. Back to Fumen with the button at the top.":
    "Ein einfaches bewegtes Canvas in Fumens Fenster mit Bildern pro Sekunde, genau wie die Testseite auf fumen.dertesti.dev, mit oder ohne den geladenen Song. Zurück zu Fumen geht's mit dem Knopf oben.",
  Changelog: "Changelog",
  "What each update added or changed.": "Was jedes Update neu gebracht oder geändert hat.",
  "New in Fumen {version}": "Neu in Fumen {version}",
  "All versions": "Alle Versionen",
  "Got it": "Alles klar",
  "WebKit's developer tools. Its Timelines show what makes Fumen slow on this PC.":
    "Die Entwicklerwerkzeuge von WebKit. Ihre Timelines zeigen, was Fumen auf diesem PC langsam macht.",
  "On macOS, Fumen doesn't update itself yet: new versions are on fumen.dertesti.dev.":
    "Unter macOS aktualisiert sich Fumen noch nicht selbst: Neue Versionen gibt es auf fumen.dertesti.dev.",
  "Checking…": "Suche…",
  "You have the latest version (checked {when}).": "Du hast die neueste Version (geprüft {when}).",
  "Fumen {version} is out. Installing it restarts Fumen.": "Fumen {version} ist da. Die Installation startet Fumen neu.",
  "Downloading Fumen {version}…": "Lade Fumen {version} herunter…",
  "Installing Fumen {version}. Fumen closes for a moment and opens again.": "Installiere Fumen {version}. Fumen schließt sich kurz und öffnet sich wieder.",
  "Installing…": "Installiere…",
  "{s} s": "{s} s",
  Listening: "Wiedergabe",
  "Skip the silence at the start": "Stille am Anfang überspringen",
  "A song starts where its sound does, not in the quiet before it.": "Ein Song beginnt dort, wo er hörbar wird, nicht in der Stille davor.",
  "Fade in": "Einblenden",
  "How softly a song comes in after another one.": "Wie sanft ein Song nach einem anderen einsetzt.",
  "Fade out": "Ausblenden",
  "How softly a song goes before the next one: at its end, and when you skip it.": "Wie sanft ein Song vor dem nächsten ausklingt: an seinem Ende und wenn du ihn überspringst.",
};
