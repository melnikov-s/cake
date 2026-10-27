import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { createPerformanceFixture, fixture, marker, sessionId } from "./fixtures/performance";
import { installLocalModelHttpGuard } from "./main-harness";

const root = resolve(import.meta.dirname, "../..");

for (const visible of [false, true]) {
  test(`retained transcript navigation preserves drafts and latest selection ${visible ? "@foreground" : ""}`, async ({}, testInfo) => {
    test.skip(
      visible && process.env.CAKE_ELECTRON_FOREGROUND_TESTS !== "1",
      "Explicit desktop opt-in required",
    );
    test.setTimeout(120_000);
    const f = await createPerformanceFixture("http://127.0.0.1:1", 3);
    const app = await electron.launch({
      args: [root],
      cwd: root,
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        HOME: f.home,
        LANG: "en_US.UTF-8",
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: f.userData,
        CAKE_HOME: f.cakeHome,
        PI_CODING_AGENT_DIR: join(f.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    try {
      await installLocalModelHttpGuard(app, "http://127.0.0.1:1");
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize(fixture.viewport);
      if (visible)
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.showInactive());
      const transcript = page.locator(
        '.transcript:not([data-slot="content-transition-outgoing"] *)',
      );
      const composer = page.locator('textarea[aria-label="Message"]');
      const row = (i: number) =>
        page.locator(`.session-item[data-session-id="${sessionId(i)}"] .session-row`);
      await expect(transcript.getByText(marker(0), { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await composer.focus();
      await composer.pressSequentially("Retained draft zero");
      await expect(composer).toHaveValue("Retained draft zero");
      // A primary down and its subsequent click enter navigation only once.
      await page.evaluate(() => performance.mark("cake.session-switch.enabled"));
      await row(1).click();
      await expect(transcript.getByText(marker(1), { exact: true })).toBeVisible();
      await expect(composer).toBeFocused();
      await composer.pressSequentially("Retained draft one");
      await expect(composer).toHaveValue("Retained draft one");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      const starts = () =>
        page.evaluate(
          () =>
            performance
              .getEntriesByName("cake.session-switch")
              .filter((entry) => Reflect.get(entry, "detail").phase === "start").length,
        );
      expect(await starts()).toBe(1);
      // Same-target selection cannot replace the transcript or draft.
      await row(1).click();
      await expect(composer).toHaveValue("Retained draft one");
      await expect(transcript.getByText(marker(1), { exact: true })).toBeVisible();
      expect(await starts()).toBe(2);
      // Do not wait for each destination's hydration/transition before navigating again.
      await row(0).click();
      await row(2).click();
      await row(1).click();
      await expect(transcript.getByText(marker(1), { exact: true })).toBeVisible();
      await expect(composer).toHaveValue("Retained draft one");
      await expect(composer).toBeFocused();
      await row(0).click();
      await expect(transcript.getByText(marker(0), { exact: true })).toBeVisible();
      await expect(composer).toHaveValue("Retained draft zero");
      await expect(composer).toBeFocused();
      await composer.press("x");
      await expect(composer).toHaveValue("Retained draft zerox");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      expect(errors).toEqual([]);
      expect(
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible()),
      ).toBe(visible);
      if (visible) await page.screenshot({ path: testInfo.outputPath("visible-navigation.png") });
    } finally {
      await app.close();
      await f.cleanup();
    }
  });
}
