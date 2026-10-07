import { resolve } from "node:path";
import { spawn } from "node:child_process";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

import { buildIdentity } from "./scripts/build-identity.mjs";
import { excalidrawFonts } from "./scripts/excalidraw-fonts";
const buildDefine = { __CAKE_BUILD_ID__: JSON.stringify(buildIdentity()) };

const manualReload = process.env.CAKE_MANUAL_RELOAD === "1";

export default defineConfig({
  main: {
    define: buildDefine,
    plugins: [
      externalizeDepsPlugin(),
      {
        name: "cake-native-speech",
        async writeBundle() {
          for (const script of ["build-dictation.mjs", "build-speech.mjs"]) {
            console.log(`[cake] Running ${script}`);
            await new Promise<void>((resolveBuild, reject) => {
              const child = spawn(
                process.execPath,
                [
                  resolve(import.meta.dirname, "scripts", script),
                  resolve(import.meta.dirname, "out/main/native"),
                ],
                { stdio: "inherit" },
              );
              child.once("error", reject);
              child.once("close", (code, signal) => {
                if (code === 0) resolveBuild();
                else reject(new Error(`${script} failed (${signal ?? code})`));
              });
            });
          }
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
    define: buildDefine,
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
    plugins: [react(), tailwindcss(), excalidrawFonts()],
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
