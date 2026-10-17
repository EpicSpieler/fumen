// The start ping (src-tauri/src/ping.rs): sent once per start, after a one-time notice that says
// what it is. Closing the notice any other way than "OK" turns it off.
import { api, isTauri } from "./api";
import { t } from "./i18n";
import { setPrefs, store } from "./store";
import { uiConfirm } from "../ui/controls";

export async function startPing(): Promise<void> {
  if (!isTauri) return;
  if (!store.prefs.pingNoticed) {
    const message = t("When it starts, Fumen tells fumen.dertesti.dev that it did: a random number made on this PC and Fumen's version, nothing else. That's how many people use it gets counted. You can turn it off here or later in Settings › About.");
    const keep = await uiConfirm(message, { title: t("Counting who uses Fumen"), confirmLabel: t("OK"), cancelLabel: t("Turn it off") });
    setPrefs({ pingNoticed: true });
    if (!keep) {
      store.settings = await api.updateSettings({ startPing: false });
      return;
    }
  }
  if (store.settings?.startPing !== false) await api.sendPing();
}
