import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import type { ContextTooltipScope } from "./context-tooltip-fixture";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scopes: readonly ContextTooltipScope[] = [
  "global",
  "project-chat",
  "project-session",
  "side-chat",
];

for (const scope of scopes) {
  test(`${scope} context target responds to its container and retains hover/focus details`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "cake-context-tooltip-"));
    const cakeHome = join(directory, "cake-home");
    await mkdir(cakeHome);
    await build({
      entryPoints: [join(import.meta.dirname, "context-tooltip-fixture.tsx")],
      outfile: join(directory, "fixture.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      target: "es2022",
      loader: { ".css": "empty", ".svg": "text", ".png": "dataurl" },
      plugins: [
        {
          name: "asset-urls",
          setup(builder) {
            builder.onResolve({ filter: /\?url$/ }, ({ path }) => ({
              path,
              namespace: "asset-url",
            }));
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
    const html = join(directory, "fixture.html");
    await writeFile(
      html,
      `<!doctype html><html><head><link rel="stylesheet" href="${pathToFileURL(join(assets, css))}"></head><body class="dark"><div id="root" style="height:600px;width:760px"></div><script type="module" src="./fixture.js"></script></body></html>`,
    );
    const application = await electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: join(directory, "user-data"),
        CAKE_HOME: cakeHome,
        PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    try {
      await application.firstWindow();
      const errors: string[] = [];
      application.on("window", (page) =>
        page.on("pageerror", (error) => errors.push(error.message)),
      );
      const opened = application.waitForEvent("window");
      await application.evaluate(
        async ({ BrowserWindow }, { html, scope, projectChatId }) => {
          const window = new BrowserWindow({
            show: false,
            width: 1400,
            height: 900,
            webPreferences: { sandbox: true },
          });
          await window.loadFile(html, {
            search: new URLSearchParams({ scope, projectChatId }).toString(),
          });
        },
        {
          html,
          scope,
          projectChatId: `project-chat:${createHash("sha256").update("/project").digest("hex")}`,
        },
      );
      const page = await opened;
      const target =
        scope === "project-session"
          ? page.getByLabel(/context used;/)
          : scope === "side-chat"
            ? page.getByRole("img", { name: "Context usage", exact: true })
            : page.getByRole("button", { name: "Browse context", exact: true });
      const tooltip = page.getByRole("tooltip");
      await expect
        .poll(async () => ({ errors, targets: await target.count() }))
        .toEqual({ errors: [], targets: 1 });
      await expect(target).toBeVisible();
      await expect(target).toHaveAttribute("data-cache-state", "likely-warm");
      const labels = target.locator(":scope > span");
      const percent = labels.nth(0);
      const counts = labels.nth(1);
      const viewportWidth = await page.evaluate(() => innerWidth);
      let fullWidth = 0;
      let percentWidth = 0;
      for (const width of [760, 640, 639, 560, 448, 447, 360, 447, 448, 639, 640, 760, 360]) {
        await page.locator("#root").evaluate((root, width) => {
          root.style.width = `${width}px`;
        }, width);
        const full = width >= 640;
        const compact = width < 448;
        if (full) await expect(counts).toBeVisible();
        else await expect(counts).toBeHidden();
        if (!compact && (scope === "project-session" || !full)) await expect(percent).toBeVisible();
        else await expect(percent).toBeHidden();
        const geometry = await target.evaluate((element) => {
          const badge = element.getBoundingClientRect();
          const toolbar = element.closest('[data-slot="composer-toolbar"]')!;
          const bounds = toolbar.getBoundingClientRect();
          const send = toolbar.querySelector('button[aria-label="Send"]')!.getBoundingClientRect();
          return {
            width: badge.width,
            height: badge.height,
            contained: badge.left >= bounds.left && badge.right <= bounds.right,
            beforeSend: badge.right <= send.left,
            overflow: toolbar.scrollWidth > toolbar.clientWidth,
          };
        });
        expect(geometry.height).toBe(28);
        expect(geometry.contained).toBe(true);
        expect(geometry.beforeSend).toBe(true);
        expect(geometry.overflow).toBe(false);
        if (full) fullWidth = geometry.width;
        else if (!compact) {
          percentWidth = geometry.width;
          expect(percentWidth).toBeLessThan(fullWidth);
        } else {
          expect(geometry.width).toBe(28);
          expect(geometry.width).toBeLessThan(percentWidth);
        }
        expect(await page.evaluate(() => innerWidth)).toBe(viewportWidth);
      }
      await target.hover();
      await expect(tooltip).toHaveCount(1);
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toContainText(
        scope === "side-chat"
          ? "Estimated active model context"
          : scope === "project-session"
            ? "Cache"
            : "Next: Continue",
      );
      // Chromium's native bubble isn't a DOM tooltip. Check every possible title
      // owner under the pointer as well as counting the visible custom portals.
      expect(
        await target.evaluate((element) => element.closest("[title]")?.outerHTML),
      ).toBeUndefined();
      await expect(target.locator("[title]")).toHaveCount(0);
      if (scope === "project-session") {
        await expect(target).toHaveAccessibleName(/20% context used;.*Cache/);
        await expect(target).toHaveAccessibleDescription(
          /51,500 of 255,600.*51,510 billed tokens.*Cache/,
        );
        await expect(tooltip).toContainText("51,510 billed tokens");
        await expect(tooltip).toContainText("OpenAI’s 30-minute cache window refreshes on use.");
      } else if (scope === "side-chat") {
        await expect(target).toHaveAccessibleName("Context usage");
        await expect(target).toHaveAccessibleDescription(/51,500 of 255,600 tokens/);
        await expect(tooltip).toContainText("51,500 of 255,600 tokens");
      } else {
        await expect(target).toHaveAccessibleName("Browse context");
        await expect(target).toHaveAccessibleDescription(
          /^Estimated active context [\d,]+ of [\d,]+ tokens\. System [\d,]+; memory [\d,]+; messages [\d,]+\. Cache: Likely warm\s+Expires: ≈30 min\s+Next: Continue$/,
        );
        await expect(tooltip).toContainText("51,500 of 255,600 tokens.");
        await expect(tooltip).toContainText("Cache: Likely warm\nExpires: ≈30 min\nNext: Continue");
      }
      await page.mouse.move(1, 1);
      await expect(tooltip).toHaveCount(0);
      // Native Tab traversal, not dispatching a synthetic React focus event.
      await target.evaluate((element) => {
        const previous = document.createElement("button");
        previous.textContent = "Focus start";
        element.before(previous);
        previous.focus();
      });
      await page.keyboard.press("Tab");
      await expect(target).toBeFocused();
      await expect(tooltip).toHaveCount(1);
      await expect(tooltip).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(tooltip).toHaveCount(0);

      // Shared Chat input remains usable; slash-keyboard interaction stays local.
      const input = page.getByRole("combobox", {
        name:
          scope === "global"
            ? "Message Cake Chat"
            : scope === "project-chat"
              ? "Message Project Chat"
              : "Message",
        exact: true,
      });
      await input.click();
      await input.pressSequentially("Draft stays local");
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("Draft stays local");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await input.fill("/nam");
      await expect(page.getByRole("listbox", { name: "Slash commands" })).toBeVisible();
      await input.press("ArrowDown");
      await input.press("Tab");
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("/name ");
      if (scope === "global" || scope === "project-chat") {
        await target.click();
        const dialog = page.getByRole("dialog", { name: "Context", exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole("cell", { name: "51,500", exact: true })).toBeVisible();
        await dialog.getByRole("button", { name: "Close context", exact: true }).click();
        await expect(target).toBeFocused();
      }
      expect(errors).toEqual([]);
      expect(
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every(
            (window) => !window.isVisible() && !window.isFocused(),
          ),
        ),
      ).toBe(true);
    } finally {
      await application.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
