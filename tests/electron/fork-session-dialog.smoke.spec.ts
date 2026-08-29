import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/agent/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("configures and cancels a session fork dialog", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-fork-dialog-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "fork-dialog-session";
  const timestamp = new Date(0).toISOString();
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
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
          addedAt: timestamp,
          lastOpenedAt: timestamp,
        },
      ],
      resolvedSessionIds: [],
      resolvedCakeChatSessionIds: [],
      trustedProjectPaths: [],
    }),
  );
  await writeFile(
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
          content: [{ type: "text", text: "Plan the focused fix" }],
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
          content: [{ type: "text", text: "Here is the plan." }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "fixture",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
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
    const fork = page.getByRole("button", {
      name: "Fork response with full context into new chat",
    });
    await expect(fork).toBeVisible({ timeout: 20_000 });
    await fork.click({ force: true });

    const dialog = page.getByRole("dialog", { name: "Fork this conversation" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Use the existing worktree")).toBeChecked();
    await expect(dialog.getByLabel("Worktree name")).toHaveCount(0);

    await dialog.getByLabel("Create a new worktree").check();
    const name = dialog.getByLabel("Worktree name");
    await expect(name).toBeVisible();
    await expect(name).toBeFocused();
    await expect(name).toHaveValue(/^plan-the-focused-fix-[a-f0-9]{6}$/);
    await name.fill("focused-fix");
    await expect(name).toHaveValue("focused-fix");
    await dialog.getByLabel("Resolve the parent conversation after forking").check();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(fork).toBeVisible();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
