import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, test, type Page } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";

const repository = resolve(import.meta.dirname, "../..");
const workspace = (page: Page) =>
  page.getByRole("complementary", { name: "Workspace", exact: true });
const switches = (page: Page) => page.getByRole("switch", { name: /^Auto-merge:/ });
const sessions = (page: Page) =>
  workspace(page).getByRole("region", { name: "Sessions", exact: true });
const header = (page: Page, name: string) =>
  sessions(page)
    .locator('[data-slot="conversation-navigator-row"][data-relationship="home"]')
    .filter({ has: page.getByRole("button", { name, exact: true }) });
const delegated = (page: Page, path: string) =>
  sessions(page)
    .getByRole("region", { name: "Delegated", exact: true })
    .and(page.locator(`[data-project-path=${JSON.stringify(path)}]`));
const openSessions = async (page: Page) => {
  const open = page.getByRole("button", { name: "Open Workspace", exact: true });
  if (await open.isVisible()) await open.click();
  await workspace(page)
    .getByRole("button", { name: /^Sessions/ })
    .click();
};
const openTodos = async (page: Page) => {
  await workspace(page)
    .getByRole("button", { name: /^To-dos/ })
    .click();
  await expect(page.getByRole("searchbox", { name: "Search to-dos" })).toBeVisible();
  await expect(switches(page)).toHaveCount(0);
};

test("All-project Sessions shows Auto-merge only for the selected project on desktop and browser", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const root = await realpath(await mkdtemp(join(tmpdir(), "cake-sessions-auto-merge-")));
  const home = join(root, "cake-home");
  const userData = join(root, "user-data");
  const cake = join(root, "cake");
  const other = join(root, "other");
  const timestamp = new Date(0).toISOString();
  const id = "00000000-0000-4000-8000-000000000001";
  const workerId = "00000000-0000-4000-8000-000000000002";
  const otherId = "00000000-0000-4000-8000-000000000003";
  const title = "Review keyboard navigation";
  const workerTitle = "Audit the sidebar layout";
  const otherTitle = "Outline the next release";
  const seedSession = async (id: string, title: string, cwd: string) => {
    const directory = cakeWorkspaceSessionDirectory(cwd, join(home, "pi", "sessions"));
    await mkdir(directory, { recursive: true });
    const entries = [
      { type: "session", version: 3, id, timestamp, cwd },
      { type: "session_info", id: "title", parentId: null, timestamp, name: title },
      {
        type: "message",
        id: "message",
        parentId: "title",
        timestamp,
        message: { role: "user", content: [{ type: "text", text: title }], timestamp: 0 },
      },
    ];
    await writeFile(
      join(directory, `1970-01-01T00-00-00-000Z_${id}.jsonl`),
      entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
  };
  try {
    await Promise.all(
      [userData, other, cake, join(home, "state")].map((path) => mkdir(path, { recursive: true })),
    );
    // Isolated fixture only. No declaration or managed worktree exists, so clicking cannot land anything.
    await writeFile(
      join(home, "state", "application.json"),
      JSON.stringify({
        version: 11,
        data: {
          ...defaultApplicationState(),
          projects: [cake, other].map((path) => ({
            path,
            name: path === cake ? "cake" : "other",
            addedAt: timestamp,
            lastOpenedAt: timestamp,
            autoMergeEnabled: path === cake,
          })),
        },
      }),
    );
    await writeFile(
      join(userData, "window-state.json"),
      windowState({ project: cake, sessionId: id, projects: [cake, other], theme: "dark" }),
    );
    await writeFile(
      join(home, "state", "session-families.json"),
      JSON.stringify({
        version: 12,
        data: {
          families: [],
          turns: [],
          spawnedSessions: [],
          sessionPurposes: [
            {
              sessionId: workerId,
              projectPath: cake,
              purpose: "delegated",
              createdPurpose: "delegated",
            },
          ],
        },
      }),
    );
    await Promise.all([
      seedSession(id, title, cake),
      seedSession(workerId, workerTitle, cake),
      seedSession(otherId, otherTitle, other),
    ]);
    const app = await electron.launch({
      args: [repository],
      cwd: repository,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: userData,
        CAKE_HOME: home,
        PI_CODING_AGENT_DIR: join(home, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.getByRole("button", { name: "Open Cake Chat", exact: true }).click();
      await expect(page.getByRole("combobox", { name: "Message Cake Chat" })).toBeVisible();
      await openSessions(page);
      await expect(switches(page)).toHaveCount(0);
      await page.getByRole("button", { name: "Open Project Chat for cake", exact: true }).click();
      await openSessions(page);
      const group = delegated(page, cake);
      const toggle = group.getByRole("switch");
      const peer = delegated(page, other).getByRole("switch");
      const disclosure = group.getByRole("button", { name: "Delegated", exact: true });
      await expect(header(page, "cake").getByRole("switch")).toHaveCount(0);
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await expect(disclosure).toHaveText("1 delegated · 0 running");
      await expect(delegated(page, other)).toContainText("0 delegated · 0 running");
      await expect(group.getByText(workerTitle, { exact: true })).toHaveCount(0);
      await expect(switches(page)).toHaveCount(1);
      await expect(toggle).toBeChecked();
      await expect(peer).toHaveCount(0);
      const child = sessions(page).locator(
        `[data-slot="conversation-navigator-row"][data-session-id="${id}"]`,
      );
      await expect(child.getByText(title, { exact: true })).toBeVisible();
      await expect(toggle.locator("..").locator("svg")).toHaveCSS("width", "12px");
      await expect(toggle).toHaveCSS("height", "20px");
      const bounds = (await group.boundingBox())!;
      const control = (await toggle.boundingBox())!;
      const button = (await disclosure.boundingBox())!;
      expect(control.x + control.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(button.x + button.width).toBeLessThan(control.x);
      expect(
        await toggle.evaluate((el) => el.parentElement!.closest("button, [role=button]") === null),
      ).toBe(true);

      await group.getByText("Auto-merge", { exact: true }).click();
      await expect(toggle).not.toBeChecked();
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByRole("combobox", { name: "Message Project Chat" })).toBeVisible();
      await expect(peer).toHaveCount(0);
      await toggle.focus();
      await toggle.press("Shift+Tab");
      await expect(disclosure).toBeFocused();
      await app.evaluate(async () => Reflect.get(globalThis, "cakeSmokeHoldApplicationCommit")());
      try {
        await toggle.press("Space");
        await expect(toggle).toBeDisabled();
        await expect(toggle).toHaveAttribute("aria-busy", "true");
        await expect(toggle).not.toBeChecked();
      } finally {
        await app.evaluate(async () =>
          Reflect.get(globalThis, "cakeSmokeReleaseApplicationCommit")(),
        );
      }
      await expect(toggle).toBeChecked();
      await expect(toggle).toBeEnabled();
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await expect(peer).toHaveCount(0);
      await expect(child.getByText(title, { exact: true })).toBeVisible();
      await disclosure.click();
      await expect(group.getByText(workerTitle, { exact: true })).toBeVisible();
      await disclosure.click();
      await expect(group.getByText(workerTitle, { exact: true })).toHaveCount(0);
      await page.mouse.move(1, 1);
      await page.waitForFunction(() => document.fonts.status === "loaded");
      const screenshot = testInfo.outputPath("cake-selected-sessions.png");
      await workspace(page).screenshot({ path: screenshot });
      await testInfo.attach("Cake selected in Sessions", {
        path: screenshot,
        contentType: "image/png",
      });
      await header(page, "other").getByRole("button", { name: "Collapse other" }).click();
      await expect(peer).toHaveCount(0);
      await expect(sessions(page).getByText(otherTitle, { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Open Project Chat for other", exact: true }).click();
      await openSessions(page);
      await expect(peer).toBeVisible();
      await expect(peer).not.toBeChecked();
      await expect(switches(page)).toHaveCount(1);
      await expect(toggle).toHaveCount(0);
      await expect(sessions(page).getByText(otherTitle, { exact: true })).toBeVisible();
      await expect(
        header(page, "other").getByRole("button", { name: "Collapse other" }),
      ).toHaveCount(0);
      const homes = sessions(page).locator('[data-relationship="home"]');
      await expect(homes.first().getByRole("button", { name: "other", exact: true })).toBeVisible();
      const projectScreenshot = testInfo.outputPath("other-selected-sessions.png");
      await page.mouse.move(1, 1);
      await workspace(page).screenshot({ path: projectScreenshot });
      await testInfo.attach("Other project selected in Sessions", {
        path: projectScreenshot,
        contentType: "image/png",
      });
      await child.getByText(title, { exact: true }).click();
      await expect(
        page.locator(`[data-slot="session-pane"][data-session-id="${id}"]`),
      ).toBeVisible();
      await openTodos(page);

      // Use the real, isolated desktop backend from a Chromium browser, too.
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Network & privacy", exact: true }).click();
      await page.getByLabel("Browser sharing port", { exact: true }).fill("0");
      await page.getByRole("switch", { name: "Enable browser sharing" }).click();
      const status = page.locator("#setting-browser-sharing").getByRole("status");
      await expect(status).toContainText("http://127.0.0.1:");
      const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(await status.innerText())?.[0];
      if (!url) throw new Error("Missing isolated browser sharing address");
      const browser = await chromium.launch({ channel: "chromium-headless-shell" });
      try {
        const remote = await browser.newPage();
        await remote.goto(url);
        await expect(remote.getByRole("combobox", { name: "Message Cake Chat" })).toBeVisible();
        await openSessions(remote);
        await expect(switches(remote)).toHaveCount(0);
        await openTodos(remote);
        await remote
          .getByRole("button", { name: "Open Project Chat for cake", exact: true })
          .click();
        await expect(remote.getByRole("combobox", { name: "Message Project Chat" })).toBeVisible();
        await openSessions(remote);
        await expect(switches(remote)).toHaveCount(1);
        await expect(delegated(remote, cake).getByRole("switch")).toBeChecked();
        await expect(delegated(remote, other).getByRole("switch")).toHaveCount(0);
        await openTodos(remote);
        await remote.getByRole("button", { name: "Close Workspace", exact: true }).click();
        await expect(switches(remote)).toHaveCount(0);
      } finally {
        await browser.close();
      }
    } finally {
      await app.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
