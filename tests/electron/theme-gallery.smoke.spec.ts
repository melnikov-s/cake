import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const hostTheme of ["light", "dark"] as const) {
  test(`theme gallery keeps palettes independent, previews by keyboard, and saves only Apply (${hostTheme})`, async () => {
    test.setTimeout(90_000);
    const directory = await mkdtemp(join(tmpdir(), "cake-theme-gallery-"));
    const paths = {
      cakeHome: join(directory, "cake-home"),
      project: join(directory, "project"),
      userData: join(directory, "user-data"),
    };
    const scenario = findVisualCaptureScenario("theme-gallery")!;
    await scenario.seed(paths, hostTheme);
    const launch = () =>
      electron.launch({
        args: [repositoryRoot],
        cwd: repositoryRoot,
        env: {
          ...process.env,
          CAKE_ELECTRON_SMOKE: "1",
          CAKE_HOME: paths.cakeHome,
          CAKE_ELECTRON_USER_DATA: paths.userData,
          PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
          PI_CODING_AGENT_SESSION_DIR: "",
        },
      });
    let application = await launch();
    try {
      let page = await application.firstWindow();
      await application.evaluate(
        ({ BrowserWindow }, width) => {
          BrowserWindow.getAllWindows()[0]!.setContentSize(width, 1000);
        },
        hostTheme === "light" ? 720 : 1280,
      );
      await page.emulateMedia({ colorScheme: "light" });
      await scenario.prepare(page, hostTheme);
      const systemScene = page
        .getByRole("button", { name: "System theme", exact: true })
        .locator('[data-slot="theme-preview-scene"]');
      await expect(systemScene).toHaveAttribute("data-color-theme", "light");
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(systemScene).toHaveAttribute("data-color-theme", "dark");
      await expect(page.locator("html")).toHaveAttribute("data-theme", hostTheme);
      // Every miniature stays inside its card and the responsive settings grid.
      const geometry = await page
        .getByRole("group", { name: "Color theme", exact: true })
        .evaluate((group) => ({
          fits: group.scrollWidth <= group.clientWidth,
          cardsFit: [...group.querySelectorAll("button")].every(
            (card) => card.getBoundingClientRect().width <= group.getBoundingClientRect().width + 1,
          ),
        }));
      expect(geometry).toEqual({ fits: true, cardsFit: true });
      const paper = page.getByRole("button", { name: "Warm paper theme", exact: true });
      await paper.focus();
      await paper.press("Enter");
      await expect(paper).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("html")).toHaveCSS("--background", "#fff8e8");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", hostTheme);
      await paper.focus();
      await paper.press("Space");
      await page.getByRole("button", { name: "Apply theme", exact: true }).click();
      await page.getByRole("button", { name: "Dark theme", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      // Closing while browsing must retain Warm paper, not the uncommitted Dark preview.
      await application.close();
      const saved = JSON.parse(await readFile(join(paths.userData, "window-state.json"), "utf8"))
        .data.children.settingsStore.children.appearance.state;
      expect(
        saved.importedThemes.find((theme: { id: string }) => `imported:${theme.id}` === saved.theme)
          .name,
      ).toBe("Warm paper");
      expect(saved.importedThemes).toHaveLength(2);
      application = await launch();
      page = await application.firstWindow();
      await page
        .getByRole("button", { name: "Appearance", exact: true })
        .click({ timeout: 20_000 });
      await expect(
        page.getByRole("button", { name: "Warm paper theme", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("html")).toHaveCSS("--background", "#fff8e8");
    } finally {
      await application.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });
}
