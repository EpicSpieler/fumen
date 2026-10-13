/* icons.ts — one SVG sprite for the whole app (never emojis).
 *
 * All icons: 24px grid, 1.8px stroke, round caps, colour = currentColor.
 * Usage: icon("search") → SVG string for templates.
 */

const S = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const SW = 'fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round"';
const F = 'fill="currentColor"';
const D = 'fill="currentColor" opacity=".22"';

const ICONS = {
  // ── navigation ──────────────────────────────────────────────────────────
  library: `<rect ${S} x="4" y="7.5" width="12.5" height="12.5" rx="2.4"/><path ${S} d="M8 4.5h9.6a2.4 2.4 0 0 1 2.4 2.4v9.6"/><path ${S} d="M11.8 16.4v-5.5l2.6-.6"/><circle ${S} cx="10.2" cy="16.4" r="1.6"/>`,
  collection: `<path ${S} d="M5.6 4.5h12.8M4.4 8h15.2"/><rect ${S} x="3.5" y="11.2" width="17" height="8.8" rx="2.2"/>`,
  settings: `<path ${S} d="M10.4 3.6h3.2l.5 2.4c.6.2 1.2.6 1.7 1l2.3-.8 1.6 2.8-1.8 1.6c.1.6.1 1.3 0 1.9l1.8 1.6-1.6 2.8-2.3-.8c-.5.4-1.1.8-1.7 1l-.5 2.4h-3.2l-.5-2.4c-.6-.2-1.2-.6-1.7-1l-2.3.8-1.6-2.8 1.8-1.6c-.1-.6-.1-1.3 0-1.9L4.3 9l1.6-2.8 2.3.8c.5-.4 1.1-.8 1.7-1z"/><circle ${S} cx="12" cy="12" r="2.7"/>`,
  sidebar: `<rect ${S} x="3.8" y="5" width="16.4" height="14" rx="2.4"/><path ${S} d="M9.5 5v14"/>`,

  // ── general ─────────────────────────────────────────────────────────────
  search: `<circle ${S} cx="10.8" cy="10.8" r="6.3"/><path ${S} d="m19.5 19.5-4.1-4.1"/>`,
  x: `<path ${S} d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>`,
  check: `<path ${S} stroke-width="2.2" d="m5.5 12.5 4.2 4.2 8.8-9.4"/>`,
  plus: `<path ${S} d="M12 5.5v13M5.5 12h13"/>`,
  minus: `<path ${S} d="M5.5 12h13"/>`,
  "chevron-down": `<path ${S} d="m7 10 5 5 5-5"/>`,
  "chevron-up": `<path ${S} d="m7 14 5-5 5 5"/>`,
  "chevron-left": `<path ${S} d="m14 7-5 5 5 5"/>`,
  "chevron-right": `<path ${S} d="m10 7 5 5-5 5"/>`,
  "arrow-left": `<path ${S} d="M19 12H5.5M11 6l-6 6 6 6"/>`,
  fullscreen: `<path ${S} d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>`,
  "fullscreen-exit": `<path ${S} d="M9 4v3.5A1.5 1.5 0 0 1 7.5 9H4M20 9h-3.5A1.5 1.5 0 0 1 15 7.5V4M15 20v-3.5a1.5 1.5 0 0 1 1.5-1.5H20M4 15h3.5A1.5 1.5 0 0 1 9 16.5V20"/>`,
  "arrow-right": `<path ${S} d="M5 12h13.5M13 6l6 6-6 6"/>`,
  "arrow-up": `<path ${S} d="M12 19V5.5M6.5 11 12 5.5l5.5 5.5"/>`,
  "arrow-down": `<path ${S} d="M12 5v13.5M6.5 13l5.5 5.5 5.5-5.5"/>`,
  sort: `<path ${S} d="M7.5 5v14M4.5 16l3 3 3-3M16.5 19V5M13.5 8l3-3 3 3"/>`,
  more: `<circle ${F} cx="6" cy="12" r="1.5"/><circle ${F} cx="12" cy="12" r="1.5"/><circle ${F} cx="18" cy="12" r="1.5"/>`,
  sliders: `<path ${S} d="M4 7h8.5M17.5 7H20M4 17h2.5M11.5 17H20"/><circle ${S} cx="15" cy="7" r="2.3"/><circle ${S} cx="9" cy="17" r="2.3"/>`,
  grid: `<rect ${S} x="4" y="4" width="7" height="7" rx="1.8"/><rect ${S} x="13" y="4" width="7" height="7" rx="1.8"/><rect ${S} x="4" y="13" width="7" height="7" rx="1.8"/><rect ${S} x="13" y="13" width="7" height="7" rx="1.8"/>`,
  rows: `<path ${S} d="M4.5 6.5h15M4.5 12h15M4.5 17.5h15"/>`,
  refresh: `<path ${S} d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path ${S} d="M19.5 4.5v4h-4"/>`,
  external: `<path ${S} d="M14 4.5h5.5V10M19.5 4.5 11.5 12.5M17.5 13.8v4.2a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V8A1.5 1.5 0 0 1 6 6.5h4.2"/>`,
  folder: `<path ${S} d="M3.8 7.2a1.8 1.8 0 0 1 1.8-1.8h4l1.9 2.2h6.9a1.8 1.8 0 0 1 1.8 1.8v8.2a1.8 1.8 0 0 1-1.8 1.8H5.6a1.8 1.8 0 0 1-1.8-1.8z"/>`,
  download: `<path ${S} d="M12 4.5v10.2M7.6 10.6l4.4 4.4 4.4-4.4M5 19.5h14"/>`,
  flag: `<path ${S} d="M6.5 20.5V4M6.5 4.8h10.4l-2 3.9 2 3.9H6.5"/>`,
  trash: `<path ${S} d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.8 12.2h9.4l.8-12.2M10.2 10.5v5.5M13.8 10.5v5.5"/>`,
  link: `<path ${S} d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>`,
  copy: `<rect ${S} x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path ${S} d="M15.5 8.5V6.6a2.1 2.1 0 0 0-2.1-2.1H6.6a2.1 2.1 0 0 0-2.1 2.1v6.8a2.1 2.1 0 0 0 2.1 2.1h1.9"/>`,
  radar: `<path ${SW} d="M12 4l6.93 4v8L12 20l-6.93-4V8z"/><path ${S} d="M12 7.4l4.6 3-1.3 4.4L12 16.8l-3.4-2.5-.9-4z"/>`,
  similar: `<rect ${D} x="4" y="9" width="11" height="11" rx="2.6"/><rect ${S} x="4" y="9" width="11" height="11" rx="2.6"/><path ${S} d="M9 9V6.6A2.6 2.6 0 0 1 11.6 4h5.8A2.6 2.6 0 0 1 20 6.6v5.8a2.6 2.6 0 0 1-2.6 2.6H15"/>`,
  clock: `<circle ${S} cx="12" cy="12" r="8"/><path ${S} d="M12 7.8V12l2.8 1.8"/>`,
  calendar: `<rect ${S} x="4.5" y="5.5" width="15" height="14" rx="2.2"/><path ${S} d="M4.5 10h15M8.5 3.5v4M15.5 3.5v4"/>`,
  metronome: `<path ${S} d="M9.4 3.8h5.2l3.9 16.4h-13z"/><path ${S} d="M12 15.6l4.6-8.6M6.9 14.6h10.2"/>`,
  music: `<path ${S} d="M9 17.6V5.8l10-2v11.6"/><circle ${S} cx="6.6" cy="17.6" r="2.4"/><circle ${S} cx="16.6" cy="15.4" r="2.4"/>`,
  star: `<path ${S} d="M12 4.2l2.35 4.76 5.25.77-3.8 3.7.9 5.23L12 16.2l-4.7 2.47.9-5.23-3.8-3.7 5.25-.77z"/>`,
  "star-fill": `<path fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M12 4.2l2.35 4.76 5.25.77-3.8 3.7.9 5.23L12 16.2l-4.7 2.47.9-5.23-3.8-3.7 5.25-.77z"/>`,
  user: `<circle ${S} cx="12" cy="8.2" r="3.7"/><path ${S} d="M4.8 20c.9-3.6 3.8-5.6 7.2-5.6s6.3 2 7.2 5.6"/>`,
  tag: `<path ${S} d="M4.5 12.2V5.6a1.1 1.1 0 0 1 1.1-1.1h6.6l7.3 7.3a1.4 1.4 0 0 1 0 2l-5.6 5.6a1.4 1.4 0 0 1-2 0z"/><circle ${F} cx="8.4" cy="8.4" r="1.3"/>`,
  info: `<circle ${S} cx="12" cy="12" r="8"/><path ${S} d="M12 11v5.4"/><circle ${F} cx="12" cy="7.9" r="1.1"/>`,
  alert: `<path ${S} d="M10.4 4.6 3 17.5a1.8 1.8 0 0 0 1.6 2.7h14.8a1.8 1.8 0 0 0 1.6-2.7L13.6 4.6a1.8 1.8 0 0 0-3.2 0z"/><path ${S} d="M12 9.6v4.2"/><circle ${F} cx="12" cy="16.9" r="1.05"/>`,
  eye: `<path ${S} d="M2.8 12S6.2 5.8 12 5.8 21.2 12 21.2 12 17.8 18.2 12 18.2 2.8 12 2.8 12z"/><circle ${S} cx="12" cy="12" r="2.8"/>`,
  "eye-off": `<path ${S} d="M4.5 4.5l15 15M9.9 6.1A9.4 9.4 0 0 1 12 5.8c5.8 0 9.2 6.2 9.2 6.2a16 16 0 0 1-2.6 3.3M15 16.8a8.6 8.6 0 0 1-3 .5C6.2 17.3 2.8 12 2.8 12a16 16 0 0 1 3.5-4.1M10 10.1a2.8 2.8 0 0 0 3.9 3.9"/>`,

  // ── playback ────────────────────────────────────────────────────────────
  play: `<path ${F} d="M8 5.6v12.8a1 1 0 0 0 1.53.85l10.2-6.4a1 1 0 0 0 0-1.7L9.53 4.75A1 1 0 0 0 8 5.6z"/>`,
  pause: `<rect ${F} x="6.5" y="5" width="3.8" height="14" rx="1"/><rect ${F} x="13.7" y="5" width="3.8" height="14" rx="1"/>`,
  stop: `<rect ${F} x="6" y="6" width="12" height="12" rx="2.2"/>`,
  "skip-back": `<path ${S} d="M17.6 6.6v10.8a1 1 0 0 1-1.55.83l-7.9-5.4a1 1 0 0 1 0-1.66l7.9-5.4a1 1 0 0 1 1.55.83z"/><path ${S} d="M6.4 6v12"/>`,
  "skip-forward": `<path ${S} d="M6.4 6.6v10.8a1 1 0 0 0 1.55.83l7.9-5.4a1 1 0 0 0 0-1.66l-7.9-5.4A1 1 0 0 0 6.4 6.6z"/><path ${S} d="M17.6 6v12"/>`,
  shuffle: `<path ${S} d="M3.8 7.4h2.5a4 4 0 0 1 3.3 1.7l4.3 5.9a4 4 0 0 0 3.3 1.7h2.9M3.8 16.6h2.5a4 4 0 0 0 3.3-1.7l.4-.5M13.6 9.6l.3-.5a4 4 0 0 1 3.3-1.7h2.9M17.9 5l2.4 2.4-2.4 2.4M17.9 14.2l2.4 2.4-2.4 2.4"/>`,
  repeat: `<path ${S} d="M17 4.5 19.5 7 17 9.5M4.5 11.5V10a3 3 0 0 1 3-3h12M7 19.5 4.5 17 7 14.5M19.5 12.5V14a3 3 0 0 1-3 3h-12"/>`,
  "repeat-one": `<path ${S} d="M17 4.5 19.5 7 17 9.5M4.5 11.5V10a3 3 0 0 1 3-3h12M7 19.5 4.5 17 7 14.5M19.5 12.5V14a3 3 0 0 1-3 3h-12"/><path ${S} stroke-width="1.6" d="M11.2 10.7l1.3-.9v4.5"/>`,
  "more-vert": `<circle ${F} cx="12" cy="6" r="1.5"/><circle ${F} cx="12" cy="12" r="1.5"/><circle ${F} cx="12" cy="18" r="1.5"/>`,
  "chevrons-left": `<path ${S} d="m12.5 7-5 5 5 5M18 7l-5 5 5 5"/>`,
  home: `<path ${S} d="M4.5 10.4 12 4.3l7.5 6.1v8.4a1.2 1.2 0 0 1-1.2 1.2H14.5v-5.6h-5v5.6H5.7a1.2 1.2 0 0 1-1.2-1.2z"/>`,

  // ── greeting (duotone, by time of day) ─────────────────────────────────
  sunrise: `<path ${D} d="M7.2 16.5a4.8 4.8 0 0 1 9.6 0z"/><path ${S} d="M7.2 16.5a4.8 4.8 0 0 1 9.6 0M3.5 16.5h17M5 20h14M12 4v4.2M9.6 6.2 12 3.8l2.4 2.4M4.6 10.3l1.4 1.1M19.4 10.3 18 11.4"/>`,
  sun: `<circle ${D} cx="12" cy="12" r="4.4"/><circle ${S} cx="12" cy="12" r="4.4"/><path ${S} d="M12 3v1.8M12 19.2V21M3 12h1.8M19.2 12H21M5.6 5.6l1.3 1.3M17.1 17.1l1.3 1.3M5.6 18.4l1.3-1.3M17.1 6.9l1.3-1.3"/>`,
  "cloud-sun": `<path ${D} d="M8 19.5h8.6a3.4 3.4 0 0 0 .4-6.8 4.8 4.8 0 0 0-9.2-.6A3.7 3.7 0 0 0 8 19.5z"/><path ${S} d="M8 19.5h8.6a3.4 3.4 0 0 0 .4-6.8 4.8 4.8 0 0 0-9.2-.6A3.7 3.7 0 0 0 8 19.5zM15.4 7.6a3.6 3.6 0 0 1 4.3 4.4M17.6 3.8v1.4M21.6 7.8h-1.4M20.4 5l-1 1"/>`,
  sunset: `<path ${D} d="M7.2 16.5a4.8 4.8 0 0 1 9.6 0z"/><path ${S} d="M7.2 16.5a4.8 4.8 0 0 1 9.6 0M3.5 16.5h17M5 20h14M12 3.6v4.6M9.6 5.8 12 8.2l2.4-2.4M4.6 10.3l1.4 1.1M19.4 10.3 18 11.4"/>`,
  moon: `<path ${D} d="M19.6 14.6A7.6 7.6 0 1 1 9.4 4.4a6.1 6.1 0 0 0 10.2 10.2z"/><path ${S} d="M19.6 14.6A7.6 7.6 0 1 1 9.4 4.4a6.1 6.1 0 0 0 10.2 10.2z"/><path ${S} d="M16.6 3.8v2.6M15.3 5.1h2.6"/>`,
  volume: `<path ${S} d="M4.6 9.4h2.9L12 5.6v12.8l-4.5-3.8H4.6a1.1 1.1 0 0 1-1.1-1.1v-3a1.1 1.1 0 0 1 1.1-1.1z"/><path ${S} d="M15.6 9.2a4 4 0 0 1 0 5.6M18.3 6.6a7.6 7.6 0 0 1 0 10.8"/>`,
  "volume-low": `<path ${S} d="M4.6 9.4h2.9L12 5.6v12.8l-4.5-3.8H4.6a1.1 1.1 0 0 1-1.1-1.1v-3a1.1 1.1 0 0 1 1.1-1.1z"/><path ${S} d="M15.6 9.2a4 4 0 0 1 0 5.6"/>`,
  "volume-off": `<path ${S} d="M4.6 9.4h2.9L12 5.6v12.8l-4.5-3.8H4.6a1.1 1.1 0 0 1-1.1-1.1v-3a1.1 1.1 0 0 1 1.1-1.1z"/><path ${S} d="M15.5 9.5l5 5M20.5 9.5l-5 5"/>`,

  // ── rulesets ────────────────────────────────────────────────────────────
  "mode-0": `<circle ${S} cx="12" cy="12" r="8"/><circle ${S} cx="12" cy="12" r="3.6"/>`,
  "mode-1": `<circle ${S} cx="12" cy="12" r="8"/><path ${S} d="M12 4v16M7.6 8.2a5.4 5.4 0 0 0 0 7.6M16.4 8.2a5.4 5.4 0 0 1 0 7.6"/>`,
  "mode-2": `<circle ${S} cx="12" cy="13.6" r="6.4"/><path ${S} d="M12 7.2c0-2 1.2-3.4 3.2-3.6M9.4 10.6a3.4 3.4 0 0 1 2.6-1.2"/>`,
  "mode-3": `<rect ${S} x="4" y="4" width="16" height="16" rx="3.2"/><path ${S} d="M8 7.5v5M12 9.5v5M16 11.5v5"/>`,

  // ── window controls (thinner, like native title bars) ──────────────────
  "win-min": `<path ${SW} d="M6.5 12h11"/>`,
  "win-max": `<rect ${SW} x="6.5" y="6.5" width="11" height="11" rx="1.6"/>`,
  "win-restore": `<rect ${SW} x="6.5" y="8.5" width="9" height="9" rx="1.5"/><path ${SW} d="M9 8.5V7.6A1.1 1.1 0 0 1 10.1 6.5h6.3a1.1 1.1 0 0 1 1.1 1.1v6.3a1.1 1.1 0 0 1-1.1 1.1h-.9"/>`,
  "win-close": `<path ${SW} d="M7 7l10 10M17 7 7 17"/>`,

  // ── large decorative (duotone) ──────────────────────────────────────────
  // the Fumen mark: four lanes, a staircase into a long note, the judgement line
  "lanes-duo": `<rect ${D} x="2.5" y="2.5" width="19" height="19" rx="5"/><rect ${F} x="5.6" y="14" width="2.7" height="1.9" rx=".95"/><rect ${F} x="9.1" y="11.2" width="2.7" height="1.9" rx=".95"/><rect ${F} x="12.6" y="8.4" width="2.7" height="1.9" rx=".95"/><rect ${F} opacity=".45" x="16.1" y="4.4" width="2.7" height="3.9" rx="1"/><rect ${F} x="16.1" y="6.4" width="2.7" height="1.9" rx=".95"/><path ${S} stroke-width="1.2" opacity=".55" d="M5.2 18h13.9"/>`,
  "search-duo": `<circle ${D} cx="10.8" cy="10.8" r="6.3"/><circle ${S} cx="10.8" cy="10.8" r="6.3"/><path ${S} d="m19.5 19.5-4.1-4.1"/>`,
  "collection-duo": `<rect ${D} x="3.5" y="11.2" width="17" height="8.8" rx="2.2"/><path ${S} d="M5.6 4.5h12.8M4.4 8h15.2"/><rect ${S} x="3.5" y="11.2" width="17" height="8.8" rx="2.2"/>`,
} as const;

export type IconName = keyof typeof ICONS;

export function injectIconSprite(): void {
  if (document.getElementById("app-icon-sprite")) return;
  const symbols = Object.entries(ICONS)
    .map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 24 24">${v}</symbol>`)
    .join("");
  const holder = document.createElement("div");
  holder.innerHTML = `<svg id="app-icon-sprite" width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${symbols}</defs></svg>`;
  document.body.prepend(holder.firstChild as Node);
}

/** SVG string for template literals. */
export function icon(name: IconName, cls = ""): string {
  return `<svg class="ic${cls ? " " + cls : ""}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}
