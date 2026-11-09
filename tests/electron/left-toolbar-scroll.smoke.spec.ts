import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { windowState } from "../fixtures/window-state";
import { showSessions } from "./fixtures/workspace-navigation";

test("all left toolbar disclosures preserve a populated transcript's scroll and geometry", async () => {
  test.setTimeout(120_000);
  const temporary = await mkdtemp(join(tmpdir(), "cake-toolbar-scroll-"));
  const paths = {
    cakeHome: join(temporary, "cake-home"),
    userData: join(temporary, "user-data"),
    project: join(temporary, "project"),
  };
  const sessionId = "toolbar-scroll-session";
  const timestamp = new Date(0).toISOString();
  const directory = join(
    paths.cakeHome,
    "pi",
    "sessions",
    `--${paths.project.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
  );
  await Promise.all(
    [directory, paths.project, paths.userData, join(paths.cakeHome, "state")].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  await writeFile(
    join(paths.userData, "window-state.json"),
    windowState({ project: paths.project, sessionId, theme: "dark" }),
  );
  await writeFile(
    join(paths.cakeHome, "state", "application.json"),
    JSON.stringify({
      version: 11,
      data: {
        ...defaultApplicationState(),
        projects: [
          {
            path: paths.project,
            name: "Scroll fixture",
            addedAt: timestamp,
            lastOpenedAt: timestamp,
          },
        ],
      },
    }),
  );
  const entries = [
    { type: "session", version: 3, id: sessionId, timestamp, cwd: paths.project },
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp,
      message: {
        role: "user",
        content: [{ type: "text", text: "Verify toolbar scroll stability" }],
        timestamp: 0,
      },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp,
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: Array.from(
              { length: 80 },
              (_, i) =>
                `Paragraph ${i}: Toolbar scroll fixture content that must remain anchored during disclosure.`,
            ).join("\n\n"),
          },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "visual-fixture",
        stopReason: "stop",
        timestamp: 1,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    },
  ];
  await writeFile(
    join(directory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  const root = resolve(import.meta.dirname, "../..");
  const app = await electron.launch({
    args: [root],
    cwd: root,
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
    const sidebar = await showSessions(page);
    await sidebar
      .locator(`.session-item[data-session-id="${sessionId}"] .session-row > button`)
      .click();
    await expect(page.locator(".transcript").first()).toContainText("Toolbar scroll fixture", {
      timeout: 20_000,
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1180, 600),
    );
    const rail = page.getByRole("navigation", { name: "Projects and global utilities" });
    const transcript = page.locator(".transcript").first();
    const workspace = page.locator('[data-slot="workspace"]');
    let autoHide = false;
    for (const mode of [
      { autoHide: false, layout: "dynamic" },
      { autoHide: false, layout: "full" },
      { autoHide: false, layout: "slim" },
      { autoHide: true, layout: "full" },
      { autoHide: true, layout: "slim" },
    ]) {
      if (!(await rail.isVisible()))
        await page.getByRole("button", { name: "Show left toolbar", exact: true }).click();
      await rail.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: /^Appearance/ }).click();
      if (autoHide !== mode.autoHide) {
        await page.getByRole("switch", { name: "Auto-hide", exact: true }).click();
        autoHide = mode.autoHide;
      }
      await page.getByLabel("Layout", { exact: true }).selectOption(mode.layout);
      await page.getByRole("button", { name: "Back to chat", exact: true }).click();
      await page.getByRole("combobox", { name: "Message", exact: true }).focus();
      await page.mouse.move(600, 200);
      await expect
        .poll(async () => (await rail.boundingBox())?.width ?? 0)
        .toBe(autoHide ? 0 : mode.layout === "full" ? 240 : 54);
      await expect
        .poll(() => transcript.evaluate((element) => element.scrollHeight - element.clientHeight))
        .toBeGreaterThan(100);
      // Use real reading input: raw scrollTop writes do not cancel Cake's
      // follow-bottom or explicit Home destination owners. Each settings round-trip
      // can restore the previous reading position, so choose End explicitly first.
      await transcript.focus();
      await page.keyboard.press("End");
      await expect
        .poll(() =>
          transcript.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          ),
        )
        .toBeLessThanOrEqual(1);
      const bottom = await transcript.evaluate((element) => element.scrollTop);
      await transcript.hover({ position: { x: 300, y: 100 } });
      await page.mouse.wheel(0, -180);
      await expect
        .poll(() => transcript.evaluate((element) => element.scrollTop))
        .toBe(bottom - 180);
      const savedScroll = await transcript.evaluate((element) => element.scrollTop);
      expect(savedScroll).toBeGreaterThan(0);
      const before = await workspace.boundingBox();
      const chatBefore = await transcript.boundingBox();
      if (autoHide) {
        const edge = (await page.locator('[data-slot="project-rail-edge"]').boundingBox())!;
        await page.mouse.move(1, edge.y + 100);
      } else await rail.hover();
      await expect
        .poll(async () => (await rail.boundingBox())?.width ?? 0)
        .toBe(mode.layout === "slim" ? 54 : 240);
      expect(await workspace.boundingBox()).toEqual(before);
      expect(await transcript.boundingBox()).toEqual(chatBefore);
      expect(await transcript.evaluate((element) => element.scrollTop)).toBe(savedScroll);
      await page.mouse.move(600, 200);
      await expect
        .poll(async () => (await rail.boundingBox())?.width ?? 0)
        .toBe(autoHide ? 0 : mode.layout === "full" ? 240 : 54);
      expect(await transcript.evaluate((element) => element.scrollTop)).toBe(savedScroll);
    }
  } finally {
    await app.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
