import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const theme of ["light", "dark"] as const) {
  test(`saved visuals appear once, expanded inline by default (${theme})`, async () => {
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
        PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    try {
      const page = await app.firstWindow();
      await page.emulateMedia({ colorScheme: theme });
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 1000),
      );
      const disclosures = page.locator('[data-slot="artifact-disclosure"]');
      await expect(page.getByRole("button", { name: "1 artifacts" })).toBeVisible({
        timeout: 20000,
      });
      await expect(disclosures).toHaveCount(1);
      await expect(page.getByRole("link", { name: "saved visualization" })).toBeVisible();
      const inline = disclosures.first();
      await expect(
        inline.getByRole("button", { name: "Inline visualization Collapse" }),
      ).toHaveAttribute("aria-expanded", "true");
      const iframe = inline.locator("iframe");
      const frame = iframe.contentFrame();
      await expect(frame.getByRole("heading", { name: "One artifact, two views" })).toBeVisible();
      await expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-downloads");
      await expect(frame.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(frame.locator("html")).toHaveAttribute("data-presentation", "inline");
      await expect(frame.locator("html")).toHaveAttribute("data-cake-widget-ready", "true");
      const originalSrc = await iframe.getAttribute("src");
      const initialHeight = await iframe.evaluate(
        (element) => element.getBoundingClientRect().height,
      );
      expect(initialHeight).toBe(600);
      const resize = inline.getByRole("separator", { name: "Resize Inline visualization" });
      await resize.focus();
      await resize.press("ArrowDown");
      await expect(resize).toHaveAttribute("aria-valuenow", "616");
      const grip = (await resize.boundingBox())!;
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + 64);
      await page.mouse.up();
      await expect(resize).toHaveAttribute("aria-valuenow", "680");
      await expect
        .poll(() => iframe.evaluate((element) => element.getBoundingClientRect().height))
        .toBe(680);
      const explore = frame.getByRole("button", { name: "Explore detail" });
      await explore.focus();
      await explore.press("Enter");
      await expect(frame.getByRole("button", { name: "Hide detail" })).toBeVisible();
      // An unsaved, purely local edit must survive moves, not just rehydrate
      // from durable artifact state in a newly created iframe.
      await frame.locator("main").evaluate((element) => {
        element.dataset.unsaved = "retained";
      });

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
      // Rendering and interacting with a publication do not open its accessory panel.
      await expect(page.getByRole("complementary", { name: "Inline visualization" })).toHaveCount(
        0,
      );
      await expect(frame.getByRole("button", { name: "Hide detail" })).toBeVisible();
      await inline.getByRole("button", { name: "View Inline visualization fullscreen" }).click();
      const fullscreen = page.getByRole("dialog", { name: "Inline visualization" });
      await expect(
        fullscreen
          .locator("iframe")
          .contentFrame()
          .getByRole("heading", { name: "One artifact, two views" }),
      ).toBeVisible();
      const fullFrame = fullscreen.locator("iframe");
      const fullContent = fullFrame.contentFrame();
      await expect(fullContent.getByRole("button", { name: "Hide detail" })).toBeVisible();
      await expect(fullContent.locator("main")).toHaveAttribute("data-unsaved", "retained");
      expect(await fullFrame.getAttribute("src")).toBe(originalSrc);
      const assertFilled = async () => {
        const header = (await fullscreen.locator("header").boundingBox())!;
        const bounds = (await fullFrame.boundingBox())!;
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        expect(bounds.width).toBe(viewport.width);
        expect(bounds.height).toBeCloseTo(viewport.height - header.height, 0);
        expect(bounds.y).toBeCloseTo(header.height, 0);
        expect(
          await fullContent
            .locator("body")
            .evaluate((body) => body.scrollHeight > body.clientHeight),
        ).toBe(false);
        expect(
          await fullContent
            .getByTestId("canvas")
            .evaluate((element) => element.getBoundingClientRect().height),
        ).toBeGreaterThan(bounds.height - 250);
      };
      await assertFilled();
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(1000, 760),
      );
      await expect
        .poll(() => fullFrame.evaluate((element) => element.getBoundingClientRect().width))
        .toBe(1000);
      await assertFilled();
      await fullscreen
        .getByRole("button", { name: "Exit fullscreen Inline visualization" })
        .click();
      await expect(frame.locator("main")).toHaveAttribute("data-unsaved", "retained");
      await expect(frame.getByRole("button", { name: "Hide detail" })).toBeVisible();
      await expect
        .poll(() => iframe.evaluate((element) => element.getBoundingClientRect().height))
        .toBe(680);
      await expect(resize).toHaveAttribute("aria-valuenow", "680");
      const collapse = inline.getByRole("button", { name: "Inline visualization Collapse" });
      await collapse.focus();
      await collapse.press("Enter");
      await expect(inline.locator("iframe")).toHaveCount(0);
      const expand = inline.getByRole("button", { name: "Inline visualization Expand" });
      await expand.focus();
      await expand.press("Enter");
      await expect(
        inline.locator("iframe").contentFrame().getByRole("button", { name: "Explore detail" }),
      ).toBeVisible();
      await expect(disclosures).toHaveCount(1);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
