import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  await execFileAsync("git", args, { cwd });
}

test("workspace changes use Source Control and historical changed files fall back to the file", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-vscode-source-control-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "source-control-session";
  const timestamp = new Date(0).toISOString();
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));

  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(join(project, "src"), { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  await writeFile(join(project, "src", "app.ts"), "export const value = 0;\n");
  await git(project, "-c", "init.defaultBranch=main", "init");
  await git(project, "config", "user.name", "Cake Test");
  await git(project, "config", "user.email", "cake@example.test");
  await git(project, "add", ".");
  await git(project, "commit", "-m", "Initial project");
  await writeFile(join(project, "src", "app.ts"), "export const value = 1;\n");

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
        id: "user-1",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Review the project changes" }],
          timestamp: 0,
        },
      },
      {
        type: "message",
        id: "assistant-tools",
        parentId: "user-1",
        timestamp,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "edit-app",
              name: "edit",
              arguments: {
                path: "src/app.ts",
                edits: [{ oldText: "export const value = 0;", newText: "export const value = 1;" }],
              },
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
          stopReason: "toolUse",
          timestamp: 1,
        },
      },
      {
        type: "message",
        id: "tool-result",
        parentId: "assistant-tools",
        timestamp,
        message: {
          role: "toolResult",
          toolCallId: "edit-app",
          toolName: "edit",
          content: [{ type: "text", text: "Successfully replaced text in src/app.ts" }],
          isError: false,
          timestamp: 2,
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
    const activeVsCodeTab = () =>
      application.evaluate(async ({ webContents }) => {
        for (const contents of webContents.getAllWebContents()) {
          if (!contents.getURL().startsWith("http://127.0.0.1:")) continue;
          const activeTab = await contents.executeJavaScript(
            `document.querySelector(".tab.active")?.textContent?.trim()`,
          );
          if (activeTab) return activeTab;
        }
        return undefined;
      });
    const changes = page.getByRole("button", { name: "Open workspace changes in VS Code" });
    await expect(changes).toBeVisible({ timeout: 20_000 });
    await changes.click();

    await expect
      .poll(
        () =>
          application.evaluate(async ({ webContents }) => {
            for (const contents of webContents.getAllWebContents()) {
              if (!contents.getURL().startsWith("http://127.0.0.1:")) continue;
              const visible = await contents.executeJavaScript(`(() => {
                const text = document.body.innerText;
                return text.includes("SOURCE CONTROL") && text.includes("app.ts");
              })()`);
              if (visible) return true;
            }
            return false;
          }),
        { timeout: 20_000 },
      )
      .toBe(true);

    await application.evaluate(
      ({ BrowserWindow }, event) => {
        for (const window of BrowserWindow.getAllWindows())
          window.webContents.send("cake:event", event);
      },
      { type: "embedded-editor-back-to-agent", workspacePath: project },
    );
    await expect(page.getByRole("region", { name: "VS Code workspace" })).toBeHidden();

    await page.getByTitle("Open src/app.ts in VS Code Changes").click();
    await expect.poll(activeVsCodeTab, { timeout: 20_000 }).toMatch(/app\.ts.+/);

    await application.evaluate(
      ({ BrowserWindow }, event) => {
        for (const window of BrowserWindow.getAllWindows())
          window.webContents.send("cake:event", event);
      },
      { type: "embedded-editor-back-to-agent", workspacePath: project },
    );
    await expect(page.getByRole("region", { name: "VS Code workspace" })).toBeHidden();

    await git(project, "add", ".");
    await git(project, "commit", "-m", "Commit agent change");
    await page.getByTitle("Open src/app.ts in VS Code Changes").click();

    await expect(page.getByRole("region", { name: "VS Code workspace" })).toBeVisible();
    await expect.poll(activeVsCodeTab, { timeout: 20_000 }).toBe("app.ts");
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
