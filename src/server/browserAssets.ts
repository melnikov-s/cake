import { Effect, Schema } from "effect";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";

class BrowserAssetsError extends Schema.TaggedError<BrowserAssetsError>()("BrowserAssetsError", {
  message: Schema.String,
}) {}

const contentTypes = new Map([
  ["html", "text/html; charset=utf-8"],
  ["js", "text/javascript; charset=utf-8"],
  ["css", "text/css; charset=utf-8"],
  ["woff", "font/woff"],
  ["woff2", "font/woff2"],
  ["ttf", "font/ttf"],
  ["png", "image/png"],
  ["svg", "image/svg+xml"],
]);

export interface BrowserAsset {
  readonly body: Uint8Array;
  readonly contentType: string;
}

/** Immutable, bounded build inventory. Requests never read a caller-selected filesystem path.
 * Only the entry and emitted assets are public; source maps and arbitrary files are excluded.
 */
export const loadBrowserAssets = Effect.fn("BrowserAssets.load")(function* (directory: string) {
  return yield* Effect.tryPromise({
    try: async () => {
      const root = await realpath(directory);
      const assets = new Map<string, BrowserAsset>();
      let total = 0;
      const add = async (route: string, path: string) => {
        const resolved = await realpath(path);
        const inside = relative(root, resolved);
        if (inside.startsWith("..") || isAbsolute(inside))
          throw new Error("Browser asset escapes its build directory");
        const extension = path.split(".").at(-1) ?? "";
        const contentType = contentTypes.get(extension);
        if (!contentType) return;
        const info = await stat(resolved);
        total += info.size;
        if (
          !info.isFile() ||
          info.size > 32 * 1024 * 1024 ||
          total > 128 * 1024 * 1024 ||
          assets.size >= 2048
        )
          throw new Error("Browser build exceeds asset limits");
        const body = await readFile(resolved);
        assets.set(route, { body, contentType });
      };
      await add("/", join(root, "index.html"));
      for (const entry of await readdir(join(root, "assets"), { withFileTypes: true })) {
        if (!entry.isFile() || !/^[a-zA-Z0-9_.-]+$/.test(entry.name)) continue;
        await add(`/assets/${entry.name}`, join(root, "assets", entry.name));
      }
      return assets;
    },
    catch: (error) =>
      new BrowserAssetsError({ message: `Cannot load browser build: ${String(error)}` }),
  });
});

/** Exact emitted routes only: no decoding, normalization, directory fallback or SPA catch-all. */
export function browserAssetAt(assets: ReadonlyMap<string, BrowserAsset>, url: string) {
  return assets.get(url);
}
