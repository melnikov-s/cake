import { expect, type Locator, type Page } from "@playwright/test";
import type { VisualCaptureScenario } from "./scenarios";

/** Real mode switches and keyboard resizing, with no Store or CSS injection. */
export function createWorkspacePanelGeometryScenario(
  titleBarScenario: VisualCaptureScenario,
): VisualCaptureScenario {
  return {
    name: "workspace-panel-geometry",
    description:
      "Shared preferred width across Main/VS Code/Browser, Main clamp and tool restoration",
    states: ["preferred-main", "preferred-browser", "main-clamped", "restored-browser"],
    seed: (paths, theme) => titleBarScenario.seed(paths, theme),
    async prepare(page, state, application) {
      if (!application) throw new Error("Workspace panel geometry requires native Electron views");
      const nativeApplication = application;
      await titleBarScenario.prepare(page, "project", nativeApplication);
      const mainHandle = page.getByRole("separator", { name: "Resize Workspace", exact: true });
      const toolHandle = page.getByRole("separator", {
        name: "Resize current session sidebar",
        exact: true,
      });
      const mainPanel = page.getByRole("complementary", { name: "Workspace", exact: true });
      const companion = page.getByRole("complementary", {
        name: "Current conversation companion",
        exact: true,
      });
      const trace: { stage: string; panelWidth: number; mainChatWidth?: number }[] = [];
      const record = async (stage: string, panel: Locator, expected: number, main = false) => {
        await expect.poll(async () => (await panel.boundingBox())?.width).toBe(expected);
        await page.mouse.move(700, 600);
        const mainChatWidth = main
          ? await page
              .locator('[data-slot="workspace"]')
              .evaluate((node) => node.getBoundingClientRect().width)
          : undefined;
        trace.push({ stage, panelWidth: expected, mainChatWidth });
        console.log("WORKSPACE_PANEL_GEOMETRY", JSON.stringify(trace.at(-1)));
      };
      const resize = async (handle: Locator, target: number) => {
        await handle.focus();
        await page.keyboard.press("Home");
        for (let width = 240; width < target; width += 16) await page.keyboard.press("ArrowLeft");
        await handle.blur();
        await expect(handle).toHaveAttribute("aria-valuenow", String(target));
      };
      const switchTool = async (mode: "VS Code" | "Browser") => {
        await page.getByRole("button", { name: mode, exact: true }).click();
        if (mode === "VS Code") {
          await page.getByRole("region", { name: "VS Code workspace" }).waitFor();
          await expect
            .poll(
              () =>
                nativeApplication.evaluate(async ({ webContents }) => {
                  for (const contents of webContents.getAllWebContents()) {
                    if (!contents.getURL().startsWith("http://127.0.0.1:")) continue;
                    if (
                      await contents.executeJavaScript(
                        'Boolean(document.querySelector(".part.titlebar"))',
                      )
                    )
                      return true;
                  }
                  return false;
                }),
              { timeout: 30_000 },
            )
            .toBe(true);
          await page.waitForFunction(() => document.documentElement.dataset.titleBar === "vscode");
        } else await expect(page.getByRole("textbox", { name: "Browser address" })).toBeVisible();
      };

      // 800px exceeds the former 520px cap while still leaving readable Main chat.
      await resize(mainHandle, 800);
      await record("preferred-main", mainPanel, 800, true);
      if (state === "preferred-main") return;
      await switchTool("VS Code");
      await record("preferred-vscode", companion, 800);
      await switchTool("Browser");
      await record("preferred-browser", companion, 800);
      if (state === "preferred-browser") return;

      // A wider tool preference must survive Main's temporary reading-width clamp.
      await resize(toolHandle, 1200);
      await record("wide-browser", companion, 1200);
      await page.getByRole("button", { name: "Main", exact: true }).click();
      const availableWidth = await page
        .locator('[data-slot="shell-header"]')
        .evaluate((node) => node.getBoundingClientRect().width);
      const mainMaximum = Math.max(0, availableWidth - 360);
      expect(mainMaximum).toBeLessThan(1200);
      await record("main-clamped", mainPanel, mainMaximum, true);
      expect(trace.at(-1)!.mainChatWidth).toBe(360);
      if (state === "main-clamped") return;
      await switchTool("VS Code");
      await record("restored-vscode", companion, 1200);
      await switchTool("Browser");
      await record("restored-browser", companion, 1200);
      await page.mouse.move(700, 600);
    },
    region: (page: Page) => page.locator("body"),
  };
}
