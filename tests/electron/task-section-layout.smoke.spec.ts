import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repository = resolve(import.meta.dirname, "../..");
const longTitle =
  "Improve project navigation and preserve keyboard shortcuts for very-long-unbroken-workspace-identifiers-without-clipping-the-transcript";
const longStatus =
  "Checking navigation, keyboard shortcuts and workspace identifiers before review";

for (const theme of ["dark", "light"] as const)
  test(`task headings wrap above the message border at every pane width (${theme})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-task-layout-"));
    const paths = {
      cakeHome: join(root, "cake"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    const scenario = findVisualCaptureScenario("project-chat-task-rails")!;
    await scenario.seed(paths, theme);
    const file = join(paths.cakeHome, "state", "application.json");
    const application = JSON.parse(await readFile(file, "utf8"));
    const todo = application.data.projects[0].todos.items[1];
    todo.title = longTitle;
    todo.status = longStatus;
    await writeFile(file, JSON.stringify(application));
    const app = await electron.launch({
      args: [repository],
      cwd: repository,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_HOME: paths.cakeHome,
        CAKE_ELECTRON_USER_DATA: paths.userData,
        PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    try {
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.setContentSize(1800, 1100),
      );
      const page = await app.firstWindow();
      // Includes real geometry checks for the border gap at A → B → A.
      await scenario.prepare(page, "return");
      const transcript = page.locator(".transcript").last();
      const title = transcript.getByTitle(`Show in To-do: ${longTitle}`);
      const label = title.locator('xpath=ancestor::*[@data-slot="task-section-label"]');
      const row = title.locator('xpath=ancestor::*[@data-slot="transcript-item"]');
      // Resize in both directions without remounting; long headings and status
      // must stay above, never alongside, the message rule.
      for (const width of [1800, 900, 1500, 1560, 1800]) {
        await app.evaluate(
          ({ BrowserWindow }, width) =>
            BrowserWindow.getAllWindows()[0]?.setContentSize(width, 1100),
          width,
        );
        await title.scrollIntoViewIfNeeded();
        await expect(label.getByText(longStatus, { exact: true })).toBeVisible();
        await expect(async () => {
          const paneBounds = (await transcript.boundingBox())!;
          const labelBounds = (await label.boundingBox())!;
          const rowBounds = (await row.boundingBox())!;
          const railBounds = (await row.locator('[data-slot="margin-rail"]').boundingBox())!;
          const messageBounds = (await row.locator('[data-slot="message"]').boundingBox())!;
          expect(labelBounds.x).toBeGreaterThanOrEqual(paneBounds.x);
          expect(labelBounds.x + labelBounds.width).toBeLessThanOrEqual(
            paneBounds.x + paneBounds.width,
          );
          expect(labelBounds.y + labelBounds.height).toBeLessThanOrEqual(
            rowBounds.y + rowBounds.height,
          );
          expect(rowBounds.x - labelBounds.x).toBeLessThanOrEqual(96);
          if (width === 1800) expect(rowBounds.x - labelBounds.x).toBe(96);
          expect(labelBounds.x).toBeLessThanOrEqual(railBounds.x);
          expect(labelBounds.y - rowBounds.y).toBe(32);
          expect(railBounds.y).toBeGreaterThanOrEqual(labelBounds.y + labelBounds.height + 12);
          expect(railBounds.y).toBeLessThanOrEqual(messageBounds.y);
          expect(
            await transcript.evaluate((element) => element.scrollWidth <= element.clientWidth),
          ).toBe(true);
        }).toPass();
      }
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
        ),
      ).toBe(true);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
