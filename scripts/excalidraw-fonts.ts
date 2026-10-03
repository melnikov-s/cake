import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { Plugin } from "vite";

/** Preserve the font paths Excalidraw resolves at runtime, in both dev and packaged builds. */
export function excalidrawFonts(): Plugin {
  const require = createRequire(import.meta.url);
  const packageRoot = resolve(dirname(require.resolve("@excalidraw/excalidraw")), "..");
  const fontRoot = resolve(packageRoot, "prod/fonts");
  const assets = new Map(
    readdirSync(fontRoot, { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".woff2"))
      .map((path) => [
        `excalidraw/fonts/${path.replaceAll("\\", "/")}`,
        readFileSync(resolve(fontRoot, path)),
      ]),
  );
  // Configure the base before any module can register a FontFace. The script's
  // own URL supplies the correct base for both HTTP and packaged file:// pages.
  assets.set(
    "excalidraw/configure-fonts.js",
    Buffer.from('window.EXCALIDRAW_ASSET_PATH = new URL("./", document.currentScript.src).href;'),
  );
  let base = "/";
  return {
    name: "cake-excalidraw-fonts",
    // Keep the package in Vite's transform pipeline during development as well.
    config: () => ({ optimizeDeps: { exclude: ["@excalidraw/excalidraw"] } }),
    transform(code, id) {
      if (!id.startsWith(`${packageRoot}/`) || !code.includes("ASSETS_FALLBACK_URL")) return;
      // 0.18.1 always appends its CDN even with a configured base. Chromium checks
      // every FontFace source against CSP, including unused fallbacks. Only add
      // the CDN when no asset base was configured (matches dev and minified prod).
      return {
        code: code.replace(
          /(\w+)\.push\(new URL\(\w+,\s*\w+\.ASSETS_FALLBACK_URL\)\)/g,
          "$1.length || $&",
        ),
        map: null,
      };
    },
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler: () => [
        {
          tag: "script",
          attrs: { src: `${base}excalidraw/configure-fonts.js` },
          injectTo: "head",
        },
      ],
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split("?")[0]?.replace(/^\//, "");
        const asset = path ? assets.get(path) : undefined;
        if (!asset) return next();
        response.setHeader(
          "Content-Type",
          path?.endsWith(".woff2") ? "font/woff2" : "text/javascript",
        );
        response.end(asset);
      });
    },
    generateBundle() {
      for (const [fileName, source] of assets) {
        this.emitFile({ type: "asset", fileName, source });
      }
    },
  };
}
