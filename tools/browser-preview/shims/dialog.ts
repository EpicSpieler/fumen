export async function open(): Promise<string | null> {
  return window.prompt("Folder path (browser preview)");
}

export async function save(opts?: { defaultPath?: string }): Promise<string | null> {
  return "C:/preview/" + (opts?.defaultPath ?? "file");
}
