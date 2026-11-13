import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { widgetAttachmentsScenario } from "../../scripts/visual-capture/scenarios";
import { emitRendererEvent } from "./main-harness";

const repository = resolve(import.meta.dirname, "../..");
for (const scenario of ["session", "project-chats", "mixed"] as const) {
  test(`artifact attachment respects destination scope (${scenario})`, async ({}, testInfo) => {
    test.setTimeout(90_000);
    const root = await mkdtemp(join(tmpdir(), "cake-artifact-attachment-scope-"));
    const paths = {
      project: join(root, "project"),
      cakeHome: join(root, "cake-home"),
      userData: join(root, "user-data"),
    };
    await widgetAttachmentsScenario.seed(paths, "light");
    const statePath = join(paths.cakeHome, "state", "application.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const outside = {
      id: "outside-placement",
      lineageId: "shared-dashboard",
      slot: "left",
      order: 0,
      hidden: true,
      target:
        scenario === "project-chats"
          ? { kind: "project-chats" }
          : { kind: "session", sessionId: "session-a" },
    };
    const compatible = {
      ...outside,
      id: "compatible-placement",
      slot: "bottom",
      order: 1,
      target: { kind: "session", sessionId: "visual-widget-attachments" },
    };
    state.data.widgetAttachments = scenario === "mixed" ? [outside, compatible] : [outside];
    const before = state.data.widgetAttachments;
    await writeFile(statePath, JSON.stringify(state));
    const attachments = async () =>
      JSON.parse(await readFile(statePath, "utf8")).data.widgetAttachments;
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
      await page
        .getByRole("combobox", { name: /^Message/ })
        .first()
        .waitFor();
      await emitRendererEvent(app, {
        type: "session-open-requested",
        sessionId: "visual-widget-attachments",
      });
      await page.getByRole("button", { name: "1 artifacts", exact: true }).click();
      await page
        .getByRole("navigation", { name: "Artifact list" })
        .getByRole("button", { name: /Shared dashboard/ })
        .click();
      const viewer = page.getByRole("complementary", { name: "Shared dashboard", exact: true });
      const frame = viewer.locator("iframe").contentFrame();
      await expect(frame.getByRole("button", { name: "Save count" })).toBeEnabled();
      await frame.getByRole("button", { name: "Save count" }).click();
      await expect(frame.getByText("Shared count: 1", { exact: true })).toBeVisible();
      const originalFrame = await viewer.locator("iframe").elementHandle();
      await viewer.getByRole("button", { name: "Attach Shared dashboard to", exact: true }).click();
      await page.getByRole("menuitem", { name: "Workspace tab", exact: true }).click();
      if (scenario !== "mixed") {
        await expect(viewer.getByRole("alert")).toContainText("Widget scope conflict");
        await expect(viewer.getByRole("alert")).toContainText("Nothing was changed");
        await expect(page.getByRole("status").filter({ hasText: "Attached to" })).toHaveCount(0);
        expect(await attachments()).toEqual(before);
        await expect(
          page.locator('[data-slot="widget-tab-host"] [data-widget-attachment]'),
        ).toHaveCount(0);
        await page.screenshot({
          scale: "css",
          path: testInfo.outputPath(`scope-conflict-${scenario}.png`),
        });
      } else {
        await expect(
          page.getByRole("status").filter({ hasText: "Attached to Workspace tab." }),
        ).toBeVisible();
        await expect(viewer.getByRole("alert")).toHaveCount(0);
        await expect
          .poll(async () =>
            (await attachments()).find((entry: { id: string }) => entry.id === compatible.id),
          )
          .toMatchObject({ ...compatible, slot: "tab", hidden: false });
        expect(
          (await attachments()).find((entry: { id: string }) => entry.id === outside.id),
        ).toEqual(outside);
        expect(await attachments()).toHaveLength(2);
        await page.screenshot({
          scale: "css",
          path: testInfo.outputPath("scope-success-mixed.png"),
        });
      }
      expect(await originalFrame!.evaluate((node) => node.isConnected)).toBe(true);
      await expect(frame.getByText("Shared count: 1", { exact: true })).toBeVisible();
      if (scenario === "mixed") {
        await page.keyboard.press("Escape");
        await viewer.getByRole("button", { name: "Close Shared dashboard", exact: true }).click();
        await page.getByRole("button", { name: "Widget tabs", exact: true }).click();
        await page.getByRole("menuitemradio", { name: "Shared dashboard", exact: true }).click();
        await expect(
          page
            .locator('[data-widget-attachment="compatible-placement"] iframe')
            .contentFrame()
            .getByText("Shared count: 1", { exact: true }),
        ).toBeVisible();
        expect(
          (await attachments()).find((entry: { id: string }) => entry.id === outside.id),
        ).toEqual(outside);
        await page.screenshot({
          scale: "css",
          path: testInfo.outputPath("scope-success-workspace.png"),
        });
      }
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
