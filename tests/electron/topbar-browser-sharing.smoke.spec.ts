import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";

import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

async function expectPairedNavigation(page: Page) {
  const toggles = page.getByRole("button", { name: "Toggle sidebar", exact: true });
  expect(await toggles.count()).toBeGreaterThan(0);
  for (const toggle of await toggles.all()) {
    const connection = toggle.locator("..").getByRole("button", { name: /^Browser sharing:/ });
    await expect(connection).toBeVisible();
    await expect(connection).toBeInViewport({ ratio: 1 });
    // Read both bounds in one frame, including while the sidebar animates.
    await expect
      .poll(() =>
        toggle.evaluate((element) => {
          const navigation = element.getBoundingClientRect();
          const connection = element.nextElementSibling!.getBoundingClientRect();
          return {
            gap: connection.x - navigation.right,
            verticalOffset: connection.y - navigation.y,
          };
        }),
      )
      .toEqual({ gap: 4, verticalOffset: 0 });
    // Optional actions may scroll, but neither navigation control belongs to that scroller.
    expect(
      await connection.evaluate((element) => {
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          if (getComputedStyle(parent).overflowX === "auto") return true;
        }
        return false;
      }),
    ).toBe(false);
  }
}

async function checkResponsiveNavigation(page: Page) {
  const sidebar = page.getByRole("complementary");
  for (const expanded of [true, false]) {
    for (const width of [1280, 820, 621, 620, 420, 320]) {
      await page.setViewportSize({ width, height: 700 });
      await expectPairedNavigation(page);
      if (width === 420) {
        const owner = expanded ? sidebar : page.locator('[data-slot="workspace-header"]');
        await owner.getByRole("button", { name: /^Browser sharing:/ }).click();
        await expect(page.getByRole("dialog", { name: "Browser sharing" })).toBeVisible();
        await page.keyboard.press("Escape");
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    if (expanded) {
      await sidebar.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
      await expect(sidebar).not.toBeVisible();
    }
  }
  await page.locator('[data-slot="header-sidebar-toggle"]').click();
  await expect(sidebar).toBeVisible();
}

test("topbar sharing supports keyboard access, real listener actions and Settings synchronization", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "cake-topbar-sharing-"));
  const userData = join(directory, "user-data");
  const home = join(directory, "home");
  const project = join(directory, "project");
  const sessions = cakeWorkspaceSessionDirectory(project, join(home, "pi", "sessions"));
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const timestamp = new Date(0).toISOString();
  await Promise.all(
    [userData, project, sessions, join(home, "state")].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  await writeFile(join(userData, "window-state.json"), windowState({ project, sessionId }));
  await writeFile(
    join(home, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        { path: project, name: "Sharing project", addedAt: timestamp, lastOpenedAt: timestamp },
      ],
      trustedProjectPaths: [project],
    }),
  );
  await writeFile(
    join(sessions, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
      {
        type: "message",
        id: "user-entry",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Offline sharing fixture" }],
          timestamp: 0,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  await writeFile(
    join(userData, "desktop-sharing.json"),
    JSON.stringify({ version: 1, preferences: { bind: "127.0.0.1", port: 0 } }),
  );
  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
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
    const page = await application.firstWindow();
    page.setDefaultTimeout(15_000);
    await expect(
      page.locator(".transcript").getByText("Offline sharing fixture", { exact: true }),
    ).toBeVisible();
    const offline = page
      .getByRole("button", { name: "Browser sharing: Offline — go online" })
      .first();
    await expect(offline).toBeVisible();
    await expect(offline).toHaveAttribute("aria-expanded", "false");
    await offline.focus();
    await offline.press("Enter");
    const panel = page.getByRole("dialog", { name: "Browser sharing" });
    const start = panel.getByRole("button", { name: "Go online", exact: true });
    await expect(panel).toBeVisible();
    await expect(start).toBeFocused();
    await expect(panel).toContainText("full host access");
    await start.press("Tab");
    await expect(panel.getByRole("button", { name: "Connection settings" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(panel).not.toBeVisible();
    await expect(offline).toBeFocused();
    await offline.press("Space");
    await expect(start).toBeFocused();
    await start.press("Enter");
    const online = page.getByRole("button", { name: "Browser sharing: Online" }).first();
    await expect(online).toBeVisible();
    await expect(panel.getByRole("status")).toHaveText("Online");
    const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(await panel.innerText())?.[0];
    if (!url) throw new Error("Missing bound browser-sharing address");
    expect((await page.request.get(url)).status()).toBe(200);
    await panel.getByRole("button", { name: "Connection settings" }).click();
    const toggle = page.getByRole("switch", { name: "Enable browser sharing" });
    await expect(toggle).toBeChecked();
    await expect(page.getByLabel("Browser sharing port", { exact: true })).toHaveValue("0");
    await toggle.click();
    await expect(offline).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await offline.click();
    await start.click();
    await expect(online).toBeVisible();
    await panel.getByRole("button", { name: "Go offline", exact: true }).click();
    await expect(offline).toBeVisible();
    // The anchored panel and icon remain reachable without clipping at compact widths.
    for (const width of [620, 420]) {
      await page.setViewportSize({ width, height: 700 });
      const triggerBounds = await offline.boundingBox();
      const panelBounds = await panel.boundingBox();
      expect(triggerBounds).not.toBeNull();
      expect(panelBounds).not.toBeNull();
      expect(triggerBounds!.x).toBeGreaterThanOrEqual(0);
      expect(triggerBounds!.x + triggerBounds!.width).toBeLessThanOrEqual(width);
      expect(panelBounds!.x).toBeGreaterThanOrEqual(0);
      expect(panelBounds!.x + panelBounds!.width).toBeLessThanOrEqual(width);
    }
    await page.mouse.click(10, 650);
    await expect(panel).not.toBeVisible();
    await expect(offline).toHaveAttribute("aria-expanded", "false");
    await page.setViewportSize({ width: 1280, height: 900 });
    await checkResponsiveNavigation(page);
    await page.locator('[data-slot="cake-chat-group"]').click();
    await expect(page.getByLabel("Message")).toBeVisible();
    await checkResponsiveNavigation(page);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
