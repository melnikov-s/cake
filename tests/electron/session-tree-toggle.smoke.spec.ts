import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/agent/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("the session header tree button toggles the session tree pane", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-tree-toggle-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "tree-toggle-session";
  const timestamp = new Date(0).toISOString();
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));

  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  await writeFile(join(project, "README.md"), "# Tree toggle fixture\n");
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      selectedSessionId: sessionId,
      activeConversation: { kind: "project-session", workspacePath: project, sessionId },
      recentProjectPaths: [project],
      draft: "",
      theme: "dark",
      thinkingExpanded: false,
      draftsBySession: {},
    }),
  );
  await writeFile(
    join(userData, "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
      resolvedSessionIds: [],
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
          content: [{ type: "text", text: "Hello" }],
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
          content: [{ type: "text", text: "Hi there." }],
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
    const composer = page.getByRole("combobox", { name: "Message" });
    await expect(composer).toBeVisible({ timeout: 20_000 });

    const treeButton = page.getByRole("button", { name: "Session tree", exact: true });
    await expect(treeButton).toBeVisible();
    await expect(treeButton).toHaveAttribute("aria-pressed", "false");

    // Open: the command pane shows the session tree and the button reads pressed.
    await treeButton.click();
    const paneTitle = page.getByRole("heading", { name: "Session tree" });
    await expect(paneTitle).toBeVisible();
    await expect(treeButton).toHaveAttribute("aria-pressed", "true");

    // Close: the pane disappears and the button returns to its unpressed state.
    await treeButton.click();
    await expect(paneTitle).toBeHidden();
    await expect(treeButton).toHaveAttribute("aria-pressed", "false");
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
