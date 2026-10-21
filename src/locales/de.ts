/* German. Keys are the English texts as the code writes them (src/lib/i18n.ts); counts as
 * "one|other". One file per part of the app, merged here.
 *
 * Words: du (never Sie); Set/Sets, Beatmap, Schwierigkeitsgrad (difficulty), Sammlung
 * (collection), Bibliothek (library), Score/Scores, Plays, Ranked/Loved/Qualifiziert/Friedhof
 * as on osu!'s German site. Keep osu!'s own names (osu!lazer, osu!stable, osu!mania …). */
import { common } from "./de/common";
import { shell } from "./de/shell";
import { settings } from "./de/settings";
import { player } from "./de/player";
import { menus } from "./de/menus";
import { home } from "./de/home";
import { library } from "./de/library";
import { set } from "./de/set";
import { chart } from "./de/chart";
import { history } from "./de/history";
import { skills } from "./de/skills";
import { manage } from "./de/manage";
import { live } from "./de/live";
import { pools } from "./de/pools";
import { matches } from "./de/matches";
import { visualizer } from "./de/visualizer";

/** what Fumen's Rust side says, for fromRust() (apart: the code doesn't name these texts) */
export { rust } from "./de/rust";

export const de: Record<string, string> = { ...common, ...shell, ...settings, ...player, ...menus, ...home, ...library, ...set, ...chart, ...history, ...skills, ...manage, ...live, ...pools, ...matches, ...visualizer };
