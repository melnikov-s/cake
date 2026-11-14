import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { rStateTreeInspector } from "r-state-tree/devtools/vite";
import { standardDecorators } from "./scripts/vite-standard-decorators";

export default defineConfig({
  root: resolve(import.meta.dirname, "src/renderer/browser"),
  resolve: { alias: { "@": resolve(import.meta.dirname, "src/renderer") } },
  // Use Vite's esbuild CSS optimizer, which recognizes native ::highlight().
  server: { host: "127.0.0.1" },
  plugins: [
    react(),
    tailwindcss({ optimize: false }),
    rStateTreeInspector({
      relayFile: resolve(import.meta.dirname, ".r-state-tree-browser-inspector.json"),
    }),
    standardDecorators(),
  ],
  oxc: { target: "es2022" },
  worker: { format: "es" },
  build: {
    outDir: resolve(import.meta.dirname, "out/browser"),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    cssMinify: "esbuild",
    sourcemap: false,
  },
});
