import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { seedCakeChatHistory } from "./durable-chat-fixture";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("uses native session menus and preserves Cake Chat settings context", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-sidebar-rename-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "sidebar-rename-session";
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const timestamp = new Date(0).toISOString();
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
  await seedCakeChatHistory(cakeHome, "Original Cake Chat conversation");
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
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
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
          content: [{ type: "text", text: "Original session title" }],
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
      PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible({
      timeout: 20_000,
    });
    // Exercise native menu construction without displaying an OS popup.
    await application.evaluate(({ Menu }) => {
      const original = Menu.buildFromTemplate.bind(Menu);
      Reflect.set(globalThis, "sidebarMenus", []);
      Menu.buildFromTemplate = (template) => {
        const menu = original(template);
        menu.popup = (options) => {
          Reflect.get(globalThis, "sidebarMenus").push(menu.items.map(({ label }) => label));
          options?.callback?.();
        };
        return menu;
      };
    });
    const sessionRow = page.locator(".session-row").filter({ hasText: "Original session title" });
    await expect(sessionRow).toHaveCount(1);
    await sessionRow.click({ button: "right" });
    await expect
      .poll(() => application.evaluate(() => Reflect.get(globalThis, "sidebarMenus").length))
      .toBe(1);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.getByLabel("Session name")).toHaveCount(0);
    const cakeChatRow = page.getByRole("button", { name: "Cake Chat", exact: true });
    await cakeChatRow.click({ button: "right" });
    await expect
      .poll(() => application.evaluate(() => Reflect.get(globalThis, "sidebarMenus").length))
      .toBe(2);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await cakeChatRow.click();
    const composer = page.getByRole("combobox", { name: "Message Cake Chat", exact: true });
    await expect(composer).toBeVisible();
    await expect(
      page.locator(".transcript").getByText("Original Cake Chat conversation", { exact: true }),
    ).toBeVisible();
    await composer.fill("Retained coordinator draft");
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Agent/ }).click();
    await expect(page.getByText("Auto-compact", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Back to chat" }).click();
    await expect(composer).toHaveValue("Retained coordinator draft");
    await expect(
      page.locator(".transcript").getByText("Original Cake Chat conversation", { exact: true }),
    ).toBeVisible();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
