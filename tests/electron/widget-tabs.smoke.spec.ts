import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { widgetTabsScenario } from "../../scripts/visual-capture/scenarios";
import { emitRendererEvent } from "./main-harness";
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-identity";

const repository = resolve(import.meta.dirname, "../..");

for (const theme of ["light", "dark"] as const) {
  test(`global widget tab selection, background activity and context persistence (${theme})`, async ({}, testInfo) => {
    test.setTimeout(120_000);
    const root = await mkdtemp(join(tmpdir(), "cake-widget-tabs-"));
    const paths = {
      project: join(root, "project"),
      cakeHome: join(root, "cake-home"),
      userData: join(root, "user-data"),
    };
    await widgetTabsScenario.seed(paths, theme);
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
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 1000),
      );
      await widgetTabsScenario.prepare(page, "default", app);
      const panel = page.locator('[data-widget-attachment="activity-tab"]');
      const frame = panel.locator("iframe").contentFrame();
      const element = await panel.locator("iframe").elementHandle();
      const viewId = await panel
        .locator("[data-widget-view-id]")
        .getAttribute("data-widget-view-id");
      await frame.getByRole("button", { name: "Save count" }).click();
      await frame.getByRole("button", { name: "Change local count" }).click();
      await expect(frame.getByText("Saved count: 1", { exact: true })).toBeVisible();
      await expect(frame.getByText("Local count: 1", { exact: true })).toBeVisible();
      await expect(
        frame.getByText("Current session: visual-widget-tabs", { exact: true }),
      ).toBeVisible();
      const pane = page.locator('[data-slot="widget-tab-viewport"]');
      const paneBounds = (await pane.boundingBox())!;
      const frameBounds = (await panel.locator("iframe").boundingBox())!;
      expect(frameBounds.width).toBeCloseTo(paneBounds.width, 0);
      expect(frameBounds.y + frameBounds.height).toBeLessThanOrEqual(
        paneBounds.y + paneBounds.height + 1,
      );
      await page.screenshot({ path: testInfo.outputPath(`widget-tab-selected-${theme}.png`) });
      await page
        .getByRole("button", { name: "Widget tabs: Activity monitor", exact: true })
        .click();
      const menu = page.getByRole("menu", { name: "Widget tabs", exact: true });
      await expect(menu.getByRole("menuitemradio")).toHaveText([
        "Activity monitor",
        "A second monitor with a long title for overflow inspection",
      ]);
      await expect(
        menu.getByRole("menuitemradio", { name: "Activity monitor", exact: true }),
      ).toHaveAttribute("aria-checked", "true");
      await page.screenshot({ path: testInfo.outputPath(`widget-tab-menu-${theme}.png`) });
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await expect(page.locator('[data-widget-attachment="second-tab"]')).toBeVisible();
      await expect(panel).not.toBeVisible();
      const updates = async () =>
        Number((await frame.locator("output").textContent())!.split(": ")[1]);
      const before = await updates();
      await expect.poll(updates).toBeGreaterThan(before);
      const workspace = page.getByRole("complementary", { name: "Workspace", exact: true });
      await workspace.getByRole("button", { name: /To-dos/ }).click();
      await expect(page.getByRole("searchbox", { name: "Search to-dos" })).toBeVisible();
      await expect(panel).not.toBeVisible();
      await workspace.getByRole("button", { name: /^Sessions ·/ }).click();
      await expect(page.getByRole("button", { name: "Widget tabs", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Widget tabs", exact: true }).click();
      await page.getByRole("menuitemradio", { name: "Activity monitor", exact: true }).click();
      await page
        .getByRole("button", { name: "Open Project Chat for Widget workspace", exact: true })
        .click();
      await expect(frame.getByText(/^Current session: project-chat:/)).toBeVisible();
      await expect(frame.getByText("Local count: 1", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Close Workspace", exact: true }).click();
      await expect(panel).not.toBeVisible();
      const closedUpdates = await updates();
      await expect.poll(updates).toBeGreaterThan(closedUpdates);
      await page.getByRole("button", { name: "Open Workspace", exact: true }).click();
      await expect(frame.getByText("Local count: 1", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Browser", exact: true }).click();
      await expect(page.getByRole("region", { name: "Browser workspace" })).toBeVisible();
      await page.getByRole("button", { name: "Widget tabs", exact: true }).click();
      await page.getByRole("menuitemradio", { name: "Activity monitor", exact: true }).click();
      await expect(frame.getByText("Local count: 1", { exact: true })).toBeVisible();
      await expect(frame.getByText("Saved count: 1", { exact: true })).toBeVisible();
      const companionViewport = (await pane.boundingBox())!;
      const companionFrame = (await panel.locator("iframe").boundingBox())!;
      expect(companionFrame.width).toBeCloseTo(companionViewport.width, 0);
      expect(companionFrame.x).toBeCloseTo(companionViewport.x, 0);
      await page.getByRole("button", { name: "Main", exact: true }).click();
      await expect(frame.getByText("Local count: 1", { exact: true })).toBeVisible();
      const firstProjectSession = await frame.getByText(/^Current session:/).textContent();
      await page
        .getByRole("button", { name: "Open Project Chat for Other widget workspace", exact: true })
        .click();
      await expect(frame.getByText(/^Current session: project-chat:/)).toBeVisible();
      await expect
        .poll(() => frame.getByText(/^Current session:/).textContent())
        .not.toBe(firstProjectSession);
      await expect(frame.getByText("Saved count: 1", { exact: true })).toBeVisible();
      await expect(frame.getByText("Local count: 1", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Open Cake Chat", exact: true }).click();
      await expect(
        frame.getByText(`Current session: ${CAKE_CHAT_SESSION_ID}`, { exact: true }),
      ).toBeVisible();
      await expect(frame.getByText("Local count: 1", { exact: true })).toBeVisible();
      await emitRendererEvent(app, {
        type: "session-open-requested",
        sessionId: "visual-widget-tabs",
      });
      await expect(
        frame.getByText("Current session: visual-widget-tabs", { exact: true }),
      ).toBeVisible();
      await expect(frame.getByText("Saved count: 1", { exact: true })).toBeVisible();
      expect(await panel.locator("[data-widget-view-id]").getAttribute("data-widget-view-id")).toBe(
        viewId,
      );
      expect(await element!.evaluate((node) => node.isConnected)).toBe(true);
      await expect(page.locator('[data-slot="widget-tab-host"] iframe')).toHaveCount(2);
      // Removing the selected tab returns to the last built-in view, not another widget.
      await panel
        .getByRole("button", { name: "Widget options for Activity monitor", exact: true })
        .click();
      await page.getByRole("button", { name: "Detach Activity monitor", exact: true }).click();
      await expect(panel).toHaveCount(0);
      await expect(workspace.getByRole("button", { name: /^Sessions ·/ })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await page.getByRole("button", { name: "Widget tabs", exact: true }).click();
      await page.getByRole("menuitemradio").click();
      const secondTitle = "A second monitor with a long title for overflow inspection";
      await page
        .locator('[data-widget-attachment="second-tab"]')
        .getByRole("button", { name: `Widget options for ${secondTitle}`, exact: true })
        .click();
      await page.getByRole("button", { name: `Detach ${secondTitle}`, exact: true }).click();
      await expect(page.getByRole("button", { name: /^Widget tabs/ })).toHaveCount(0);
      await expect(page.locator('[data-slot="widget-tab-host"] iframe')).toHaveCount(0);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
