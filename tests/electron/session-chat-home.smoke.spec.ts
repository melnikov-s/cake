import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";
import { showSessions } from "./fixtures/workspace-navigation";

const repository = resolve(import.meta.dirname, "../..");

for (const theme of ["light", "dark"] as const) {
  test(`session home button returns directly home with keyboard access and stable layout (${theme})`, async () => {
    test.setTimeout(90_000);
    const temporary = await mkdtemp(join(tmpdir(), "cake-session-home-"));
    const cakeHome = join(temporary, "cake-home");
    const project = join(temporary, "project");
    const userData = join(temporary, "user-data");
    const sessionId = "session-home-fixture";
    const timestamp = new Date(0).toISOString();
    const sessionDirectory = cakeWorkspaceSessionDirectory(
      project,
      join(cakeHome, "pi", "sessions"),
    );
    await Promise.all([
      mkdir(project, { recursive: true }),
      mkdir(userData, { recursive: true }),
      mkdir(join(cakeHome, "state"), { recursive: true }),
      mkdir(sessionDirectory, { recursive: true }),
    ]);
    await writeFile(
      join(userData, "window-state.json"),
      windowState({ project, sessionId, theme }),
    );
    await writeFile(
      join(cakeHome, "state", "application.json"),
      JSON.stringify({
        version: 7,
        data: {
          ...defaultApplicationState(),
          projects: [
            { path: project, name: "Home fixture", addedAt: timestamp, lastOpenedAt: timestamp },
          ],
        },
      }),
    );
    await writeFile(
      join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
      [
        { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
        {
          type: "session_info",
          id: "title",
          parentId: null,
          timestamp,
          name: "Session navigation",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const application = await electron.launch({
      args: [repository],
      cwd: repository,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: userData,
        CAKE_HOME: cakeHome,
        PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    try {
      const page = await application.firstWindow();
      await application.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setContentSize(width, 900),
        theme === "light" ? 1200 : 900,
      );
      const back = page.getByRole("button", {
        name: "Back to Project Chat for Home fixture",
        exact: true,
      });
      await page
        .getByRole("navigation", { name: "Projects and global utilities" })
        .getByRole("button", { name: "Open Project Chat for Home fixture", exact: true })
        .click();
      await expect(
        page.getByRole("combobox", { name: "Message Project Chat", exact: true }),
      ).toBeVisible();
      await expect(back).toHaveCount(0);
      const sessions = await showSessions(page);
      await sessions
        .locator(`[data-session-id="${sessionId}"]`)
        .getByRole("button", { name: /^Session navigation/ })
        .click();
      await expect(back).toBeVisible({ timeout: 20_000 });
      const breadcrumb = page.getByRole("navigation", { name: "Conversation breadcrumb" });
      await expect(breadcrumb).toContainText("Session navigation");
      await expect(page.locator('[data-slot="context-group"]').first()).toBeVisible();
      await mkdir(join(repository, ".visual-captures"), { recursive: true });
      await page.screenshot({
        path: join(repository, `.visual-captures/session-chat-home-${theme}.png`),
      });
      const workspace = page.locator('[data-slot="workspace"]');
      const before = await workspace.boundingBox();
      const button = (await back.boundingBox())!;
      const breadcrumbBounds = (await breadcrumb.boundingBox())!;
      const cakeChat = page.getByRole("button", { name: "Open Cake Chat", exact: true });
      const cakeChatBounds = (await cakeChat.boundingBox())!;
      await expect(back).toHaveCount(1);
      expect(button.x - before!.x).toBe(16);
      // The header's bottom rule accounts for at most one pixel of difference.
      expect(
        Math.abs(button.y + button.height / 2 - (cakeChatBounds.y + cakeChatBounds.height / 2)),
      ).toBeLessThanOrEqual(1);
      expect(button.y).toBeGreaterThan(breadcrumbBounds.y + breadcrumbBounds.height);
      const transcript = page.locator(".transcript").first();
      expect((await transcript.boundingBox())!.y).toBeGreaterThan(button.y + button.height);
      expect(button.width).toBe(28);
      expect(button.height).toBe(28);
      expect(
        await back.evaluate((element) => parseFloat(getComputedStyle(element).borderRadius)),
      ).toBeGreaterThanOrEqual(button.width / 2);
      await back.hover();
      await expect(
        page.getByRole("tooltip", { name: "Back to Project Chat for Home fixture", exact: true }),
      ).toBeVisible();
      await page.mouse.move(600, 500);
      // Plain Tab intentionally focuses Cake's composer; Shift+Tab traverses controls.
      await page
        .getByRole("complementary", { name: "Workspace", exact: true })
        .getByRole("button", { name: /^To-dos / })
        .focus();
      await page.keyboard.press("Shift+Tab");
      await expect(back).toBeFocused();
      expect(await back.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
        "none",
      );
      await page.screenshot({
        path: join(repository, `.visual-captures/session-chat-home-${theme}-focused.png`),
      });
      // Keep the target reachable when the Workspace becomes a narrow overlay.
      await page.getByRole("button", { name: "Close Workspace", exact: true }).click();
      await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        window.setMinimumSize(360, 600);
        window.setContentSize(480, 900);
      });
      expect(await page.evaluate(() => window.innerWidth)).toBe(480);
      await expect(back).toHaveCount(1);
      await expect(back).toBeVisible();
      const narrow = (await back.boundingBox())!;
      const narrowCakeChat = (await cakeChat.boundingBox())!;
      const narrowWorkspace = await workspace.boundingBox();
      expect((await transcript.boundingBox())!.y).toBeGreaterThan(narrow.y + narrow.height);
      expect(narrow.x - narrowWorkspace!.x).toBe(16);
      expect(narrow.x + narrow.width).toBeLessThan(480);
      expect(
        Math.abs(narrow.y + narrow.height / 2 - (narrowCakeChat.y + narrowCakeChat.height / 2)),
      ).toBeLessThanOrEqual(1);
      expect(
        await back.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return element.contains(
            document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
          );
        }),
      ).toBe(true);
      await back.focus();
      await expect(back).toBeFocused();
      await page.screenshot({
        path: join(repository, `.visual-captures/session-chat-home-${theme}-narrow.png`),
      });
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("combobox", { name: "Message Project Chat", exact: true }),
      ).toBeVisible();
      await expect(back).toHaveCount(0);
      expect(await workspace.boundingBox()).toEqual(narrowWorkspace);
      await page
        .getByRole("navigation", { name: "Projects and global utilities" })
        .getByRole("button", { name: "Open Cake Chat", exact: true })
        .click();
      await expect(
        page.getByRole("combobox", { name: "Message Cake Chat", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /^Back to (Project Chat|Cake Chat)/ }),
      ).toHaveCount(0);
      const windows = await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => ({
          visible: window.isVisible(),
          focused: window.isFocused(),
        })),
      );
      expect(windows.every((window) => !window.visible && !window.focused)).toBe(true);
    } finally {
      await application.close();
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
