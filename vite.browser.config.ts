import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: resolve(import.meta.dirname, "src/renderer/browser"),
  resolve: { alias: { "@": resolve(import.meta.dirname, "src/renderer") } },
  plugins: [react(), tailwindcss()],
  esbuild: { target: "es2022" },
  worker: { format: "es" },
  build: {
    outDir: resolve(import.meta.dirname, "out/browser"),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: false,
  },
});
