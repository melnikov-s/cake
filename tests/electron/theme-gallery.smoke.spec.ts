import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const hostTheme of ["light", "dark"] as const) {
  test(`theme favorites follow the OS, preview by keyboard, and save only Apply (${hostTheme})`, async () => {
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
        hostTheme === "light" ? 760 : 1280,
      );
      await page.emulateMedia({ colorScheme: hostTheme });
      await scenario.prepare(page, hostTheme);
      // Every miniature stays inside its card and the responsive settings grid.
      const geometry = await page
        .getByRole("group", {
          name: `${hostTheme === "light" ? "Light" : "Dark"} themes`,
          exact: true,
        })
        .evaluate((group) => ({
          fits: group.scrollWidth <= group.clientWidth,
          cardsFit: [...group.querySelectorAll("button")].every(
            (card) => card.getBoundingClientRect().width <= group.getBoundingClientRect().width + 1,
          ),
        }));
      expect(geometry).toEqual({ fits: true, cardsFit: true });
      await page.getByRole("button", { name: "Light", exact: true }).click();
      const paper = page.getByRole("button", { name: "Warm paper theme", exact: true });
      await paper.focus();
      await paper.press("Enter");
      await expect(paper).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("html")).toHaveCSS("--background", "#fff8e8");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await paper.focus();
      await paper.press("Space");
      await page.getByRole("button", { name: "Apply theme", exact: true }).click();
      await page.getByRole("button", { name: "Dark", exact: true }).click();
      await page.getByRole("button", { name: "Warm Titanium theme", exact: true }).click();
      await expect(page.locator("html")).toHaveCSS("--background", "#242321");
      await page.getByRole("button", { name: "Apply theme", exact: true }).click();
      await page.getByRole("button", { name: "Follow System", exact: true }).click();
      for (const mode of ["light", "dark", "light"] as const) {
        await page.emulateMedia({ colorScheme: mode });
        await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
        await expect(page.locator("html")).toHaveCSS(
          "--background",
          mode === "light" ? "#fff8e8" : "#242321",
        );
      }
      // OS changes must not override a forced mode; browsing its other favorite does not save.
      await page.getByRole("button", { name: "Light", exact: true }).click();
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveCSS("--background", "#fff8e8");
      await page.getByRole("button", { name: "Dark theme", exact: true }).click();
      await page.getByRole("button", { name: "Nord theme", exact: true }).click();
      await expect(page.locator("html")).toHaveCSS("--background", "#2e3440");
      await application.close();
      const saved = JSON.parse(await readFile(join(paths.userData, "window-state.json"), "utf8"))
        .data.children.settingsStore.children.appearance.state;
      expect(saved.theme).toBe("light");
      expect(saved.darkTheme).toBe("bundled:warm-titanium");
      expect(
        saved.importedThemes.find(
          (theme: { id: string }) => `imported:${theme.id}` === saved.lightTheme,
        ).name,
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
      await page.getByRole("button", { name: "Dark", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Warm Titanium theme", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("html")).toHaveCSS("--background", "#242321");
    } finally {
      await application.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });
}
