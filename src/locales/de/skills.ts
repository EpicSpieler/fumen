/** Skills, the comparison with another player, goals and practice suggestions. */
export const skills: Record<string, string> = {
  // pattern names stay English, as in the game
  Stream: "Stream",
  Jumpstream: "Jumpstream",
  Handstream: "Handstream",
  Chordjack: "Chordjack",
  Jacks: "Jacks",

  "Skills are being reworked": "Skills werden gerade überarbeitet",
  "The numbers here can be off until then, and goals and comparisons may change. Everything else in Fumen works as usual.":
    "Bis dahin können die Zahlen hier danebenliegen, und Ziele und Vergleiche können sich ändern. Alles andere in Fumen funktioniert wie gewohnt.",

  Compare: "Vergleichen",
  "Skills come from your osu!mania plays": "Skills kommen aus deinen osu!mania-Plays",
  "Fumen reads the patterns of osu!mania charts. Once you've passed some that are in your library, you'll see here what you're good at.":
    "Fumen liest die Patterns von osu!mania-Charts. Sobald du welche aus deiner Bibliothek gepasst hast, siehst du hier, was du gut kannst.",
  "{n} chart passed|{n} charts passed": "{n} Chart gepasst|{n} Charts gepasst",
  "A play is worth the chart's star rating at the rate you played it, at {acc} accuracy along osu!'s own osu!mania pp curve: a 5★ chart at 92% counts as about 4.4★. A pattern's skill is the average of your {top} best charts with that pattern (at least {share}% of the chart), weighted by how much of each chart it is. Passes only, each chart once, and not with mods that change what you play, like Hold Off.":
    "Ein Play ist so viel wert wie die Sternebewertung des Charts bei der Rate, mit der du es gespielt hast, umgerechnet auf {acc} Accuracy entlang der osu!mania-pp-Kurve von osu!: Ein 5★-Chart mit 92 % zählt etwa 4,4★. Der Skill eines Patterns ist der Schnitt deiner {top} besten Charts mit diesem Pattern (mindestens {share} % des Charts), gewichtet danach, wie viel vom Chart es ausmacht. Nur Passes, jedes Chart einmal, und nicht mit Mods, die ändern, was du spielst, wie Hold Off.",
  "Since {when}": "Seit {when}",
  "{n} chart|{n} charts": "{n} Chart|{n} Charts",
  "a guess": "geschätzt",
  "a guess so far": "bisher geschätzt",
  "no charts yet": "noch keine Charts",
  "Set a goal for {pattern}": "Ziel für {pattern} setzen",

  // comparing
  "{name} has no {pattern} charts": "{name} hat keine {pattern}-Charts",
  "{name}: {sr}★ from {charts}": "{name}: {sr}★ aus {charts}",
  "{name}'s best with {pattern}": "Das Beste von {name} bei {pattern}",
  Yours: "Deine",
  "Comparing with {name}": "Vergleiche mit {name}",
  Stop: "Stopp",
  Unranked: "Ohne Rang",
  "{n} chart no mirror had|{n} charts no mirror had": "{n} Chart hatte kein Mirror|{n} Charts hatte kein Mirror",
  "Compared with {name}": "Verglichen mit {name}",
  "Other player": "Andere Person",
  "End the comparison": "Vergleich beenden",
  "osu! player name": "Name auf osu!",
  "Their top plays, first places, recent passes and most played osu!mania charts come from osu!; charts you don't have are read from the mirrors.":
    "Ihre Top-Plays, ersten Plätze, neuesten Passes und meistgespielten osu!mania-Charts kommen von osu!; Charts, die du nicht hast, werden von den Mirrors gelesen.",
  "From {name}'s plays": "Aus den Plays von {name}",
  "Add to osu!lazer…": "Zu osu!lazer hinzufügen…",
  "Like it in your library": "Ähnliches in deiner Bibliothek",
  "Nothing much like it": "Nichts wirklich Ähnliches",
  "Not in your library: add it": "Nicht in deiner Bibliothek: hinzufügen",
  "not in your library": "nicht in deiner Bibliothek",
  "in your library": "in deiner Bibliothek",

  // goals
  "More for this goal": "Mehr zu diesem Ziel",
  "{value} now": "jetzt {value}",
  "Not passed yet": "Noch nicht gepasst",
  "Nothing yet": "Noch nichts",
  "Set {when}": "Gesetzt {when}",
  "reached {when}": "erreicht {when}",
  Goals: "Ziele",
  "Something to work toward: a skill, an accuracy on a chart, or your pp or rank. Fumen ticks it off when your plays get there.":
    "Etwas, auf das du hinarbeitest: ein Skill, eine Accuracy auf einem Chart oder deine pp oder dein Rang. Fumen hakt es ab, sobald deine Plays dort ankommen.",
  "Hide reached": "Erreichte ausblenden",
  "Reached {n}": "Erreicht {n}",
  "Open beatmap": "Beatmap öffnen",
  "Show {keys}K skills": "{keys}K-Skills zeigen",
  "Delete goal": "Ziel löschen",
  "Couldn't delete the goal: {error}": "Das Ziel ließ sich nicht löschen: {error}",
  "Set a goal…": "Ziel setzen…",
  "{ruleset} rank": "{ruleset}-Rang",
  "{acc} at {rate}× or faster": "{acc} bei {rate}× oder schneller",

  // practice
  "Practice next": "Als Nächstes üben",
  "Charts in your library a little above your weakest skills: hard enough to move them, close enough to pass. Where 1× doesn't land there, a rate does.":
    "Charts aus deiner Bibliothek knapp über deinen schwächsten Skills: schwer genug, um sie zu verbessern, nah genug, um sie zu passen. Wo 1× nicht passt, tut es eine Rate.",
  "Weakest only": "Nur die schwächsten",
  "All {n} patterns": "Alle {n} Patterns",
  "{sr}★ now": "jetzt {sr}★",
  "No charts yet": "Noch keine Charts",
  "your best {acc} at {rate}×": "dein Bestes {acc} bei {rate}×",
  "your best {acc}": "dein Bestes {acc}",
  played: "gespielt",
  "not passed yet": "noch nicht gepasst",
  "aiming at {band}": "Ziel {band}",
  "Nothing in your library with at least {share}% {pattern} reaches {band}, not even at 0.75× to 1.5×.":
    "Nichts in deiner Bibliothek mit mindestens {share} % {pattern} erreicht {band}, nicht mal bei 0,75× bis 1,5×.",
  "{pct}% {pattern}": "{pct} % {pattern}",
  "Star rating at {rate}×": "Sternebewertung bei {rate}×",
  "Star rating": "Sternebewertung",
  "What this play is worth at {acc} accuracy": "Was dieses Play bei {acc} Accuracy wert ist",
  "{mod} with its speed set to {rate}×": "{mod} mit Geschwindigkeit auf {rate}×",
  new: "neu",
  "A {acc} pass here takes {pattern} from {from}★ to {to}★": "Ein Pass mit {acc} hier bringt {pattern} von {from}★ auf {to}★",
  "A {acc} pass here starts {pattern} at {to}★": "Ein Pass mit {acc} hier startet {pattern} bei {to}★",

  // radar
  "Goal: {sr}★": "Ziel: {sr}★",
  "Skill per pattern": "Skill pro Pattern",
  You: "Du",
  Now: "Jetzt",
  "90 days ago": "Vor 90 Tagen",
  Goal: "Ziel",
};
