import { defineConfig } from "vite";

// Tauri expects a fixed port and doesn't want Vite to clear its output.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/sidecar/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    sourcemap: false,
    // the main window and the companion window (src/companion.ts)
    rollupOptions: { input: { main: "index.html", companion: "companion.html" } },
  },
});
