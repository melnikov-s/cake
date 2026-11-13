import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { widgetAttachmentsScenario } from "../../scripts/visual-capture/scenarios";

const repository = resolve(import.meta.dirname, "../..");

for (const theme of ["light", "dark"] as const)
  test(`artifact header attaches the existing saved widget to Workspace and back to chat (${theme})`, async ({}, testInfo) => {
    test.setTimeout(120_000);
    const root = await mkdtemp(join(tmpdir(), "cake-artifact-attachment-menu-"));
    const paths = {
      project: join(root, "project"),
      cakeHome: join(root, "cake-home"),
      userData: join(root, "user-data"),
    };
    await widgetAttachmentsScenario.seed(paths, theme);
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
        BrowserWindow.getAllWindows()[0]!.setContentSize(1600, 1000),
      );
      await widgetAttachmentsScenario.prepare(page, "default", app);
      await page
        .locator('[data-widget-attachment="dashboard-left"] iframe')
        .contentFrame()
        .getByRole("button", { name: "Save count" })
        .click();
      await page.getByRole("button", { name: "1 artifacts", exact: true }).click();
      await page
        .getByRole("navigation", { name: "Artifact list" })
        .getByRole("button", { name: /Shared dashboard/ })
        .click();
      const viewer = page.getByRole("complementary", { name: "Shared dashboard", exact: true });
      const frame = viewer.locator("iframe").contentFrame();
      await expect(frame.getByText("Shared count: 1", { exact: true })).toBeVisible();
      const originalFrame = await viewer.locator("iframe").elementHandle();
      await viewer.getByRole("button", { name: "Attach Shared dashboard to", exact: true }).click();
      await expect(page.getByRole("menuitem")).toHaveText([
        "Top",
        "Bottom",
        "Left",
        "Right",
        "Workspace tab",
      ]);
      await page.screenshot({
        scale: "css",
        path: testInfo.outputPath(`artifact-attach-side-panel-${theme}.png`),
      });
      await page.keyboard.press("Escape");
      await viewer.getByRole("button", { name: "View Shared dashboard fullscreen" }).click();
      const fullscreen = page.getByRole("dialog", { name: "Shared dashboard", exact: true });
      await fullscreen
        .getByRole("button", { name: "Attach Shared dashboard to", exact: true })
        .click();
      await fullscreen.evaluate(async (element) => {
        await Promise.all(
          element.getAnimations({ subtree: true }).map((animation) => animation.finished),
        );
      });
      await page.screenshot({
        scale: "css",
        path: testInfo.outputPath(`artifact-attach-fullscreen-${theme}.png`),
      });
      await page.getByRole("menuitem", { name: "Workspace tab", exact: true }).click();
      await expect(
        page.getByRole("status").filter({ hasText: "Attached to Workspace tab." }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(fullscreen).toBeVisible();
      await fullscreen
        .getByRole("button", { name: "Exit fullscreen Shared dashboard", exact: true })
        .click();
      expect(await originalFrame!.evaluate((node) => node.isConnected)).toBe(true);
      await expect(frame.getByText("Shared count: 1", { exact: true })).toBeVisible();
      await viewer.getByRole("button", { name: "Close Shared dashboard", exact: true }).click();
      await page.getByRole("button", { name: "Widget tabs", exact: true }).click();
      await page.getByRole("menuitemradio", { name: "Shared dashboard", exact: true }).click();
      const tab = page.locator(
        '[data-slot="widget-tab-host"] [data-widget-attachment="dashboard-top"]',
      );
      await expect(
        tab.locator("iframe").contentFrame().getByText("Shared count: 1", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        scale: "css",
        path: testInfo.outputPath(`artifact-attached-workspace-${theme}.png`),
      });
      const application = () =>
        readFile(join(paths.cakeHome, "state", "application.json"), "utf8").then(JSON.parse);
      await expect
        .poll(async () =>
          (await application()).data.widgetAttachments.find(
            (entry: { id: string }) => entry.id === "dashboard-top",
          ),
        )
        .toMatchObject({
          id: "dashboard-top",
          lineageId: "shared-dashboard",
          slot: "tab",
          target: { kind: "global" },
        });
      // Reopen the same artifact and move the existing tab ID into this chat.
      await page.getByRole("button", { name: "1 artifacts", exact: true }).click();
      await page
        .getByRole("navigation", { name: "Artifact list" })
        .getByRole("button", { name: /Shared dashboard/ })
        .click();
      await viewer.getByRole("button", { name: "Attach Shared dashboard to", exact: true }).click();
      await page.getByRole("menuitem", { name: "Bottom", exact: true }).click();
      await expect
        .poll(async () =>
          (await application()).data.widgetAttachments.find(
            (entry: { id: string }) => entry.id === "dashboard-top",
          ),
        )
        .toMatchObject({
          id: "dashboard-top",
          lineageId: "shared-dashboard",
          slot: "bottom",
          target: { kind: "global" },
        });
      await page.keyboard.press("Escape");
      await viewer.getByRole("button", { name: "Close Shared dashboard", exact: true }).click();
      await expect(
        page
          .locator('[data-widget-slot="bottom"] [data-widget-attachment="dashboard-top"] iframe')
          .contentFrame()
          .getByText("Shared count: 1", { exact: true }),
      ).toBeVisible();
      expect((await application()).data.widgetAttachments).toHaveLength(4);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
