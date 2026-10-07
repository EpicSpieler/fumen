export async function open(): Promise<string | null> {
  return window.prompt("Folder path (browser preview)");
}
