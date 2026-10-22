import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repository = resolve(import.meta.dirname, "../..");

for (const theme of ["light", "dark"] as const) {
  test(`to-do associations stay compact, inspectable and navigable in ${theme} mode`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "cake-todo-links-"));
    const paths = {
      cakeHome: join(directory, "cake-home"),
      project: join(directory, "project"),
      userData: join(directory, "user-data"),
    };
    const scenario = findVisualCaptureScenario("project-chat-todos")!;
    await scenario.seed(paths, theme);
    const app = await electron.launch({
      args: [repository],
      cwd: repository,
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
      await page.setViewportSize({ width: 1500, height: 900 });
      await scenario.prepare(page, "open");
      const panel = page.getByRole("complementary", { name: "To-do", exact: true });
      const startup = panel.getByRole("button", { name: "Startup investigation", exact: true });
      const navigation = panel.getByRole("button", {
        name: "Improve project navigation",
        exact: true,
      });
      const startupCue = startup.locator("..");
      const startupSession = page.locator(
        '.session-item[data-session-id="visual-assistant-markdown-code"]',
      );
      const navigationSession = page.locator(
        '.session-item[data-session-id="visual-todo-waiting"]',
      );
      await expect(startupCue).toHaveAttribute("data-associated", "true");
      await expect(startupCue).toHaveCSS("outline-style", "dashed");
      await expect(startupSession).toHaveAttribute("data-associated", "true");
      await expect(startupSession).toHaveCSS("outline-style", "dashed");
      await expect
        .poll(
          async () =>
            (await startupCue.evaluate((row) => getComputedStyle(row).backgroundColor)) ===
            (await startupSession.evaluate((row) => getComputedStyle(row).backgroundColor)),
        )
        .toBe(true);
      await expect(startup).not.toHaveAttribute("aria-current");
      await startup.click();
      await expect(startup).toHaveAttribute("aria-pressed", "false");
      await expect(startupSession).not.toHaveAttribute("data-associated");
      await navigation.click();
      await expect(startupSession).not.toHaveAttribute("data-associated");
      await expect(navigationSession).toHaveAttribute("data-associated", "true");
      await startup.click();
      await expect(startupSession).toHaveAttribute("data-associated", "true");
      await expect(navigationSession).not.toHaveAttribute("data-associated");
      await startupSession.locator(".session-row").hover();
      await expect(startupSession).toHaveCSS("outline-style", "dashed");
      const hover = page.locator('[data-slot="navigation-hover"]');
      await expect(hover).toHaveAttribute("data-visible", "true");
      await expect
        .poll(
          async () =>
            (await startupSession.evaluate((row) => getComputedStyle(row).backgroundColor)) ===
            (await hover.evaluate((layer) => getComputedStyle(layer).backgroundColor)),
        )
        .toBe(true);
      await page.mouse.move(1, 1);
      const destinations = [
        ["Startup investigation session", "cake://session/visual-assistant-markdown-code"],
        [
          "Exact investigation report",
          "cake://session/visual-assistant-markdown-code?message=assistant-1",
        ],
        ["Startup reference website", "https://example.com/startup"],
        ["Startup findings artifact", "cake://artifact/visual-todo-report"],
        ["Investigation notes", "README.md"],
        ["Startup implementation", "startup.ts#L1"],
      ];
      const icons: string[] = [];
      for (const [title, href] of destinations) {
        const link = panel.getByRole("link", { name: title, exact: true });
        await expect(link).toHaveAttribute("href", href);
        await expect(link).toHaveAccessibleDescription(href!);
        await expect(link).toHaveCSS("font-size", "11px");
        await expect(link).toHaveCSS("font-weight", "400");
        await expect(link).toHaveCSS("line-height", "16px");
        await expect(link).toHaveCSS("text-decoration-line", "none");
        const icon = link.locator("..").locator(":scope > span > svg");
        await expect(icon).toHaveAttribute("aria-hidden", "true");
        await expect(icon).toHaveCSS("width", "12px");
        await expect(icon).toHaveCSS("height", "12px");
        icons.push(await icon.innerHTML());
        await link.hover();
        await expect(page.getByRole("tooltip")).toHaveText(href!);
        await expect(link).toHaveCSS("text-decoration-line", "underline");
        await page.mouse.move(1, 1);
        await expect(page.getByRole("tooltip")).not.toBeAttached();
      }
      expect(new Set(icons.slice(0, 5)).size).toBe(5);
      const session = panel.getByRole("link", {
        name: "Startup investigation session",
        exact: true,
      });
      await session.focus();
      await page.keyboard.press("Tab");
      await expect(
        panel.getByRole("button", { name: "Mark done: Startup investigation", exact: true }),
      ).toBeFocused();
      for (const [title, href] of destinations.slice(1)) {
        await page.keyboard.press("Tab");
        const link = panel.getByRole("link", { name: title, exact: true });
        await expect(link).toBeFocused();
        await expect(page.getByRole("tooltip")).toHaveText(href!);
        await expect(link).toHaveCSS("outline-style", "solid");
      }
      await page.setViewportSize({ width: 780, height: 800 });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("link", { name: "Startup implementation" })).toBeVisible();
      await panel.getByRole("link", { name: "Exact investigation report", exact: true }).click();
      await expect(
        page.locator('[data-slot="transcript-item"][aria-current="true"]'),
      ).toContainText("Repository-owned visual checks");
      // Navigation selection wins over the advisory cue without clearing the to-do context.
      await expect(startupSession).toHaveAttribute("data-navigation-active", "true");
      await expect(startupSession).not.toHaveAttribute("data-associated");
      await expect(startupSession).toHaveCSS("outline-style", "none");
      await expect(startupSession.locator(".session-row > button")).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(page.locator('[data-slot="navigation-selection"]')).toHaveAttribute(
        "data-visible",
        "true",
      );
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
