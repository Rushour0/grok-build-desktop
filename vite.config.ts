import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Tests only — Vitest is a devDependency and nothing under `src/**/*.test.ts` is
  // reachable from index.html, so none of this reaches the shipped bundle.
  //
  // `node` rather than a DOM shim on purpose: every test here is a pure function or
  // a mocked bridge call, so there is nothing to render and no document to need.
  // The day a component test lands, that's when a DOM environment earns its place.
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The tests mock `@tauri-apps/api`; a leaked mock between files would let a
    // test pass against another test's stub rather than against the real module.
    restoreMocks: true,
    clearMocks: true,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
