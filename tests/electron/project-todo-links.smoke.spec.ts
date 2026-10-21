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
        const icon = link.locator("..").locator("svg");
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
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
