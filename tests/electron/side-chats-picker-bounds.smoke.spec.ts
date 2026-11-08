import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

async function expectContained(popup: Locator, pane: Locator) {
  await expect(async () => {
    const surface = (await popup.boundingBox())!;
    const bounds = (await pane.boundingBox())!;
    expect(surface.x).toBeGreaterThanOrEqual(bounds.x + 8);
    expect(surface.x + surface.width).toBeLessThanOrEqual(bounds.x + bounds.width - 8);
    expect(surface.y).toBeGreaterThanOrEqual(bounds.y + 8);
    expect(surface.y + surface.height).toBeLessThanOrEqual(bounds.y + bounds.height - 8);
    const label = popup.getByText("Quick greeting", { exact: true });
    const text = (await label.boundingBox())!;
    expect(text.x).toBeGreaterThan(surface.x);
    expect(text.x + text.width).toBeLessThan(surface.x + surface.width);
    expect(await label.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  }).toPass();
}

for (const theme of ["dark", "light"] as const) {
  test(`side chat picker stays inside Cake beside VS Code after split and window resizing (${theme})`, async () => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(join(tmpdir(), "cake-picker-bounds-"));
    const paths = {
      cakeHome: join(directory, "cake-home"),
      project: join(directory, "project"),
      userData: join(directory, "user-data"),
    };
    const scenario = findVisualCaptureScenario("side-chat-actions")!;
    await scenario.seed(paths, theme);
    const application = await electron.launch({
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
      const page = await application.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const resizeWindow = (width: number, height: number) =>
        application.evaluate(
          ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(...size),
          [width, height] as [number, number],
        );
      await resizeWindow(1024, 768);
      await page.getByRole("button", { name: "Open Cake Chat", exact: true }).click();
      const trigger = page.getByRole("button", { name: "Side chats, 1 open", exact: true });
      const popup = page.getByRole("dialog", { name: "Open side chats", exact: true });
      const entry = popup.getByRole("button", { name: "Quick greeting", exact: true });
      await trigger.click();
      await expect(entry).toBeFocused();
      expect((await popup.boundingBox())!.width).toBe(352);
      await page.keyboard.press("Escape");
      await expect(popup).toHaveCount(0);
      await expect(trigger).toBeFocused();

      const pane = page.getByRole("complementary", { name: "Current conversation companion" });
      const divider = page.getByRole("separator", { name: "Resize current session sidebar" });
      for (const mode of ["Browser", "VS Code"] as const) {
        await page.getByRole("button", { name: mode, exact: true }).click();
        await expect(page.getByRole("region", { name: `${mode} workspace` })).toBeVisible();
        await divider.press("Home");
        await trigger.click();
        await expect(entry).toBeFocused();
        await expectContained(popup, pane);
        expect((await popup.boundingBox())!.width).toBe(304);
        // Keyboard split resizing leaves the popup open and its toolbar anchor unchanged.
        await divider.press("End");
        await expectContained(popup, pane);
        expect((await popup.boundingBox())!.width).toBe(352);
        await divider.press("Home");
        await expectContained(popup, pane);
        if (mode === "VS Code") {
          await resizeWindow(900, 600);
          await expectContained(popup, pane);
          await mkdir(join(repositoryRoot, ".visual-captures"), { recursive: true });
          await page.screenshot({
            path: join(repositoryRoot, ".visual-captures", `side-chat-picker-bounds-${theme}.png`),
          });
        }
        await page.keyboard.press("Escape");
        await expect(popup).toHaveCount(0);
        await expect(trigger).toBeFocused();
        await trigger.click();
        await pane.getByRole("button", { name: "Chat", exact: true }).click();
        await expect(popup).toHaveCount(0);
      }
      // Selection remains reachable by keyboard without changing the side-chat transcript layout.
      await trigger.click();
      await expect(entry).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(popup).toHaveCount(0);
      await expect(
        page.getByRole("complementary", { name: "Quick greeting", exact: true }),
      ).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await application.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
