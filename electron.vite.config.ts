import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const manualReload = process.env.CAKE_MANUAL_RELOAD === "1";

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      {
        name: "cake-native-dictation",
        async writeBundle() {
          const { stdout, stderr } = await promisify(execFile)(
            process.execPath,
            [
              resolve(import.meta.dirname, "scripts/build-dictation.mjs"),
              resolve(import.meta.dirname, "out/main/native"),
            ],
            { maxBuffer: 8 * 1024 * 1024 },
          );
          if (stdout) console.log(stdout.trim());
          if (stderr) console.warn(stderr.trim());
        },
      },
    ],
    build: {
      rollupOptions: {
        input: {
          main: resolve(import.meta.dirname, "src/main/main.ts"),
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
      },
    },
    plugins: [react(), tailwindcss()],
    worker: { format: "es" },
    build: {
      // Keep third-party editor assets as local files under Cake's intentionally narrow CSP.
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, "src/renderer/index.html"),
          "rpc-test-harness": resolve(import.meta.dirname, "src/renderer/rpc-test-harness.html"),
        },
      },
    },
  },
});
