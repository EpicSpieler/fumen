/* German: Stream & OBS in Settings, arranging the live overlay (views/hud-editor.ts), the song card. */
export const obs: Record<string, string> = {
  // Settings
  "Stream & OBS": "Stream & OBS",
  "Sources for OBS": "Quellen für OBS",
  "Pages for OBS's browser sources, from this PC only and while Fumen runs. In OBS: Sources, +, Browser, the address below, 1920 × 1080.":
    "Seiten für Browser-Quellen in OBS, nur von diesem PC aus und solange Fumen läuft. In OBS: Quellen, +, Browser, die Adresse unten, 1920 × 1080.",
  "The visualizer as in Fumen, answering the play, while a map runs. With ?bg=none at the end of the address the game shows through it, with ?idle=1 it stays on in song select and for Fumen's player.":
    "Der Visualizer wie in Fumen, er reagiert aufs Spiel, solange eine Map läuft. Mit ?bg=none am Ende der Adresse scheint das Spiel durch, mit ?idle=1 bleibt er auch in der Songauswahl und für Fumens Player an.",
  "Live overlay": "Live-Overlay",
  "Over the game: progress, combo, accuracy, pp, health, and what your tries before mean. Each part goes where your skin leaves room.":
    "Über dem Spiel: Fortschritt, Combo, Accuracy, pp, Leben und was deine Versuche davor bedeuten. Jedes Teil kommt dahin, wo dein Skin Platz lässt.",
  Arrange: "Anordnen",
  "Song card": "Song-Karte",
  "For a few seconds when a map starts: cover, title, mapper, stars, BPM, length, your best.":
    "Ein paar Sekunden, wenn eine Map startet: Cover, Titel, Mapper, Sterne, BPM, Länge, deine Bestleistung.",
  "Show now": "Jetzt zeigen",
  "Session card": "Session-Karte",
  "For a break or the end: tries, passes, your best plays, the map that cost the most, every try on one line.":
    "Für die Pause oder das Ende: Versuche, Passes, deine besten Plays, die Map, die am meisten gekostet hat, jeder Versuch auf einer Linie.",
  "New session": "Neue Session",
  "Shown in OBS": "In OBS gezeigt",
  "A new session starts now": "Ab jetzt läuft eine neue Session",

  // arranging the live overlay
  "Put each part where your skin leaves room for it. OBS follows as you go.": "Setz jedes Teil dahin, wo dein Skin Platz lässt. OBS zieht sofort mit.",
  "Start over": "Alles zurück",
  "Put every part back where it was at first?": "Alle Teile wieder dahin, wo sie am Anfang waren?",
  Parts: "Teile",
  Progress: "Fortschritt",
  Health: "Leben",
  "Fumen's lines": "Fumens Zeilen",
  "How far into the map, with a notch where each earlier try ended and the part where most of them did.":
    "Wie weit die Map ist, mit einer Kerbe, wo jeder frühere Versuch geendet hat, und der Stelle, an der die meisten geendet haben.",
  "The map's title, its difficulty and which try this is.": "Der Titel der Map, ihr Schwierigkeitsgrad und der wievielte Versuch das ist.",
  "Stars at the rate played, and the mods.": "Die Sterne beim gespielten Tempo und die Mods.",
  "Drops away on a combo break and turns into the rank at the end.": "Fällt bei einem Combo-Bruch weg und wird am Ende zum Rang.",
  "Drains toward the side it's pinned to and turns red when it's low.": "Läuft zu der Seite leer, an der es hängt, und wird rot, wenn es knapp wird.",
  "Rolls with every judgement.": "Rollt mit jedem Treffer mit.",
  "What the play is worth so far.": "Was der Play bis hierhin wert ist.",
  "At the end: how it ended and what that means against your tries before.": "Am Ende: wie es ausging und was das neben deinen Versuchen davor heißt.",
  "Lamps that play with the song and answer the play.": "Lampen, die mit dem Song spielen und aufs Spiel reagieren.",
  "Click a part to pick it. Drag it to move it, drag a corner to make it bigger or smaller. Arrow keys move it a pixel, Alt while dragging keeps it from snapping.":
    "Klick ein Teil an, um es zu wählen. Zieh es, um es zu verschieben, zieh an einer Ecke, um es größer oder kleiner zu machen. Pfeiltasten schieben es um ein Pixel, Alt beim Ziehen verhindert das Einrasten.",
  Size: "Größe",
  "Back to its place": "Zurück an seinen Platz",
  Hide: "Ausblenden",
  "Show again": "Wieder einblenden",
  "Behind it": "Dahinter",
  "Screenshot…": "Screenshot…",
  Remove: "Entfernen",
  "Take a screenshot in osu! and paste it here with Ctrl+V, or pick the file. It's only for arranging and stays on this PC.":
    "Mach in osu! einen Screenshot und füg ihn hier mit Strg+V ein, oder wähl die Datei. Er ist nur zum Anordnen da und bleibt auf diesem PC.",
  "That image couldn't be read.": "Das Bild ließ sich nicht lesen.",
  Playing: "Spielen",
  "Combo break": "Combo-Bruch",
  "Low health": "Wenig Leben",
  Pass: "Pass",
  Fail: "Fail",

  // OBS itself: the connection, scenes, clips
  "Connect to OBS": "Mit OBS verbinden",
  "Connected to OBS {v}.": "Mit OBS {v} verbunden.",
  "Connected to OBS.": "Mit OBS verbunden.",
  "Looking for OBS…": "Suche OBS…",
  "OBS wants a password, or this one isn't right.": "OBS will ein Passwort, oder dieses stimmt nicht.",
  "Nothing answers on port {port}. Is OBS open, with its websocket server on (Tools, WebSocket Server Settings)?":
    "Auf Port {port} antwortet nichts. Ist OBS offen und sein WebSocket-Server an (Werkzeuge, WebSocket-Server-Einstellungen)?",
  "Fumen switches scenes and keeps clips through OBS's websocket server (OBS 28 or newer).": "Fumen wechselt Szenen und hält Clips über den WebSocket-Server von OBS fest (OBS 28 oder neuer).",
  "Port and password": "Port und Passwort",
  "As OBS shows them under Tools, WebSocket Server Settings. The password stays sealed on this PC.": "So wie OBS sie unter Werkzeuge, WebSocket-Server-Einstellungen zeigt. Das Passwort bleibt verschlüsselt auf diesem PC.",
  Port: "Port",
  Password: "Passwort",
  "Saved. Fumen asks OBS again.": "Gespeichert. Fumen fragt OBS neu.",
  "No password kept. Fumen asks OBS again.": "Kein Passwort mehr gespeichert. Fumen fragt OBS neu.",
  "Scenes follow osu!": "Szenen folgen osu!",
  "With Follow osu! on, OBS shows the scene set for what osu! shows. A scene you picked yourself that isn't one of these stays on.":
    "Mit „osu! folgen“ zeigt OBS die Szene, die zu dem passt, was osu! gerade zeigt. Eine Szene, die du selbst gewählt hast und die keine von diesen ist, bleibt an.",
  "Song select": "Songauswahl",
  Results: "Ergebnis",
  "osu! closed": "osu! zu",
  "Don't switch": "Nicht wechseln",
  "Clips of the good moments": "Clips von den guten Momenten",
  "OBS's replay buffer saved a few seconds after a full combo, a new best or a close pass (under 10 % health, or the first pass after 3 fails).":
    "Der Replay-Puffer von OBS wird ein paar Sekunden nach einem Full Combo, einem neuen Best oder einem knappen Pass gespeichert (unter 10 % Leben, oder der erste Pass nach 3 Fails).",
  "The replay buffer is off in OBS.": "Der Replay-Puffer ist in OBS aus.",
  "Close pass": "Knapper Pass",
  "Named after the map": "Nach der Map benannt",
  "Chapter marker": "Kapitelmarke",
  "Test clip": "Test-Clip",
  Test: "Test",
  "That was worth a clip, but the replay buffer is off in OBS.": "Das wäre einen Clip wert gewesen, aber der Replay-Puffer ist in OBS aus.",
  "Start it": "Starten",
  "The clip wasn't saved.": "Der Clip wurde nicht gespeichert.",
  "Clip saved": "Clip gespeichert",
  "Show in folder": "Im Ordner zeigen",
  "Fumen isn't connected to OBS.": "Fumen ist nicht mit OBS verbunden.",

  // the session card
  "{h} h {m} min": "{h} Std. {m} Min.",
  "{m} min": "{m} Min.",
  "since {time}": "seit {time}",
  Passes: "Passes",
  Fails: "Fails",
  Clips: "Clips",
  "Best plays": "Beste Plays",
  "Cost the most": "Hat am meisten gekostet",
  "Nothing played yet": "Noch nichts gespielt",
  "No pass yet": "Noch kein Pass",
  "{n} fail|{n} fails": "{n} Fail|{n} Fails",
  "Passed in the end": "Am Ende geschafft",
  "Not passed yet": "Noch nicht geschafft",

  "Keys for the live overlay": "Tasten fürs Live-Overlay",
  "The live overlay's key part shows the keys you play with. For that Fumen reads the keyboard, but only the keys osu!lazer has you play with and only while osu! is the window in front. Nothing of it is kept.":
    "Der Tasten-Teil im Live-Overlay zeigt die Tasten, mit denen du spielst. Dafür liest Fumen die Tastatur mit, aber nur die Tasten, mit denen du in osu!lazer spielst, und nur solange osu! das Fenster im Vordergrund ist. Davon wird nichts gespeichert.",
  // the live overlay's judgements and keys
  Judgements: "Judgements",
  Keys: "Tasten",
  "How many of each judgement so far.": "Wie viele von jedem Judgement bisher.",
  "Which keys are held, with a trail for each press. Needs reading the keys switched on in OBS's settings.":
    "Welche Tasten gedrückt sind, mit einer Spur für jeden Anschlag. Dafür muss in den OBS-Einstellungen das Mitlesen der Tasten an sein.",
  Miss: "Miss",
  Max: "Max",
  KPS: "KPS",

  // the song card
  "mapped by {name}": "gemappt von {name}",
  "Your best": "Deine Bestleistung",

  // the pulse
  "Heart rate": "Puls",
  "Your pulse, beating along. Only there with a heart rate monitor connected in Settings, While you play.":
    "Dein Puls, der mitschlägt. Nur da, wenn in den Einstellungen unter Beim Spielen ein Pulsmesser verbunden ist.",
};
