import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          main: resolve(import.meta.dirname, "src/main/main.ts"),
          agent: resolve(import.meta.dirname, "src/agent/agent-process.ts")
        },
        output: { entryFileNames: "[name].js" }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["zod"] })],
    build: {
      rollupOptions: {
        input: resolve(import.meta.dirname, "src/preload/preload.ts"),
        output: {
          format: "cjs",
          entryFileNames: "preload.cjs"
        }
      }
    }
  },
  renderer: {
    root: resolve(import.meta.dirname, "src/renderer"),
    resolve: {
      alias: {
        "@": resolve(import.meta.dirname, "src/renderer")
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: { input: resolve(import.meta.dirname, "src/renderer/index.html") }
    }
  }
});
