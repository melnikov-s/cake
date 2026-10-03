import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createServer } from "vite";
import { expect, test } from "vitest";
import { excalidrawFonts } from "../../scripts/excalidraw-fonts";

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(require.resolve("@excalidraw/excalidraw")), "..");

test("Excalidraw font assets and bootstrap are served locally during development", async () => {
  const server = await createServer({
    configFile: false,
    root: resolve(import.meta.dirname, "../../src/renderer"),
    plugins: [excalidrawFonts()],
    server: { host: "127.0.0.1", port: 0, fs: { allow: [packageRoot] } },
  });
  try {
    await server.listen();
    const origin = server.resolvedUrls!.local[0]!;
    const html = await server.transformIndexHtml("/index.html", "<html><head></head></html>");
    expect(html).toContain('<script src="/excalidraw/configure-fonts.js"></script>');
    const script = await fetch(new URL("excalidraw/configure-fonts.js", origin));
    expect(script.headers.get("Content-Type")).toBe("text/javascript");
    expect(await script.text()).toContain("window.EXCALIDRAW_ASSET_PATH");
    const font = await fetch(
      new URL("excalidraw/fonts/Cascadia/CascadiaCode-Regular.woff2", origin),
    );
    expect(font.headers.get("Content-Type")).toBe("font/woff2");
    expect(Buffer.from(await font.arrayBuffer())).toEqual(
      await readFile(resolve(packageRoot, "prod/fonts/Cascadia/CascadiaCode-Regular.woff2")),
    );

    // Exercise both pinned package variants through Vite's real transform pipeline.
    for (const variant of ["dev", "prod"]) {
      const directory = resolve(packageRoot, variant);
      const chunks = (await readdir(directory)).filter((name) => name.endsWith(".js"));
      const fontChunk = (
        await Promise.all(
          chunks.map(async (name) => ({
            name,
            source: await readFile(resolve(directory, name), "utf8"),
          })),
        )
      ).find(({ source }) => source.includes("ASSETS_FALLBACK_URL"))!;
      const result = await server.transformRequest(`/@fs/${resolve(directory, fontChunk.name)}`);
      expect(result?.code).toMatch(
        /(\w+)\.length\s*\|\|\s*\1\.push\(new URL\(\w+,\s*\w+\.ASSETS_FALLBACK_URL\)\)/,
      );
    }
  } finally {
    await server.close();
  }
});
