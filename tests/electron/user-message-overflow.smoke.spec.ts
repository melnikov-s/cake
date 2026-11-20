import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("user messages with long attachment names and unbroken text stay inside the chat column", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-user-message-overflow-"));
  await build({
    entryPoints: [join(import.meta.dirname, "user-message-overflow-fixture.tsx")],
    outfile: join(directory, "fixture.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    target: "es2022",
    loader: { ".css": "empty", ".svg": "text", ".png": "dataurl" },
    plugins: [
      {
        name: "fixture-virtual-modules",
        setup(builder) {
          // This isolated fixture does not run Vite's dev-only inspector plugin.
          builder.onResolve({ filter: /^virtual:r-state-tree-inspector$/ }, () => ({
            path: "inspector",
            namespace: "fixture-inspector",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture-inspector" }, () => ({
            contents: "export const token = undefined;",
            loader: "js",
          }));
          builder.onResolve({ filter: /\?url$/ }, ({ path }) => ({ path, namespace: "asset-url" }));
          builder.onLoad({ filter: /.*/, namespace: "asset-url" }, ({ path }) => ({
            contents: `export default ${JSON.stringify(path)}`,
            loader: "js",
          }));
        },
      },
    ],
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
  });
  const assets = join(repositoryRoot, "out/renderer/assets");
  const css = (await readdir(assets)).find(
    (name) => name.startsWith("index-") && name.endsWith(".css"),
  )!;
  await writeFile(
    join(directory, "fixture.html"),
    `<!doctype html><html class="dark"><head><link rel="stylesheet" href="${pathToFileURL(join(assets, css))}"></head><body><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>`,
  );
  const main = join(directory, "main.cjs");
  await writeFile(
    main,
    `const { app, BrowserWindow } = require("electron");
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 900, height: 2400 });
  await window.loadFile(${JSON.stringify(join(directory, "fixture.html"))});
});`,
  );
  const application = await electron.launch({
    args: [main, `--user-data-dir=${join(directory, "user-data")}`],
    cwd: repositoryRoot,
    env: { ...process.env, CAKE_ELECTRON_SMOKE: "1" },
  });
  try {
    const page = await application.firstWindow();
    await expect(page.locator('[data-slot="message"]')).toHaveCount(4);
    for (const column of ["desktop", "phone"]) {
      await page.getByTestId(column).screenshot({ path: test.info().outputPath(`${column}.png`) });
      const problems = await page.getByTestId(column).evaluate((section) => {
        const bounds = section.getBoundingClientRect();
        const right = bounds.right - parseFloat(getComputedStyle(section).paddingRight);
        const found: string[] = [];
        const describe = (element: Element) =>
          `${element.tagName.toLowerCase()}[${element.getAttribute("data-slot") ?? element.className.toString().slice(0, 40)}] "${element.textContent?.slice(0, 40)}"`;
        for (const message of section.querySelectorAll('[data-slot="message"]')) {
          for (const element of [message, ...message.querySelectorAll("*")]) {
            if (!(element instanceof HTMLElement) || element.offsetParent === null) continue;
            const rect = element.getBoundingClientRect();
            if (rect.right > right + 0.5)
              found.push(`${describe(element)} ends at ${rect.right}, column at ${right}`);
            const style = getComputedStyle(element);
            const clips = style.overflowX !== "visible" || style.textOverflow === "ellipsis";
            if (clips && element.scrollWidth > element.clientWidth + 1)
              found.push(
                `${describe(element)} clips ${element.scrollWidth - element.clientWidth}px of content`,
              );
          }
        }
        return found;
      });
      expect(problems, column).toEqual([]);
    }
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
