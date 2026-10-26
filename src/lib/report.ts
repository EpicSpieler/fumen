/* report.ts — the system part of a performance report (the frame meter's Ctrl+Shift+F12): Fumen's
 * version, what Linux and WebKit say about themselves (system_info), the graphics card as WebGL
 * names it, and the window. In English: reports go to the maker. The render test page builds the
 * same lines itself (canvas-test.ts runs on the website too, without Fumen's modules). */
import { getVersion } from "@tauri-apps/api/app";
import { api } from "./api";

/** The graphics card's name as WebGL reports it, when it says. */
export function gpuName(): string | null {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return (ext && gl?.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl?.getParameter(gl.RENDERER) || null;
  } catch {
    return null;
  }
}

/** "Label: value" lines about this computer, for the top of a report. */
export async function systemLines(): Promise<string[]> {
  const version = await getVersion().catch(() => "?");
  const info = await api.systemInfo().catch(() => [] as [string, string][]);
  const gpu = gpuName();
  return [
    `Fumen: ${version}`,
    ...info.map(([k, v]) => `${k}: ${v}`),
    ...(gpu ? [`GPU (WebGL): ${gpu}`] : []),
    `Screen: ${screen.width}×${screen.height} at ${devicePixelRatio}x · window ${innerWidth}×${innerHeight}`,
  ];
}
