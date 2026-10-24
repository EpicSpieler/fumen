/* changelog.ts — the changelog window: after an update with what's new since the last start,
 * from Settings › About with every version. */
import { CHANGELOG, linesOf, type ChangelogEntry } from "../lib/changelog";
import { date, esc } from "../lib/format";
import { t } from "../lib/i18n";
import { closeAnimated } from "../ui/controls";
import { icon } from "../ui/icons";

/** `entries` newest first; `updated`: shown because Fumen was just updated */
export function openChangelog(entries: ChangelogEntry[] = CHANGELOG, updated = false): void {
  if (!entries.length) return;
  const title = updated ? t("New in Fumen {version}", { version: entries[0].version }) : t("Changelog");
  const bd = document.createElement("div");
  bd.className = "modal-backdrop dialog-backdrop";
  bd.innerHTML = `
    <div class="modal-panel dialog changelog" role="dialog" aria-modal="true" aria-labelledby="changelog-title">
      <button class="icon-btn modal-close" type="button" data-act="close" aria-label="${t("Close")}">${icon("x")}</button>
      <div class="dialog-title" id="changelog-title">${esc(title)}</div>
      <div class="changelog-list">
        ${entries
          .map(
            (e, i) => `
          <section class="changelog-entry">
            ${updated && i === 0 && entries.length === 1 ? "" : `<div class="changelog-version"><b>${esc(e.version)}</b><span class="num">${date(Date.parse(e.date))}</span></div>`}
            <ul>${linesOf(e)
              .map((l) => `<li>${esc(l)}</li>`)
              .join("")}</ul>
          </section>`,
          )
          .join("")}
      </div>
      <div class="dialog-actions">
        ${updated ? `<button class="btn btn-ghost" type="button" data-act="all">${t("All versions")}</button>` : ""}
        <button class="btn btn-primary" type="button" data-act="close">${updated ? t("Got it") : t("Close")}</button>
      </div>
    </div>`;
  document.body.appendChild(bd);
  setTimeout(() => bd.querySelector<HTMLButtonElement>('.dialog-actions [data-act="close"]')?.focus(), 30);

  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    closeAnimated(bd);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  document.addEventListener("keydown", onKey, true);
  bd.addEventListener("pointerdown", (e) => {
    if (e.target === bd) close();
  });
  bd.addEventListener("click", (e) => {
    const act = (e.target as Element).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "close") close();
    else if (act === "all") {
      close();
      openChangelog();
    }
  });
}
