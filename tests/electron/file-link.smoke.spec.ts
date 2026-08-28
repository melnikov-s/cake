import { createHash } from "node:crypto";
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
  const reviewThreadId = "vscode-annotation-thread";
  const timestamp = new Date(0).toISOString();
  const imageData = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"><rect width="1600" height="1200" fill="red"/></svg>',
  ).toString("base64");
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const reviewDirectory = join(userData, "reviews", digest(project), digest(sessionId));

  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(join(project, "src"), { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
    mkdir(reviewDirectory, { recursive: true }),
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
    join(reviewDirectory, `${digest(reviewThreadId)}.json`),
    `${JSON.stringify({
      id: reviewThreadId,
      workspacePath: project,
      sessionId,
      anchor: {
        path: "src/modelMeta.ts",
        view: "file",
        start: { diffLine: 0, oldLine: 1, newLine: 1, column: 13 },
        end: { diffLine: 0, oldLine: 1, newLine: 1, column: 17 },
        selectedText: "meta",
        contextBefore: "",
        contextAfter: "",
        diff: "",
      },
      pendingComments: [
        { id: "annotation-question", body: "Why is this exported?", createdAt: timestamp },
      ],
      status: "open",
      createdAt: timestamp,
      updatedAt: timestamp,
    })}\n`,
  );
  await writeFile(
    join(sessionDirectory, `${sessionId}.jsonl`),
    [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
      {
        type: "message",
        id: "user-image",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: [{ type: "image", data: imageData, mimeType: "image/svg+xml" }],
          timestamp: 0,
        },
      },
      {
        type: "message",
        id: "assistant-final",
        parentId: "user-image",
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
    const hasVsCodeTitleAction = (label: string) =>
      application.evaluate(async ({ webContents }, actionLabel) => {
        for (const contents of webContents.getAllWebContents()) {
          if (!contents.getURL().startsWith("http://127.0.0.1:")) continue;
          const visible = await contents.executeJavaScript(`Array.from(document.querySelectorAll(
            '[aria-label*="${actionLabel}"], [title*="${actionLabel}"]',
          )).some((candidate) => {
            const bounds = candidate.getBoundingClientRect();
            return bounds.width > 0 && bounds.height > 0;
          })`);
          if (visible) return true;
        }
        return false;
      }, label);
    const hasVsCodeText = (text: string) =>
      application.evaluate(async ({ webContents }, expectedText) => {
        for (const contents of webContents.getAllWebContents()) {
          if (!contents.getURL().startsWith("http://127.0.0.1:")) continue;
          if (
            await contents.executeJavaScript(
              `document.body.innerText.includes(${JSON.stringify(expectedText)})`,
            )
          )
            return true;
        }
        return false;
      }, text);
    const clickVsCodeText = (text: string) =>
      application.evaluate(async ({ webContents }, expectedText) => {
        for (const contents of webContents.getAllWebContents()) {
          if (!contents.getURL().startsWith("http://127.0.0.1:")) continue;
          const point = await contents.executeJavaScript(`(() => {
            const candidate = Array.from(document.querySelectorAll(
              ".codelens-decoration a",
            )).find((element) => element.textContent.includes(${JSON.stringify(expectedText)}));
            if (!(candidate instanceof HTMLElement)) return undefined;
            const bounds = candidate.getBoundingClientRect();
            return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
          })()`);
          if (!point) continue;
          contents.focus();
          contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
          contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
          return true;
        }
        return false;
      }, text);
    const clickVsCodeTitleAction = (label: string) =>
      application.evaluate(async ({ webContents }, actionLabel) => {
        for (const contents of webContents.getAllWebContents()) {
          if (!contents.getURL().startsWith("http://127.0.0.1:")) continue;
          const clicked = await contents.executeJavaScript(`(() => {
            const candidate = document.querySelector(
              '[aria-label*="${actionLabel}"], [title*="${actionLabel}"]',
            );
            if (!(candidate instanceof HTMLElement)) return false;
            candidate.click();
            return true;
          })()`);
          if (clicked) return true;
        }
        return false;
      }, label);

    await agentInput.fill("Keep this IDE draft");
    await link.click();
    const vscodeWorkspace = page.getByRole("region", { name: "VS Code workspace" });
    await expect(vscodeWorkspace).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to Agent" })).toHaveCount(0);
    await expect
      .poll(() => hasVsCodeTitleAction("Toggle Chat Sidebar"), { timeout: 20_000 })
      .toBe(true);
    await expect.poll(() => hasVsCodeTitleAction("Back to Agent"), { timeout: 20_000 }).toBe(true);
    await expect
      .poll(() =>
        application.evaluate(async ({ webContents }) => {
          for (const contents of webContents.getAllWebContents()) {
            if (!contents.getURL().startsWith("http://127.0.0.1:")) continue;
            const hasCakeIcon = await contents.executeJavaScript(
              'Boolean(document.querySelector("#cake-back-to-agent svg")) && !document.querySelector("#cake-back-to-agent .codicon-arrow-left")',
            );
            if (hasCakeIcon) return true;
          }
          return false;
        }),
      )
      .toBe(true);
    await expect.poll(() => hasVsCodeTitleAction("Toggle Secondary Side Bar")).toBe(false);
    await expect.poll(() => hasVsCodeText("Build with Agent")).toBe(false);
    await expect
      .poll(() => clickVsCodeText("Cake: Pending · 0 replies"), { timeout: 20_000 })
      .toBe(true);
    await expect(page.getByText("Chat about selection", { exact: true })).toBeVisible();
    await expect(page.getByText("Why is this exported?", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Project chat" }).click();
    expect(await clickVsCodeTitleAction("Toggle Chat Sidebar")).toBe(true);
    await expect.poll(() => hasVsCodeTitleAction("Back to Agent")).toBe(true);
    expect(await clickVsCodeTitleAction("Back to Agent")).toBe(true);
    await expect(vscodeWorkspace).toBeHidden();
    await expect(page.getByText("Phase 4 — Model references")).toBeVisible();
    await expect(agentInput).toHaveValue("Keep this IDE draft");

    await application.evaluate(
      ({ BrowserWindow }, event) => {
        for (const window of BrowserWindow.getAllWindows())
          window.webContents.send("cake:event", event);
      },
      {
        type: "embedded-editor-location-opened",
        workspacePath: project,
        location: { path: "src/modelMeta.ts", range: { start: { line: 0 } } },
      },
    );
    await expect(page.getByRole("region", { name: "VS Code workspace" })).toBeVisible();
    expect(await clickVsCodeTitleAction("Back to Agent")).toBe(true);

    await link.click();

    await expect(vscodeWorkspace).toBeVisible();
    await expect
      .poll(() => hasVsCodeTitleAction("Toggle Chat Sidebar"), { timeout: 20_000 })
      .toBe(true);
    const toggleChatSidebar = () =>
      application.evaluate(
        ({ BrowserWindow }, event) => {
          for (const window of BrowserWindow.getAllWindows())
            window.webContents.send("cake:event", event);
        },
        { type: "embedded-editor-toggle-chat", workspacePath: project },
      );
    const vscodeFillsWindow = () =>
      application.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const view = window?.contentView.children.find((child) =>
          child.webContents.getURL().startsWith("http://127.0.0.1:"),
        );
        if (!window || !view) return false;
        const bounds = view.getBounds();
        const contentBounds = window.getContentBounds();
        const workbenchWidth = await view.webContents.executeJavaScript(
          'document.querySelector(".monaco-workbench")?.getBoundingClientRect().width',
        );
        return (
          bounds.x === 0 &&
          bounds.y === 0 &&
          bounds.width === contentBounds.width &&
          bounds.height === contentBounds.height &&
          workbenchWidth === bounds.width
        );
      });
    await toggleChatSidebar();
    await expect(vscodeWorkspace).toBeVisible();
    await expect.poll(vscodeFillsWindow).toBe(true);
    const originalContentSize = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.getContentSize(),
    );
    await application.evaluate(({ BrowserWindow }, [width, height]) => {
      BrowserWindow.getAllWindows()[0]!.setContentSize(width - 160, height - 80);
    }, originalContentSize);
    await expect.poll(vscodeFillsWindow).toBe(true);
    await application.evaluate(({ BrowserWindow }, [width, height]) => {
      BrowserWindow.getAllWindows()[0]!.setContentSize(width, height);
    }, originalContentSize);
    await expect.poll(vscodeFillsWindow).toBe(true);
    await toggleChatSidebar();
    await expect.poll(() => hasVsCodeTitleAction("Back to Agent")).toBe(true);

    await expect(page.locator(".transcript").getByText(/Phase 4 — Model references/)).toBeVisible();

    const imagePreview = page.getByRole("button", { name: "View Image 1 enlarged" });
    await imagePreview.click();
    const imageDialog = page.getByRole("dialog", { name: "Image 1" });
    await expect(imageDialog).toBeVisible();
    const previewBounds = await page.evaluate(() => {
      const chat = document
        .querySelector<HTMLElement>("aside .chat-layout")!
        .getBoundingClientRect();
      const dialog = document
        .querySelector<HTMLElement>(".image-preview-overlay")!
        .getBoundingClientRect();
      const image = document
        .querySelector<HTMLImageElement>(".image-preview-figure img")!
        .getBoundingClientRect();
      return {
        chat: { top: chat.top, right: chat.right, bottom: chat.bottom, left: chat.left },
        dialog: {
          top: dialog.top,
          right: dialog.right,
          bottom: dialog.bottom,
          left: dialog.left,
        },
        image: { top: image.top, right: image.right, bottom: image.bottom, left: image.left },
      };
    });
    expect(previewBounds.dialog).toEqual(previewBounds.chat);
    expect(previewBounds.image.left).toBeGreaterThanOrEqual(previewBounds.dialog.left);
    expect(previewBounds.image.right).toBeLessThanOrEqual(previewBounds.dialog.right);
    expect(previewBounds.image.top).toBeGreaterThanOrEqual(previewBounds.dialog.top);
    expect(previewBounds.image.bottom).toBeLessThanOrEqual(previewBounds.dialog.bottom);
    await page.getByRole("button", { name: "Close Image 1" }).click();

    const resizeHandle = page.getByRole("separator", { name: "Resize current session sidebar" });
    await expect(resizeHandle).toHaveAttribute("aria-valuenow", "420");
    await resizeHandle.focus();
    await resizeHandle.press("ArrowLeft");
    await expect(resizeHandle).toHaveAttribute("aria-valuenow", "436");
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
        type: "embedded-editor-activity",
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
    await expect(page.getByText("src/modelMeta.ts:1:14-1:18", { exact: true })).toBeVisible();
    expect(await clickVsCodeTitleAction("Back to Agent")).toBe(true);
    await link.click();
    await expect(page.getByRole("region", { name: "VS Code workspace" })).toBeVisible();

    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    await expect(page.getByText("Phase 4 — Model references")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Message" })).toHaveValue(
      "Chat from the IDE drawer",
    );
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
