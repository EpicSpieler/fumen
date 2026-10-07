/* Browser-preview stand-in for @tauri-apps/api/window (never called: isTauri is false). */
export function getCurrentWindow(): never {
  throw new Error("no window in the browser preview");
}
