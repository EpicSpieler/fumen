/* care-data.ts — the library care report (src-tauri/src/care.rs), measured once and shared: the
 * Library care page and the delete window both read sizes from it. A library update makes it
 * stale; the next one asking measures again (fast: lazer's sizes are kept by hash). */
import { api } from "./api";
import { events } from "./store";
import type { CareReport } from "./types";

let report: CareReport | null = null;
let inflight: Promise<CareReport> | null = null;
let stale = false;

events.on("library", () => {
  stale = true;
});

/** The report: the one there is, or measured (`again`: measured anyway). */
export function careReport(again = false): Promise<CareReport> {
  if (inflight) return inflight;
  if (report && !again && !stale) return Promise.resolve(report);
  stale = false;
  inflight = api
    .libraryCare()
    .then((r) => (report = r))
    .finally(() => (inflight = null));
  return inflight;
}

/** The report if it's been measured and is still current. */
export function knownCare(): CareReport | null {
  return stale ? null : report;
}
