import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const hostTheme of ["light", "dark"] as const) {
  test(`theme slots save immediately by keyboard, follow the OS, and persist (${hostTheme})`, async () => {
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
      await page.getByRole("button", { name: "Cake Light theme", exact: true }).click();
      await paper.focus();
      await paper.press("Space");
      await expect(page.locator("html")).toHaveCSS("--background", "#fff8e8");
      // The new built-ins use the same picker, live DOM projection and keyboard path.
      await page.getByRole("button", { name: "Letterpress theme", exact: true }).click();
      await expect(page.locator("html")).toHaveCSS("--background", "#eee5d3");
      await paper.click();
      await page.getByRole("button", { name: "Dark", exact: true }).click();
      for (const [name, background] of [
        ["Hearth", "#302a27"],
        ["Moss", "#28322c"],
        ["Tidal", "#24343e"],
        ["Mulberry", "#362c3a"],
        ["Fogbank", "#383d46"],
        ["Dune", "#37362b"],
      ] as const) {
        const card = page.getByRole("button", { name: `${name} theme`, exact: true });
        await card.focus();
        await card.press("Enter");
        await expect(card).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator("html")).toHaveCSS("--background", background);
      }
      await page.getByRole("button", { name: "Warm Titanium theme", exact: true }).click();
      await expect(page.locator("html")).toHaveCSS("--background", "#242321");
      await page.getByRole("button", { name: "System", exact: true }).click();
      for (const mode of ["light", "dark", "light"] as const) {
        await page.emulateMedia({ colorScheme: mode });
        await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
        await expect(page.locator("html")).toHaveCSS(
          "--background",
          mode === "light" ? "#fff8e8" : "#242321",
        );
      }
      // Save each inactive slot in System without changing the effective appearance.
      for (const mode of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: mode });
        const inactive = mode === "light" ? "Dark" : "Light";
        const gallery = page.getByRole("button", { name: `${inactive} theme`, exact: true });
        if ((await gallery.getAttribute("aria-expanded")) === "false") await gallery.click();
        await page.getByRole("button", { name: `Cake ${inactive} theme`, exact: true }).click();
        await expect(page.getByRole("status")).toHaveText(
          `This theme will apply when ${inactive} mode is active.`,
        );
        await expect(page.getByRole("button", { name: "System", exact: true })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        await expect(page.locator("html")).toHaveCSS(
          "--background",
          mode === "light" ? "#fff8e8" : "#242321",
        );
        await page
          .getByRole("button", {
            name: mode === "light" ? "Warm Titanium theme" : "Warm paper theme",
            exact: true,
          })
          .click();
      }
      // OS changes and inactive selections must not override a forced mode.
      await page.getByRole("button", { name: "Light", exact: true }).click();
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveCSS("--background", "#fff8e8");
      await page.getByRole("button", { name: "Dark theme", exact: true }).click();
      await page.getByRole("button", { name: "Fogbank theme", exact: true }).click();
      await expect(page.locator("html")).toHaveCSS("--background", "#fff8e8");
      await expect(page.getByRole("status")).toHaveText(
        "This theme will apply when Dark mode is active.",
      );
      await expect(
        page.getByRole("button", { name: "Fogbank theme", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await application.close();
      const saved = JSON.parse(await readFile(join(paths.userData, "window-state.json"), "utf8"))
        .data.children.settingsStore.children.appearance.state;
      expect(saved.theme).toBe("light");
      expect(saved.darkTheme).toBe("bundled:fogbank");
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
        page.getByRole("button", { name: "Fogbank theme", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator("html")).toHaveCSS("--background", "#383d46");
    } finally {
      await application.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });
}
