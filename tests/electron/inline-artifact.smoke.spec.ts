import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const theme of ["light", "dark"] as const) {
  test(`saved visuals expand inline without replacing the artifact (${theme})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-inline-artifact-"));
    const paths = {
      cakeHome: join(root, "cake-home"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    await findVisualCaptureScenario("inline-artifact")!.seed(paths, theme);
    const app = await electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: paths.userData,
        CAKE_HOME: paths.cakeHome,
      },
    });
    try {
      const page = await app.firstWindow();
      await page.emulateMedia({ colorScheme: theme });
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 1000),
      );
      const disclosures = page.locator('[data-slot="artifact-disclosure"]');
      await expect(disclosures).toHaveCount(2);
      await expect(page.getByRole("link", { name: "saved visualization" })).toBeVisible();
      await expect(disclosures.locator("iframe")).toHaveCount(0);
      const inline = disclosures.first();
      const toggle = inline.getByRole("button", { name: "Inline visualization Show inline" });
      await toggle.focus();
      await toggle.press("Enter");
      const iframe = inline.locator("iframe");
      const frame = iframe.contentFrame();
      await expect(frame.getByRole("heading", { name: "One artifact, two views" })).toBeVisible();
      await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
      await expect(frame.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(frame.locator("html")).toHaveAttribute("data-presentation", "inline");
      const originalSrc = await iframe.getAttribute("src");
      const initialHeight = await iframe.evaluate(
        (element) => element.getBoundingClientRect().height,
      );
      await frame.getByRole("button", { name: "Explore detail" }).click();
      await expect
        .poll(() => iframe.evaluate((element) => element.getBoundingClientRect().height))
        .toBeGreaterThan(initialHeight + 400);
      await frame.getByRole("button", { name: "Hide detail" }).click();
      await expect
        .poll(() => iframe.evaluate((element) => element.getBoundingClientRect().height))
        .toBeLessThan(initialHeight + 20);
      await frame.getByRole("button", { name: "Explore detail" }).click();

      const nextTheme = theme === "light" ? "dark" : "light";
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, nextTheme);
      await expect(frame.locator("html")).toHaveAttribute("data-theme", nextTheme);
      await expect(frame.getByRole("button", { name: "Hide detail" })).toBeVisible();
      expect(await iframe.getAttribute("src")).toBe(originalSrc);
      const hostColor = await page.locator("body").evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--foreground)";
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      await expect
        .poll(() => frame.locator("main").evaluate((element) => getComputedStyle(element).color))
        .toBe(hostColor);
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(680, 1000),
      );
      expect(
        await frame.locator("body").evaluate((body) => body.scrollWidth > body.clientWidth),
      ).toBe(false);
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 1000),
      );

      const isolation = await frame.locator("body").evaluate(async () => {
        let parentAccessible = false;
        try {
          parentAccessible = !!parent.document;
        } catch {
          // The opaque-origin sandbox must reject parent DOM access.
        }
        let networkAccessible = false;
        try {
          await fetch("https://example.com");
          networkAccessible = true;
        } catch {
          // The widget CSP must reject active network access.
        }
        return {
          parentAccessible,
          networkAccessible,
          node: "process" in globalThis,
          cake: "cake" in globalThis,
        };
      });
      expect(isolation).toEqual({
        parentAccessible: false,
        networkAccessible: false,
        node: false,
        cake: false,
      });
      await inline.getByRole("link", { name: "Open artifact" }).click();
      const workspace = page.getByRole("complementary", { name: "Inline visualization" });
      const panelFrame = workspace.locator("iframe").contentFrame();
      await expect(panelFrame.getByRole("button", { name: "Explore detail" })).toBeVisible();
      await expect(frame.getByRole("button", { name: "Hide detail" })).toBeVisible();
      await expect(page.getByRole("button", { name: "1 artifacts" })).toBeVisible();
      await page.getByRole("button", { name: "Close Inline visualization" }).click();
      await inline.getByRole("button", { name: "View Inline visualization fullscreen" }).click();
      const fullscreen = page.getByRole("dialog", { name: "Inline visualization" });
      await expect(
        fullscreen
          .locator("iframe")
          .contentFrame()
          .getByRole("heading", { name: "One artifact, two views" }),
      ).toBeVisible();
      await fullscreen
        .getByRole("button", { name: "Exit fullscreen Inline visualization" })
        .click();
      await inline.getByRole("button", { name: "Inline visualization Hide inline" }).click();
      await expect(inline.locator("iframe")).toHaveCount(0);
      await disclosures
        .last()
        .getByRole("button", { name: "Inline visualization Show inline" })
        .click();
      await expect(
        disclosures
          .last()
          .locator("iframe")
          .contentFrame()
          .getByRole("button", { name: "Explore detail" }),
      ).toBeVisible();
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
