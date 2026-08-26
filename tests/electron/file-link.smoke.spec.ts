import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/agent/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("a file-path link opens IDE mode with VS Code and the shared Cake chat drawer", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-file-link-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "file-link-session";
  const timestamp = new Date(0).toISOString();
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));

  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(join(project, "src"), { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  await writeFile(join(project, "src", "modelMeta.ts"), "export const meta = 1;\n");
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
        id: "assistant-final",
        parentId: null,
        timestamp,
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Phase 4 — Model references ([`src/modelMeta.ts`](src/modelMeta.ts)) is done.",
            },
          ],
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
    const link = page.locator('a[href="src/modelMeta.ts"]');
    await expect(link).toHaveText("src/modelMeta.ts");
    expect(await link.getAttribute("title")).toBe("Open src/modelMeta.ts in VS Code");
    const agentInput = page.getByRole("combobox", { name: "Message" });
    await agentInput.fill("Keep this IDE draft");

    await link.click();

    await expect(page.getByRole("region", { name: "VS Code workspace" })).toBeVisible();
    await expect(page.getByText("Cake Agent", { exact: true })).toBeVisible();
    const drawerInput = page.getByRole("combobox", { name: "Message" });
    await expect(drawerInput).toHaveValue("Keep this IDE draft");
    await drawerInput.focus();
    await expect(drawerInput).toBeFocused();
    await drawerInput.fill("Chat from the IDE drawer");
    await expect(drawerInput).toHaveValue("Chat from the IDE drawer");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

    await application.evaluate(
      ({ BrowserWindow }, event) => {
        for (const window of BrowserWindow.getAllWindows())
          window.webContents.send("cake:event", event);
      },
      {
        type: "embedded-editor-selection",
        action: "ask",
        workspacePath: project,
        path: "src/modelMeta.ts",
        documentVersion: 1,
        startLine: 0,
        startColumn: 13,
        endLine: 0,
        endColumn: 17,
        selectedText: "meta",
        contextBefore: "",
        contextAfter: "",
      },
    );
    await expect(page.getByText("Chat about selection", { exact: true })).toBeVisible();
    await expect(page.getByText("src/modelMeta.ts · L1", { exact: true })).toBeVisible();
    const selectionInput = page.getByRole("combobox", { name: "Message code chat" });
    await expect(selectionInput).toBeFocused();
    await selectionInput.fill("Why is this exported?");
    await expect(selectionInput).toHaveValue("Why is this exported?");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
    await page.getByRole("button", { name: "Project chat" }).click();
    await expect(drawerInput).toHaveValue("Chat from the IDE drawer");
    await drawerInput.fill("");
    await application.evaluate(
      ({ BrowserWindow }, event) => {
        for (const window of BrowserWindow.getAllWindows())
          window.webContents.send("cake:event", event);
      },
      {
        type: "embedded-editor-selection",
        action: "add-to-project-chat",
        workspacePath: project,
        path: "src/modelMeta.ts",
        documentVersion: 2,
        startLine: 0,
        startColumn: 13,
        endLine: 0,
        endColumn: 17,
        selectedText: "meta",
        contextBefore: "",
        contextAfter: "",
      },
    );
    await expect(page.getByText("src/modelMeta.ts:1:14-1:18", { exact: true })).toBeVisible();
    await expect(drawerInput).toBeFocused();
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
    await page
      .locator("details")
      .filter({ hasText: "src/modelMeta.ts:1:14-1:18" })
      .evaluate((details: HTMLDetailsElement) => {
        details.open = true;
      });
    await expect(page.getByText("meta", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open in VS Code" })).toBeEnabled();
    await page
      .getByRole("button", { name: "Remove src/modelMeta.ts:1:14-1:18" })
      .evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    await drawerInput.fill("Chat from the IDE drawer");

    await page.getByRole("button", { name: "Back to Agent" }).click();
    await expect(page.getByText("Phase 4 — Model references")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Message" })).toHaveValue(
      "Chat from the IDE drawer",
    );
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
