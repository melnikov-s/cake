import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("opens tree navigation from the session header and individual messages", async () => {
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
      draftsBySession: {},
    }),
  );
  await mkdir(join(cakeHome, "state"), { recursive: true });
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
    await page.keyboard.press("Escape");
    await expect(paneTitle).toBeHidden();
    await expect(treeButton).toHaveAttribute("aria-pressed", "false");

    // Completed user and assistant messages can both open Pi tree navigation.
    const assistantTree = page.getByRole("button", {
      name: "Continue from response in session tree",
    });
    const userTree = page.getByRole("button", { name: "Continue from message in session tree" });
    await expect(assistantTree).toBeVisible();
    await expect(userTree).toBeVisible();

    await assistantTree.click({ force: true });
    const dialog = page.getByRole("dialog", { name: "Continue from this message" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Summarize with custom focus" }).click();
    const summaryFocus = dialog.getByRole("textbox", { name: "Summary focus" });
    await expect(summaryFocus).toBeFocused();
    await summaryFocus.pressSequentially("Keep the implementation decisions");
    await expect(summaryFocus).toHaveValue("Keep the implementation decisions");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    await userTree.click({ force: true });
    await dialog.getByRole("button", { name: "Continue here" }).click();
    await expect(dialog).toBeHidden();
    await expect(composer).toHaveValue("Hello");
    await expect(composer).toBeFocused();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
