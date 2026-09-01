import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("uses the native context menu for project sessions", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-sidebar-rename-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "sidebar-rename-session";
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const cakeChatDirectory = join(cakeHome, "pi", "global-chat", "sessions");
  const cakeChatSessionId = "sidebar-rename-cake-chat";
  const timestamp = new Date(0).toISOString();
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
    mkdir(cakeChatDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      selectedSessionId: sessionId,
      activeConversation: { kind: "project-session", workspacePath: project, sessionId },
      recentProjectPaths: [project],
      draft: "",
      theme: "system",
      draftsBySession: {},
    }),
  );
  await writeFile(
    join(userData, "application.json"),
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
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      trustedProjectPaths: [],
    }),
  );
  await Promise.all([
    writeFile(
      join(sessionDirectory, `${sessionId}.jsonl`),
      [
        { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
        {
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp,
          message: {
            role: "user",
            content: [{ type: "text", text: "Original session title" }],
            timestamp: 0,
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    ),
    writeFile(
      join(cakeChatDirectory, `${cakeChatSessionId}.jsonl`),
      [
        { type: "session", version: 3, id: cakeChatSessionId, timestamp, cwd: homedir() },
        {
          type: "message",
          id: "cake-user-1",
          parentId: null,
          timestamp,
          message: {
            role: "user",
            content: [{ type: "text", text: "Original Cake Chat title" }],
            timestamp: 0,
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    ),
  ]);

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
    const sessionRow = page.locator(".session-row").filter({ hasText: "Original session title" });
    await expect(sessionRow).toHaveCount(1);
    await sessionRow.click({ button: "right" });

    // Native Electron menus are outside the renderer accessibility tree. The
    // sidebar must no longer mount a second HTML menu over the native one.
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.getByLabel("Session name")).toHaveCount(0);
    await page.keyboard.press("Escape");

    const cakeChatRow = page
      .locator(".session-row")
      .filter({ hasText: "Original Cake Chat title" });
    await expect(cakeChatRow).toHaveCount(1);
    await cakeChatRow.click({ button: "right" });
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.getByLabel("Session name")).toHaveCount(0);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "New Cake Chat" }).first().click();
    await expect(page.getByLabel("Message Cake Chat")).toBeVisible();
    await expect(page.locator(".session-row").filter({ hasText: "New chat" })).toHaveCount(1);
    expect(await readdir(cakeChatDirectory)).toEqual([`${cakeChatSessionId}.jsonl`]);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
