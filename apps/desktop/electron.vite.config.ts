import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@cake/protocol", "@cake/state"] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, "electron/main/index.ts"),
          worker: resolve(import.meta.dirname, "electron/worker/index.ts")
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@cake/protocol"] })],
    build: {
      rollupOptions: {
        input: resolve(import.meta.dirname, "electron/preload/index.ts"),
        output: {
          format: "cjs",
          entryFileNames: "index.cjs"
        }
      }
    }
  },
  renderer: {
    root: resolve(import.meta.dirname, "src"),
    plugins: [react()],
    build: { rollupOptions: { input: resolve(import.meta.dirname, "src/index.html") } }
  }
});
