import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test, type Locator } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");
async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

for (const theme of ["light", "dark"] as const) {
  test(`recursive Sessions rows keep compact geometry during hover, selection and disclosure (${theme})`, async () => {
    test.setTimeout(120_000);
    const root = await mkdtemp(join(tmpdir(), "cake-sessions-row-layout-"));
    const paths = {
      userData: join(root, "user-data"),
      cakeHome: join(root, "cake-home"),
      project: join(root, "project"),
    };
    const scenario = findVisualCaptureScenario("chat-first-navigation")!;
    const cleanup = await scenario.seed(paths, theme);
    const app = await electron.launch({
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
      const page = await app.firstWindow();
      await scenario.prepare(page, "sessions-unread", app);
      const workspace = page.getByRole("complementary", { name: "Workspace", exact: true });
      const parent = workspace.locator(
        '[data-slot="conversation-navigator-row"][data-session-id="visual-navigation-layout"]',
      );
      const child = workspace.locator(
        '[data-slot="conversation-navigator-row"][data-session-id="visual-navigation-keyboard"]',
      );
      const header = workspace.locator(
        '[data-slot="conversation-navigator-row"][data-relationship="home"]',
      );
      const toggle = header.getByRole("switch", { name: /^Auto-merge:/ });
      const headerStatus = header.locator('[data-slot="own-activity"]');
      const sessionStatus = parent.locator('[data-slot="own-activity"]');
      const headerDot = headerStatus.getByRole("img", { name: "Running", exact: true });
      const sessionDot = sessionStatus.getByRole("img", { name: "Running", exact: true });
      const resize = page.getByRole("separator", { name: "Resize Workspace", exact: true });
      const measurements = [];
      const centerX = (box: { x: number; width: number }) => box.x + box.width / 2;
      for (const width of ["normal", "narrow"] as const) {
        if (width === "narrow") {
          await resize.focus();
          await page.keyboard.press("Home");
          await resize.blur();
        }
        await expect(headerDot).toBeVisible();
        await expect(sessionDot).toBeVisible();
        const track = await bounds(headerStatus);
        const nestedTrack = await bounds(sessionStatus);
        const control = await bounds(toggle);
        const label = await bounds(toggle.locator(".."));
        const title = await bounds(header.getByRole("button", { name: "cake", exact: true }));
        expect(title.width).toBeGreaterThanOrEqual(64);
        expect(title.x + title.width).toBeLessThanOrEqual(label.x);
        const headerCenter = centerX(await bounds(headerDot));
        const sessionCenter = centerX(await bounds(sessionDot));
        expect(track.width).toBe(24);
        expect(nestedTrack.width).toBe(track.width);
        expect(Math.abs(centerX(track) - headerCenter)).toBeLessThan(0.5);
        expect(Math.abs(headerCenter - sessionCenter)).toBeLessThan(0.5);
        expect(control.x + control.width).toBeLessThanOrEqual(track.x);
        expect(track.x - (control.x + control.width)).toBeLessThanOrEqual(4);
        measurements.push({ width: (await bounds(workspace)).width, headerCenter, sessionCenter });
        if (theme === "light") {
          await test.info().attach(`sessions-status-${width}`, {
            body: await workspace.screenshot({ animations: "disabled" }),
            contentType: "image/png",
          });
        }
      }
      expect(measurements[0]!.width).toBeGreaterThan(measurements[1]!.width);

      for (const key of ["Home", "End"]) {
        await resize.focus();
        await page.keyboard.press(key);
        const width = (await bounds(workspace)).width;
        const tabs = workspace.getByRole("group", { name: "Workspace content" });
        const todos = tabs.getByRole("button", { name: /^To-dos / });
        const sessions = tabs.getByRole("button", { name: /^Sessions ·/ });
        const todoBox = await bounds(todos);
        const sessionBox = await bounds(sessions);
        // Workspace tabs are content-sized pills of one height, not equal grid cells (c7c99e7f).
        expect(todoBox.height).toBe(sessionBox.height);
        expect(todoBox.height).toBeLessThanOrEqual(32);
        await expect(sessions.getByRole("img", { name: "1 unread", exact: true })).toBeVisible();
        for (const tab of [todos, sessions]) {
          const box = await bounds(tab);
          const spans = await tab.locator("span").all();
          for (const span of spans) {
            const content = await bounds(span);
            expect(content.x).toBeGreaterThanOrEqual(box.x);
            expect(content.x + content.width).toBeLessThanOrEqual(box.x + box.width);
            expect(content.y).toBeGreaterThanOrEqual(box.y);
            expect(content.y + content.height).toBeLessThanOrEqual(box.y + box.height);
          }
        }
        measurements.push({ width, todoBox, sessionBox });
        for (const row of [parent, child]) {
          const title = row.locator(".session-title");
          const action = row.locator(".session-row > button");
          await page.mouse.move(1, 1);
          const initial = await bounds(title);
          const rowBox = await bounds(row);
          expect(rowBox.height).toBeGreaterThanOrEqual(44);
          // Two 20px lines (title; 14px description at its 1.43 line height, 044b644b1) plus
          // 6px padding and a 2px gap. Rows already measured 54px when this bound was added.
          expect(rowBox.height).toBeLessThanOrEqual(54);
          expect(initial.width).toBeGreaterThan(60);
          expect(initial.x + initial.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
          await title.hover();
          expect(await bounds(title)).toEqual(initial);
          await action.click();
          await expect(row).toHaveAttribute("data-navigation-active", "true");
          measurements.push({ width, titleWidth: initial.width, height: rowBox.height });
        }
        await parent
          .getByRole("button", { name: "Collapse UI Layout Refactor", exact: true })
          .click();
        await expect(child).toBeHidden();
        await expect(parent.getByRole("img", { name: "Running", exact: true })).toBeVisible();
        await expect(parent.getByLabel(/running descendants/)).toHaveCount(0);
        await parent
          .getByRole("button", { name: "Expand UI Layout Refactor", exact: true })
          .click();
        await expect(child).toBeVisible();
      }
      await test.info().attach("session-row-geometry", {
        body: JSON.stringify(measurements),
        contentType: "application/json",
      });
    } finally {
      await app.close();
      if (typeof cleanup === "function") await cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });
}
