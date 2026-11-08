import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { emitRendererEvent } from "./main-harness";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  await execFileAsync("git", args, { cwd });
}

test("workspace changes use Source Control, committed files fall back to the file, and a base revision diffs them", async () => {
  test.setTimeout(60_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-vscode-source-control-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const external = join(temporaryRoot, "project-sibling");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "source-control-session";
  const timestamp = new Date(0).toISOString();
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));

  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(external, { recursive: true }),
    mkdir(join(project, "src"), { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(external, "notes.txt"),
    "External first line\nExternal selected line\nExternal third line\n",
  );
  const markdown = "# Investigation\n\n**Readable findings**\n\n- First\n- Second\n";
  await writeFile(join(external, "report.md"), markdown);
  await writeFile(join(project, "src", "app.ts"), "export const value = 0;\n");
  await git(project, "-c", "init.defaultBranch=main", "init");
  await git(project, "config", "user.name", "Cake Test");
  await git(project, "config", "user.email", "cake@example.test");
  await git(project, "add", ".");
  await git(project, "commit", "-m", "Initial project");
  await writeFile(join(project, "src", "app.ts"), "export const value = 1;\n");

  await writeFile(
    join(userData, "window-state.json"),
    windowState({ project, sessionId, theme: "dark" }),
  );
  await mkdir(join(cakeHome, "state"), { recursive: true });
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [project, external].map((path) => ({
        path,
        name: path === project ? "project" : "external",
        addedAt: timestamp,
        lastOpenedAt: timestamp,
      })),
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
            {
              type: "toolCall",
              id: "edit-external",
              name: "edit",
              arguments: {
                path: join(external, "notes.txt"),
                edits: [{ oldText: "External old line", newText: "External selected line" }],
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
      {
        type: "message",
        id: "assistant-summary",
        parentId: "tool-result",
        timestamp,
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: `Read [Markdown report](../project-sibling/report.md). Inspect [working-tree changes](src/app.ts?view=changes). Compare with the previous commit: [what this branch changed](src/app.ts?view=changes&base=HEAD~1#L1). Read [external lines](../project-sibling/notes.txt#L2-L3) or [external before revision](${join(external, "notes.txt")}?view=changes&side=before&base=HEAD~1#L2).`,
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
          timestamp: 3,
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
    await expect(page.getByRole("button", { name: "VS Code", exact: true })).toBeVisible({
      timeout: 20_000,
    });
    // Real RPC authorization and fullscreen reader, before any editor is started.
    await page.getByRole("link", { name: "Markdown report" }).click();
    const markdownReader = page.getByRole("dialog", { name: /project-sibling\/report\.md/ });
    await expect(markdownReader.getByRole("heading", { name: "Investigation" })).toBeVisible();
    await expect(markdownReader.locator('[data-streamdown="strong"]')).toHaveText(
      "Readable findings",
    );
    await expect(markdownReader.getByRole("listitem")).toHaveCount(2);
    await markdownReader.getByRole("button", { name: "Show source" }).click();
    await expect(markdownReader).toContainText("# Investigation");
    await expect(markdownReader).toContainText("**Readable findings**");
    await markdownReader.getByRole("button", { name: "Show Markdown" }).click();
    await expect(markdownReader.getByRole("heading", { name: "Investigation" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("link", { name: "external lines" }).click();
    const externalReader = page.getByRole("dialog", { name: /project-sibling\/notes\.txt/ });
    await expect(externalReader).toBeVisible();
    await expect(externalReader.getByText("External selected line", { exact: true })).toHaveClass(
      /bg-accent/,
    );
    await expect(externalReader.getByText("External third line", { exact: true })).toHaveClass(
      /bg-accent/,
    );
    expect(await activeVsCodeTab()).toBeUndefined();
    await page.keyboard.press("Escape");
    await expect(externalReader).toBeHidden();
    await page.getByRole("link", { name: "external before revision" }).click();
    await expect(externalReader).toBeVisible();
    await expect(
      externalReader.getByText(/Diff unavailable outside the selected project/),
    ).toBeVisible();
    await expect(
      externalReader.getByText("External selected line", { exact: false }),
    ).toBeVisible();
    expect(await activeVsCodeTab()).toBeUndefined();
    await page.keyboard.press("Escape");
    await expect(externalReader).toBeHidden();
    await expect(page.getByText(/Could not open editor location/)).toHaveCount(0);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+G" : "Control+Shift+G");

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

    await emitRendererEvent(application, {
      type: "embedded-editor-back-to-agent",
      workspacePath: project,
    });
    await expect(page.getByRole("region", { name: "VS Code workspace" })).toBeHidden();

    await page.getByRole("link", { name: "working-tree changes", exact: true }).click();
    await expect.poll(activeVsCodeTab, { timeout: 20_000 }).toMatch(/app\.ts.+/);

    // Unclaimed Escape in Cake must not exit VS Code mode.
    const workspace = page.getByRole("region", { name: "VS Code workspace" });
    await page.getByRole("button", { name: "Main", exact: true }).first().focus();
    await page.keyboard.press("Escape");
    await expect(workspace).toBeVisible();
    await expect.poll(activeVsCodeTab).toMatch(/app\.ts.+/);

    // CDP targets the hidden workbench without focusing a native OS window.
    const workbench = (source: string) =>
      application.evaluate(async ({ webContents }, source) => {
        for (const contents of webContents.getAllWebContents()) {
          if (contents.getURL().startsWith("http://127.0.0.1:"))
            return contents.executeJavaScript(source);
        }
        throw new Error("Missing embedded workbench");
      }, source);
    const key = (key: string, code: string, windowsVirtualKeyCode: number, modifiers = 0) =>
      application.evaluate(
        async ({ webContents }, input) => {
          for (const contents of webContents.getAllWebContents()) {
            if (!contents.getURL().startsWith("http://127.0.0.1:")) continue;
            if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
            await contents.debugger.sendCommand("Input.dispatchKeyEvent", {
              ...input,
              type: "keyDown",
            });
            await contents.debugger.sendCommand("Input.dispatchKeyEvent", {
              ...input,
              type: "keyUp",
            });
            return;
          }
          throw new Error("Missing embedded workbench");
        },
        { key, code, windowsVirtualKeyCode, modifiers },
      );
    const focusEditor = async (selector: string) => {
      await expect
        .poll(() =>
          workbench(`(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        if (!input) return false;
        input.focus();
        return document.activeElement === input;
      })()`),
        )
        .toBe(true);
    };
    const diffInput = (side: "original" | "modified") =>
      `.monaco-diff-editor .editor.${side} [role="textbox"]`;
    const select = async (selector: string) => {
      await focusEditor(selector);
      await key("ArrowLeft", "ArrowLeft", 37);
      await key("a", "KeyA", 65, 4);
    };
    const checkContext = async (value: number) => {
      await expect(page.getByRole("button", { name: /Remove.*src\/app\.ts/ })).toHaveCount(1);
      await page.getByRole("button", { name: /^src\/app\.ts:1/ }).click();
      await expect(page.getByText(`export const value = ${value};`, { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    };
    // Escape still belongs to the editor: it dismisses its command palette,
    // without an outer handler hiding the embedded workspace.
    await focusEditor(diffInput("modified"));
    await key("p", "KeyP", 80, 12);
    const paletteVisible = () =>
      workbench(`!!document.querySelector('.quick-input-widget')?.getClientRects().length`);
    await expect.poll(paletteVisible).toBe(true);
    await key("Escape", "Escape", 27);
    await expect.poll(paletteVisible).toBe(false);
    await expect(workspace).toBeVisible();

    await select(diffInput("original"));
    await checkContext(0);
    await select(diffInput("modified"));
    await checkContext(1);

    await focusEditor(diffInput("modified"));
    await key("p", "KeyP", 80, 12);
    await application.evaluate(async ({ webContents }) => {
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.getURL().startsWith("http://127.0.0.1:")) continue;
        await contents.debugger.sendCommand("Input.insertText", { text: "Toggle Inline View" });
      }
    });
    await expect
      .poll(() =>
        workbench(
          `!![...document.querySelectorAll('.quick-input-list .monaco-list-row')].find(e => e.textContent.includes('Toggle Inline View'))`,
        ),
      )
      .toBe(true);
    await key("Enter", "Enter", 13);
    await expect
      .poll(() => workbench(`!!document.querySelector('.line-delete-selectable')`))
      .toBe(true);
    // Inline deleted view-zones use browser selections, not VS Code TextEditor events.
    // The editable/modified inline pane still relays normal editor selections.
    await select(diffInput("modified"));
    await checkContext(1);
    await focusEditor(diffInput("modified"));
    await key("ArrowLeft", "ArrowLeft", 37);
    await expect(page.getByRole("button", { name: /Remove.*src\/app\.ts/ })).toHaveCount(0);

    await emitRendererEvent(application, {
      type: "embedded-editor-back-to-agent",
      workspacePath: project,
    });
    await expect(page.getByRole("region", { name: "VS Code workspace" })).toBeHidden();

    await git(project, "add", ".");
    await git(project, "commit", "-m", "Commit agent change");
    await page.getByRole("link", { name: "working-tree changes", exact: true }).click();

    await expect(page.getByRole("region", { name: "VS Code workspace" })).toBeVisible();
    await expect.poll(activeVsCodeTab, { timeout: 20_000 }).toBe("app.ts");
    await select('.part.editor .monaco-editor [role="textbox"]');
    await expect(page.getByRole("button", { name: /Remove.*src\/app\.ts/ })).toHaveCount(1);
    await page.getByRole("button", { name: /^src\/app\.ts:1/ }).click();
    // Normal editors remain path/range-only context, not quoted diff snapshots.
    await expect(page.getByText("export const value = 1;", { exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await emitRendererEvent(application, {
      type: "embedded-editor-back-to-agent",
      workspacePath: project,
    });
    await expect(page.getByRole("region", { name: "VS Code workspace" })).toBeHidden();

    // A base revision brings the now-committed change back into the diff editor.
    await page.locator('a[href="src/app.ts?view=changes&base=HEAD~1#L1"]').click();
    await expect(page.getByRole("region", { name: "VS Code workspace" })).toBeVisible();
    await expect.poll(activeVsCodeTab, { timeout: 20_000 }).toBe("app.ts (HEAD~1 ↔ Working Tree)");
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
