import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { verifyVirtuosoPatch } from "./scripts/verify-virtuoso-patch.mjs";

verifyVirtuosoPatch();

export default defineConfig({
  root: resolve(import.meta.dirname, "src/renderer/browser"),
  resolve: { alias: { "@": resolve(import.meta.dirname, "src/renderer") } },
  // Use Vite's esbuild CSS optimizer, which recognizes native ::highlight().
  plugins: [react(), tailwindcss({ optimize: false })],
  esbuild: { target: "es2022" },
  worker: { format: "es" },
  build: {
    outDir: resolve(import.meta.dirname, "out/browser"),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    cssMinify: "esbuild",
    sourcemap: false,
  },
});
