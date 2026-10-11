// @tauri-apps/plugin-updater in the browser preview: no update, unless localStorage
// "fumen-preview-update" names a version. Its download runs for a few seconds and then fails,
// since there's nothing to install here.
type Progress = { event: "Started"; data: { contentLength?: number } } | { event: "Progress"; data: { chunkLength: number } } | { event: "Finished" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function check(): Promise<unknown> {
  await sleep(600);
  const version = localStorage.getItem("fumen-preview-update");
  if (!version) return null;
  return {
    version,
    body: "Preview update",
    async downloadAndInstall(onEvent?: (e: Progress) => void): Promise<void> {
      const total = 12_000_000;
      onEvent?.({ event: "Started", data: { contentLength: total } });
      for (let done = 0; done < total; done += 1_000_000) {
        await sleep(200);
        onEvent?.({ event: "Progress", data: { chunkLength: 1_000_000 } });
      }
      onEvent?.({ event: "Finished" });
      await sleep(800);
      throw new Error("The browser preview can't install updates.");
    },
  };
}
