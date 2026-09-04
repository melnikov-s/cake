import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("Quake terminal runs a shell and only warns on resolution for a running program", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-terminal-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "terminal-smoke-session";
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const timestamp = new Date(0).toISOString();
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      selectedSessionId: sessionId,
      activeConversation: { kind: "project-session", workspacePath: project, sessionId },
      recentProjectPaths: [project],
      draft: "",
      theme: "dark",
    }),
  );
  await mkdir(join(cakeHome, "state"), { recursive: true });
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: project,
          name: "project",
          addedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
        },
      ],
      trustedProjectPaths: [],
    }),
  );
  await writeFile(
    join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Test the terminal" }],
          timestamp: 0,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );

  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: userData,
      CAKE_HOME: cakeHome,
    },
  });

  try {
    const page = await application.firstWindow();
    await expect(page.getByLabel("Message")).toBeVisible({ timeout: 20_000 });

    // ⌘` is owned by the Window menu's Toggle Terminal item: macOS consumes the
    // key equivalent for system window cycling before it could reach the
    // renderer, so the menu item is the single mechanism that drives the toggle.
    const toggleTerminalViaMenu = () =>
      application.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu()
          ?.items.flatMap((entry) => entry.submenu?.items ?? [])
          .find((entry) => entry.label === "Toggle Terminal");
        if (!item) throw new Error("Toggle Terminal menu item missing");
        if (!String(item.accelerator).includes("`"))
          throw new Error("Toggle Terminal accelerator missing the backtick");
        item.click({}, undefined);
      });

    const panel = page.locator('section[aria-label="Terminal"]');
    await expect(panel).toHaveAttribute("aria-hidden", "true");
    await page.getByRole("button", { name: /^Terminal \(/ }).click();
    await expect(panel).toHaveAttribute("aria-hidden", "false");
    await expect(panel.locator(".xterm-screen:visible")).toBeVisible();
    await panel.locator(".xterm-screen:visible").click();
    await page.keyboard.type("printf CAKE_TERMINAL_OK");
    await page.keyboard.press("Enter");
    await expect(panel.locator(".xterm-rows:visible")).toContainText("CAKE_TERMINAL_OK", {
      timeout: 10_000,
    });

    await page.keyboard.press("Meta+t");
    await expect(panel.getByRole("tab")).toHaveCount(2);

    await page.getByRole("button", { name: "Pin terminal to bottom" }).click();
    const workspace = page.locator('[data-slot="workspace"]');
    const sidebar = page.locator('[data-slot="sidebar"]');
    const dockedBounds = await panel.boundingBox();
    const workspaceBounds = await workspace.boundingBox();
    const sidebarBounds = await sidebar.boundingBox();
    expect(dockedBounds).not.toBeNull();
    expect(workspaceBounds).not.toBeNull();
    expect(sidebarBounds).not.toBeNull();
    expect(dockedBounds!.x).toBeGreaterThanOrEqual(workspaceBounds!.x);
    expect(dockedBounds!.x).toBeGreaterThanOrEqual(sidebarBounds!.x + sidebarBounds!.width - 1);
    expect(dockedBounds!.width).toBeLessThanOrEqual(workspaceBounds!.width + 1);
    expect(dockedBounds!.y + dockedBounds!.height).toBeLessThanOrEqual(
      workspaceBounds!.y + workspaceBounds!.height + 1,
    );

    await panel.locator(".xterm-screen:visible").click();
    await page.keyboard.press("Meta+t");
    await expect(panel.getByRole("tab")).toHaveCount(3);
    await page.getByRole("button", { name: "Move terminal to top" }).click();
    await expect(page.getByRole("button", { name: "Pin terminal to bottom" })).toBeVisible();

    await toggleTerminalViaMenu();
    await expect(panel).toHaveAttribute("aria-hidden", "true");
    await toggleTerminalViaMenu();
    await expect(panel).toHaveAttribute("aria-hidden", "false");
    await panel.getByRole("tab").first().click();
    await expect(panel.locator(".xterm-rows:visible")).toContainText("CAKE_TERMINAL_OK");

    await panel.getByRole("tab").last().click();
    await panel.locator(".xterm-screen:visible").click();
    await page.keyboard.type("sleep 60");
    await page.keyboard.press("Enter");
    await expect(panel.locator(".xterm-rows:visible")).toContainText("sleep 60");
    await page.waitForTimeout(250);
    await toggleTerminalViaMenu();
    await expect(panel).toHaveAttribute("aria-hidden", "true");
    const resolveAction = page.locator(
      `.session-item[data-session-id='${sessionId}'] .session-resolve-action`,
    );
    await resolveAction.click();
    await expect(page.getByText(/Resolve and stop running programs?\?/)).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();

    await toggleTerminalViaMenu();
    for (let index = 0; index < 3; index++) {
      await panel.getByRole("tab").nth(index).click();
      await panel.locator(".xterm-screen:visible").click();
      await page.keyboard.press("Control+C");
    }
    await page.keyboard.type("printf CAKE_TERMINAL_IDLE");
    await page.keyboard.press("Enter");
    await expect(panel.locator(".xterm-rows:visible")).toContainText("CAKE_TERMINAL_IDLE");
    await toggleTerminalViaMenu();
    await expect(panel).toHaveAttribute("aria-hidden", "true");
    await resolveAction.click();
    await expect(page.getByText("Resolve and stop running program?")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Resolved sessions" })).toBeVisible();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
