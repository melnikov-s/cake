import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const theme of ["light", "dark"] as const) {
  test(`source-backed explanation works in its real artifact sandbox (${theme})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-explanation-"));
    const paths = {
      cakeHome: join(root, "cake-home"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    const scenario = findVisualCaptureScenario("cake-request-explanation")!;
    await scenario.seed(paths, theme);
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
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 900);
      });
      await scenario.prepare(page, "default");
      const iframe = page.locator('iframe[title="A prompt through Cake"]');
      const frame = iframe.contentFrame();
      await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
      await expect(iframe).toHaveAttribute("src", /^cake-widget:/);
      await expect(frame.getByRole("heading", { name: "Intent, not privilege." })).toBeVisible();
      const next = frame.getByRole("button", { name: "Next: Cross" });
      const nextBox = await next.boundingBox();
      expect(nextBox!.y + nextBox!.height).toBeLessThanOrEqual(900);
      const globals = await frame.locator("body").evaluate(() => ({
        node: "process" in globalThis,
        hostBridge: "cake" in globalThis,
        requestCapability: "cakeRequest" in globalThis,
        horizontalOverflow: document.body.scrollWidth > document.body.clientWidth,
      }));
      expect(globals).toEqual({
        node: false,
        hostBridge: false,
        requestCapability: false,
        horizontalOverflow: false,
      });
      await next.click();
      await expect(frame.getByRole("heading", { name: "A narrow crossing." })).toBeVisible();
      const evidence = frame.getByRole("button", { name: "Inspect evidence" });
      await evidence.focus();
      await evidence.press("Enter");
      await expect(frame.getByText("src/preload/preload.ts:5–19")).toBeVisible();
      await frame.getByRole("button", { name: "04 Run" }).click();
      await expect(frame.getByRole("heading", { name: "Pi runs the agent." })).toBeVisible();
      await expect(frame.locator(".pi")).toHaveClass(/active/);
      await expect(frame.getByText("src/services/pi/PiSessions.ts:596–598")).toBeVisible();
      await frame.getByRole("button", { name: "05 Project" }).click();
      await expect(frame.getByText("UP / updates")).toBeVisible();
      await expect(
        frame.getByRole("heading", { name: "A view, not another transcript." }),
      ).toBeVisible();
      await frame.getByRole("button", { name: "Start again" }).click();
      await expect(frame.getByRole("button", { name: "01 Compose" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );

      await page.getByRole("button", { name: "View A prompt through Cake fullscreen" }).click();
      const full = page.locator('iframe[title="A prompt through Cake fullscreen"]');
      await expect(full).toBeVisible();
      const box = await full.boundingBox();
      expect(box!.width).toBeGreaterThan(1200);
      expect(box!.height).toBeGreaterThan(700);
      const fullFrame = full.contentFrame();
      await fullFrame.getByRole("button", { name: "04 Run" }).click();
      await expect(fullFrame.getByRole("heading", { name: "Pi runs the agent." })).toBeVisible();
      await fullFrame.getByRole("button", { name: "Inspect evidence" }).click();
      await expect(fullFrame.getByText("src/services/pi/PiSessions.ts:596–598")).toBeVisible();
      const overflow = await fullFrame
        .locator("body")
        .evaluate((body) => body.scrollWidth > body.clientWidth);
      expect(overflow).toBe(false);
      await page.getByRole("button", { name: "Exit fullscreen A prompt through Cake" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(frame.getByRole("button", { name: "01 Compose" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
