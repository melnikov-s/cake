import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { widgetAttachmentsScenario } from "../../scripts/visual-capture/scenarios";
import { emitRendererEvent } from "./main-harness";

const repository = resolve(import.meta.dirname, "../..");

async function beginDrag(page: Page, header: Locator) {
  const rect = (await header.boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + 8, rect.y + rect.height / 2 + 8);
  await expect(page.locator("[data-widget-placement-overlay]")).toBeVisible();
}
async function drop(page: Page, slot: string) {
  const rect = (await page.locator(`[data-widget-drop-target="${slot}"]`).boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("[data-widget-placement-overlay]")).toHaveCount(0);
}

for (const scope of ["global", "session", "project-sessions"] as const) {
  for (const theme of scope === "global" ? (["light", "dark"] as const) : (["light"] as const)) {
    test(`header drag, unrestricted resize and scope-safe Workspace drop (${scope}, ${theme})`, async ({}, testInfo) => {
      test.setTimeout(120_000);
      const root = await mkdtemp(join(tmpdir(), "cake-widget-placement-"));
      const paths = {
        project: join(root, "project"),
        cakeHome: join(root, "cake-home"),
        userData: join(root, "user-data"),
      };
      await widgetAttachmentsScenario.seed(paths, theme);
      const statePath = join(paths.cakeHome, "state", "application.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      state.data.widgetAttachments = [
        {
          ...state.data.widgetAttachments.find(
            (entry: { id: string }) => entry.id === "dashboard-left",
          ),
          target:
            scope === "global"
              ? { kind: "global" }
              : scope === "session"
                ? { kind: "session", sessionId: "visual-widget-attachments" }
                : { kind: scope },
        },
      ];
      await writeFile(statePath, JSON.stringify(state));
      const savedAttachment = async () =>
        JSON.parse(await readFile(statePath, "utf8")).data.widgetAttachments.find(
          (entry: { id: string }) => entry.id === "dashboard-left",
        );
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
          BrowserWindow.getAllWindows()[0]!.setContentSize(1600, 1100),
        );
        await page
          .getByRole("combobox", { name: /^Message/ })
          .first()
          .waitFor();
        await emitRendererEvent(app, {
          type: "session-open-requested",
          sessionId: "visual-widget-attachments",
        });
        const panel = page.locator('[data-widget-attachment="dashboard-left"]');
        const header = panel.getByRole("button", { name: "Move Shared dashboard", exact: true });
        const options = panel.getByRole("button", {
          name: "Widget options for Shared dashboard",
          exact: true,
        });
        await expect(
          panel.locator("iframe").contentFrame().getByRole("button", { name: "Save count" }),
        ).toBeEnabled();
        await panel
          .locator("iframe")
          .contentFrame()
          .getByRole("button", { name: "Save count" })
          .click();
        await expect(
          panel.locator("iframe").contentFrame().getByText("Shared count: 1"),
        ).toBeVisible();
        const original = await savedAttachment();
        await options.click();
        const menu = page.getByLabel("Options for Shared dashboard", { exact: true });
        await expect(menu.getByRole("button")).toHaveText(["Hide", "Close"]);
        await expect(menu.getByRole("button", { name: "Close Shared dashboard" })).toHaveClass(
          /text-destructive/,
        );
        await page.screenshot({
          path: testInfo.outputPath(`widget-options-${scope}-${theme}.png`),
        });
        await page.keyboard.press("Escape");
        await expect(page.locator("[data-widget-placement-overlay]")).toHaveCount(0);

        await beginDrag(page, header);
        await page.screenshot({
          path: testInfo.outputPath(`widget-destinations-${scope}-${theme}.png`),
        });
        await page.keyboard.press("Escape");
        await page.mouse.up();
        expect(await savedAttachment()).toEqual(original);
        await beginDrag(page, header);
        await page.evaluate(() => window.dispatchEvent(new Event("blur")));
        await expect(page.locator("[data-widget-placement-overlay]")).toHaveCount(0);
        await page.mouse.up();
        expect(await savedAttachment()).toEqual(original);
        // Neither the gear nor iframe contents can start widget placement.
        const gearBounds = (await options.boundingBox())!;
        await page.mouse.move(
          gearBounds.x + gearBounds.width / 2,
          gearBounds.y + gearBounds.height / 2,
        );
        await page.mouse.down();
        await page.mouse.move(gearBounds.x - 60, gearBounds.y + 60, { steps: 4 });
        await page.mouse.up();
        await expect(page.locator("[data-widget-placement-overlay]")).toHaveCount(0);
        const contentBounds = (await panel.locator("iframe").boundingBox())!;
        await page.mouse.move(contentBounds.x + 20, contentBounds.y + 20);
        await page.mouse.down();
        await page.mouse.move(contentBounds.x + 120, contentBounds.y + 60, { steps: 4 });
        await page.mouse.up();
        await expect(page.locator("[data-widget-placement-overlay]")).toHaveCount(0);
        expect(await savedAttachment()).toEqual(original);
        await beginDrag(page, header);
        const chat = (await page.locator("[data-widget-chat]").boundingBox())!;
        await page.mouse.move(chat.x + chat.width / 2, chat.y + chat.height / 2, { steps: 8 });
        await page.mouse.up();
        expect(await savedAttachment()).toEqual(original);

        if (scope !== "global") {
          await beginDrag(page, header);
          await drop(page, "tab");
          await expect(
            page.getByRole("alert").filter({ hasText: "Workspace requires a global widget" }),
          ).toBeVisible();
          expect(await savedAttachment()).toEqual(original);
          await expect(
            panel.locator("iframe").contentFrame().getByText("Shared count: 1"),
          ).toBeVisible();
          return;
        }

        for (const slot of ["top", "bottom", "right", "left"] as const) {
          await expect(page.locator(`[data-widget-slot="${slot}"]`)).toHaveCount(
            slot === "left" && (await savedAttachment()).slot === "left" ? 1 : 0,
          );
          await beginDrag(page, header);
          await drop(page, slot);
          await expect(
            page.locator(`[data-widget-slot="${slot}"] [data-widget-attachment="dashboard-left"]`),
          ).toBeVisible();
          await expect.poll(async () => (await savedAttachment()).slot).toBe(slot);
          expect(await savedAttachment()).toMatchObject({
            id: original.id,
            lineageId: original.lineageId,
            target: original.target,
          });
          await expect(
            panel.locator("iframe").contentFrame().getByText("Shared count: 1"),
          ).toBeVisible();
          const separator = page.getByRole("separator", {
            name: `Resize ${slot} widgets`,
            exact: true,
          });
          const max = Number(await separator.getAttribute("aria-valuemax"));
          const before = Number(await separator.getAttribute("aria-valuenow"));
          const desired = Math.min(700, max - 30);
          expect(desired).toBeGreaterThan(slot === "left" || slot === "right" ? 520 : 400);
          const rect = (await separator.boundingBox())!;
          const x = rect.x + rect.width / 2;
          const y = rect.y + rect.height / 2;
          const delta = (desired - before) * (slot === "left" || slot === "top" ? 1 : -1);
          await page.mouse.move(x, y);
          await page.mouse.down();
          await expect(page.locator("[data-widget-resize-overlay]")).toBeVisible();
          await page.mouse.move(
            x + (slot === "left" || slot === "right" ? delta : 0),
            y + (slot === "top" || slot === "bottom" ? delta : 0),
            { steps: 12 },
          );
          await page.mouse.up();
          await expect(page.locator("[data-widget-resize-overlay]")).toHaveCount(0);
          await expect
            .poll(async () => Number(await separator.getAttribute("aria-valuenow")))
            .toBeGreaterThan(desired - 3);
          await page.screenshot({
            path: testInfo.outputPath(`widget-resized-${slot}-${theme}.png`),
          });
          await testInfo.attach(`resize-${slot}`, {
            body: JSON.stringify({
              slot,
              available: max,
              requested: desired,
              actual: await page.locator(`[data-widget-slot="${slot}"]`).boundingBox(),
            }),
            contentType: "application/json",
          });
          await separator.focus();
          await page.keyboard.press("Home");
          await expect(separator).toHaveAttribute("aria-valuenow", "0");
          await page.keyboard.press("End");
          await expect(separator).toHaveAttribute("aria-valuenow", String(Math.round(max)));
          // Restore a useful size without retaining the old arbitrary minimum/cap.
          for (let index = 0; index < Math.ceil((max - 240) / 48); index++)
            await page.keyboard.press(
              slot === "left"
                ? "Shift+ArrowLeft"
                : slot === "right"
                  ? "Shift+ArrowRight"
                  : slot === "top"
                    ? "Shift+ArrowUp"
                    : "Shift+ArrowDown",
            );
        }

        await beginDrag(page, header);
        await drop(page, "tab");
        await expect.poll(async () => (await savedAttachment()).slot).toBe("tab");
        await expect(
          page.getByRole("button", { name: "Widget tab: Shared dashboard", exact: true }),
        ).toHaveAttribute("aria-pressed", "true");
        await expect(panel).toBeVisible();
        const iframe = await panel.locator("iframe").elementHandle();
        const workspace = page.getByRole("complementary", { name: "Workspace", exact: true });
        await workspace.getByRole("button", { name: /To-dos/ }).click();
        await expect(page.getByRole("searchbox", { name: "Search to-dos" })).toBeVisible();
        await page
          .getByRole("button", { name: "Widget tab: Shared dashboard", exact: true })
          .click();
        expect(await iframe!.evaluate((element) => element.isConnected)).toBe(true);
        await options.click();
        await page.getByRole("button", { name: "Hide", exact: true }).click();
        await expect(panel.locator("iframe")).toHaveCount(0);
        await page.getByRole("button", { name: "Show", exact: true }).click();
        await page.keyboard.press("Escape");
        await expect(
          panel.locator("iframe").contentFrame().getByText("Shared count: 1"),
        ).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`widget-workspace-${theme}.png`) });
        await options.click();
        await page.getByRole("button", { name: "Close Shared dashboard", exact: true }).click();
        await expect(panel).toHaveCount(0);
        await expect.poll(savedAttachment).toBeUndefined();
        // Source and saved state stay on disk after detaching; existing workflow tests verify reopening.
        const artifactState = await readFile(
          join(paths.cakeHome, "state", "application.json"),
          "utf8",
        );
        expect(artifactState).not.toContain('"dashboard-left"');
      } finally {
        await app.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
