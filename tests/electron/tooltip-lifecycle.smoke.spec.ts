import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("conversation tooltips dismiss stale hover and pending lifecycle state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-tooltip-lifecycle-"));
  await build({
    entryPoints: [join(import.meta.dirname, "tooltip-lifecycle-fixture.tsx")],
    outfile: join(directory, "fixture.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    loader: { ".svg": "text" },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const assets = join(repositoryRoot, "out/renderer/assets");
  const css = (await readdir(assets)).find(
    (name) => name.startsWith("index-") && name.endsWith(".css"),
  )!;
  await writeFile(
    join(directory, "fixture.html"),
    `<!doctype html><html><head><link rel="stylesheet" href="${pathToFileURL(join(assets, css))}"></head><body><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>`,
  );
  const main = join(directory, "main.cjs");
  await writeFile(
    main,
    `const { app, BrowserWindow } = require("electron");
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 900, height: 600 });
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
    const trigger = page.locator('[data-slot="task-section-disclosure"]');
    const tooltip = page.getByRole("tooltip");
    const scroll = page.getByTestId("scroll");
    const hover = async () => {
      await page.mouse.move(850, 550);
      await trigger.hover();
      await expect(tooltip).toHaveText("Collapse conversation: Show all projects");
    };
    await hover();
    await page.screenshot({ path: test.info().outputPath("hover.png") });

    // A small real scroll moves the heading without taking it out from under the pointer.
    // There is no mouseleave, so the fixed-position bubble must dismiss independently.
    await page.mouse.wheel(0, 5);
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(tooltip).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("scroll-dismissed.png") });

    await scroll.evaluate((element) => {
      element.scrollTop = 0;
    });
    await hover();
    await page.mouse.move(850, 550);
    await expect(tooltip).toHaveCount(0);

    await hover();
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
    await page.waitForTimeout(180);
    await expect(tooltip).toHaveCount(0);

    await page.mouse.move(850, 550);
    await trigger.focus();
    await expect(tooltip).toHaveText("Collapse conversation: Show all projects");
    // A normal rerender/action changes the label, not the focused trigger's identity.
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(tooltip).toHaveText("Expand conversation: Show all projects");
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(tooltip).toHaveText("Collapse conversation: Show all projects");
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(tooltip).toHaveCount(0);
    await page.getByTestId("outside").focus();
    await trigger.focus();
    await expect(tooltip).toBeVisible();
    await page.getByTestId("outside").focus();
    await expect(tooltip).toHaveCount(0);

    await hover();
    // Synthetic boundary event avoids activating any native window on the user's desktop.
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(tooltip).toHaveCount(0);

    await page.mouse.move(850, 550);
    await trigger.hover();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(180);
    await expect(tooltip).toHaveCount(0);

    await page.mouse.move(850, 550);
    await hover();
    await page.getByTestId("replace").evaluate((element) => element.click());
    await expect(tooltip).toHaveCount(0);

    await page.mouse.move(850, 550);
    await page.getByTestId("conditional-trigger").hover();
    await expect(tooltip).toHaveText("Conditional tooltip");
    // The hook owner survives removal of its anchor; DOM removal emits no mouseleave.
    await page.getByTestId("remove").evaluate((element) => element.click());
    await expect(tooltip).toHaveCount(0);
    await page.waitForTimeout(180);
    await expect(tooltip).toHaveCount(0);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
