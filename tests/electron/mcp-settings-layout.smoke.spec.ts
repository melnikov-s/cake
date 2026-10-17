import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const theme of ["dark", "light"] as const) {
  test(`MCP settings keep long server text and all six actions readable without overflow (${theme})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-mcp-layout-"));
    const paths = {
      cakeHome: join(root, "cake-home"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    const scenario = findVisualCaptureScenario("mcp-settings-layout")!;
    await scenario.seed(paths, theme);
    const configPath = join(paths.cakeHome, "pi", "mcp.json");
    const originalConfig = await readFile(configPath, "utf8");
    const application = await electron.launch({
      args: ["--force-device-scale-factor=1", repositoryRoot],
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
      const page = await application.firstWindow();
      await scenario.prepare(page, "default", application);
      const section = page.getByRole("region", { name: "MCP configuration", exact: true });
      const rows = section.getByRole("group", { name: /^MCP server / });
      await expect(rows).toHaveCount(2);
      // Screenshot-like content width, then progressively narrower settings panes.
      for (const width of [1360, 900, 760]) {
        await application.evaluate(({ BrowserWindow }, width) => {
          BrowserWindow.getAllWindows()[0]!.setContentSize(width, 900);
        }, width);
        await page.waitForFunction((width) => innerWidth === width, width);
        await expect(section).toBeVisible();
        const geometry = await rows.evaluateAll((elements) =>
          elements.map((row) => {
            const text = row.firstElementChild!;
            const actions = row.lastElementChild!;
            const bounds = row.getBoundingClientRect();
            const textBounds = text.getBoundingClientRect();
            const actionBounds = actions.getBoundingClientRect();
            const buttons = [...actions.querySelectorAll("button")];
            return {
              textUsesRowWidth: textBounds.width >= bounds.width - 32,
              actionsBelowText: actionBounds.top >= textBounds.bottom + 8,
              noOverflow: row.scrollWidth <= row.clientWidth,
              buttonsContained: buttons.every((button) => {
                const box = button.getBoundingClientRect();
                return (
                  box.left >= bounds.left &&
                  box.right <= bounds.right &&
                  box.top >= actionBounds.top &&
                  box.bottom <= actionBounds.bottom &&
                  button.scrollWidth <= button.clientWidth
                );
              }),
              buttonsDoNotOverlap: buttons.every((button, index) => {
                const box = button.getBoundingClientRect();
                return buttons.slice(index + 1).every((other) => {
                  const next = other.getBoundingClientRect();
                  return (
                    box.right <= next.left ||
                    next.right <= box.left ||
                    box.bottom <= next.top ||
                    next.bottom <= box.top
                  );
                });
              }),
              count: buttons.length,
              enabled: buttons.map((button) => !button.disabled),
            };
          }),
        );
        for (const row of geometry) {
          expect(row).toEqual({
            textUsesRowWidth: true,
            actionsBelowText: true,
            noOverflow: true,
            buttonsContained: true,
            buttonsDoNotOverlap: true,
            count: 6,
            enabled: [true, true, true, false, false, false],
          });
        }
        expect(
          await section.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        expect(
          await page
            .locator("#settings-content-scroll")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
      }
      expect(await readFile(configPath, "utf8")).toBe(originalConfig);
    } finally {
      await application.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
