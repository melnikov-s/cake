import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const manualReload = process.env.CAKE_MANUAL_RELOAD === "1";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          main: resolve(import.meta.dirname, "src/main/main.ts"),
          "plugin-backend-host": resolve(import.meta.dirname, "src/main/plugin-backend-host.ts"),
        },
        output: { entryFileNames: "[name].js" },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["zod"] })],
    build: {
      rollupOptions: {
        input: resolve(import.meta.dirname, "src/preload/preload.ts"),
        output: {
          format: "cjs",
          entryFileNames: "preload.cjs",
        },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, "src/renderer"),
    server: { hmr: !manualReload },
    esbuild: {
      target: "es2022",
    },
    resolve: {
      alias: {
        "@": resolve(import.meta.dirname, "src/renderer"),
        cake: resolve(import.meta.dirname, "src/renderer/cake.ts"),
        "virtual:cake-scene": resolve(import.meta.dirname, "src/renderer/factory-scene.tsx"),
        "virtual:cake-plugins": resolve(
          import.meta.dirname,
          "src/renderer/empty-plugin-catalog.ts",
        ),
      },
    },
    plugins: [react(), tailwindcss()],
    worker: { format: "es" },
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, "src/renderer/index.html"),
          "rpc-test-harness": resolve(import.meta.dirname, "src/renderer/rpc-test-harness.html"),
        },
      },
    },
  },
});
