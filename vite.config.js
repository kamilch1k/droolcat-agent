import { defineConfig } from "vite";

// Tauri expects a fixed port and looks the other way for src-tauri/.
// https://v2.tauri.app/start/frontend/vite/
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // Vite output dir is consumed by Tauri (see tauri.conf.json > build.frontendDist)
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      // Don't reload the dev server when Rust changes — Tauri handles that.
      ignored: ["**/src-tauri/**"],
    },
  },
});
