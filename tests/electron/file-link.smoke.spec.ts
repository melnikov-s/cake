import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { emitRendererEvent } from "./main-harness";

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
  const reviewDirectory = join(cakeHome, "state", "reviews", digest(project), digest(sessionId));

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
    join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
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
    const isVsCodePrimarySidebarVisible = () =>
      application.evaluate(async ({ webContents }) => {
        for (const contents of webContents.getAllWebContents()) {
          if (!contents.getURL().startsWith("http://127.0.0.1:")) continue;
          const visible = await contents.executeJavaScript(`(() => {
            const sidebar = document.querySelector(".part.sidebar");
            if (!(sidebar instanceof HTMLElement)) return false;
            const bounds = sidebar.getBoundingClientRect();
            return bounds.width > 0 && bounds.height > 0;
          })()`);
          if (visible) return true;
        }
        return false;
      });
    const vsCodeTitleActionX = (label: string) =>
      application.evaluate(async ({ webContents }, actionLabel) => {
        for (const contents of webContents.getAllWebContents()) {
          if (!contents.getURL().startsWith("http://127.0.0.1:")) continue;
          const x = await contents.executeJavaScript(`document.querySelector(
            '[aria-label*="${actionLabel}"], [title*="${actionLabel}"]',
          )?.getBoundingClientRect().x`);
          if (typeof x === "number") return x;
        }
        return undefined;
      }, label);
    const areVsCodeTitleActionsOrdered = (leftLabel: string, rightLabel: string) =>
      application.evaluate(
        async ({ webContents }, [left, right]) => {
          for (const contents of webContents.getAllWebContents()) {
            if (!contents.getURL().startsWith("http://127.0.0.1:")) continue;
            const ordered = await contents.executeJavaScript(`(() => {
            const left = document.querySelector(
              '[aria-label*="${left}"], [title*="${left}"]',
            );
            const right = document.querySelector(
              '[aria-label*="${right}"], [title*="${right}"]',
            );
            return left instanceof HTMLElement && right instanceof HTMLElement &&
              left.getBoundingClientRect().x < right.getBoundingClientRect().x;
          })()`);
            if (ordered) return true;
          }
          return false;
        },
        [leftLabel, rightLabel],
      );
    const toggleIdeViaMenu = () =>
      application.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu()
          ?.items.flatMap((entry) => entry.submenu?.items ?? [])
          .find((entry) => entry.label === "Toggle Agent / VS Code");
        if (!item) throw new Error("Toggle Agent / VS Code menu item missing");
        item.click({}, undefined);
      });
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
    await expect(page.locator('[data-slot="sidebar"]')).toBeVisible();
    const projectSidebarResize = page.getByRole("separator", { name: "Resize project sidebar" });
    await expect(projectSidebarResize).toHaveAttribute("aria-valuenow", "292");
    await projectSidebarResize.focus();
    await projectSidebarResize.press("ArrowRight");
    await expect(projectSidebarResize).toHaveAttribute("aria-valuenow", "308");
    await expect(page.getByRole("button", { name: "Back to Agent" })).toHaveCount(0);
    await expect
      .poll(() => hasVsCodeTitleAction("Toggle Chat Sidebar"), { timeout: 20_000 })
      .toBe(true);
    await expect.poll(() => hasVsCodeTitleAction("Back to Agent"), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => hasVsCodeTitleAction("Toggle Sessions Sidebar")).toBe(false);
    await expect.poll(isVsCodePrimarySidebarVisible, { timeout: 20_000 }).toBe(false);
    await expect(page.getByRole("button", { name: /Remove src\/modelMeta\.ts/ })).toHaveCount(0);
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
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole("button", { name: "Toggle sidebar" })
      .click();
    await expect.poll(() => hasVsCodeTitleAction("Toggle Sessions Sidebar")).toBe(true);
    await expect
      .poll(() => areVsCodeTitleActionsOrdered("Toggle Sessions Sidebar", "Back to Agent"))
      .toBe(true);
    await expect
      .poll(async () => {
        const x = await vsCodeTitleActionX("Toggle Sessions Sidebar");
        return x === undefined ? Number.POSITIVE_INFINITY : Math.abs(x - 274);
      })
      .toBeLessThan(4);

    expect(await clickVsCodeTitleAction("Back to Agent")).toBe(true);
    await expect(vscodeWorkspace).toBeHidden();
    await expect(page.locator('[data-slot="sidebar"]')).toBeVisible();

    await link.click();
    await expect(vscodeWorkspace).toBeVisible();
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole("button", { name: "Toggle sidebar" })
      .click();
    await expect.poll(() => hasVsCodeTitleAction("Toggle Sessions Sidebar")).toBe(true);
    expect(await clickVsCodeTitleAction("Toggle Sessions Sidebar")).toBe(true);
    await expect(page.locator('[data-slot="sidebar"]')).toBeVisible();
    await expect.poll(() => hasVsCodeTitleAction("Toggle Sessions Sidebar")).toBe(false);
    await expect.poll(() => hasVsCodeText("Build with Agent")).toBe(false);
    await expect
      .poll(() => clickVsCodeText("Cake: Pending · 0 replies"), { timeout: 20_000 })
      .toBe(true);
    await expect(page.getByText("Chat about selection", { exact: true })).toBeVisible();
    await expect(page.getByText("Why is this exported?", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Project chat" }).click();
    expect(await clickVsCodeTitleAction("Toggle Chat Sidebar")).toBe(true);
    await expect.poll(() => hasVsCodeTitleAction("Back to Agent")).toBe(true);
    await toggleIdeViaMenu();
    await expect(vscodeWorkspace).toBeHidden();
    await expect(page.getByText("Phase 4 — Model references")).toBeVisible();
    await expect(agentInput).toHaveValue("Keep this IDE draft");
    await toggleIdeViaMenu();
    await expect(vscodeWorkspace).toBeVisible();
    expect(await clickVsCodeTitleAction("Back to Agent")).toBe(true);

    await emitRendererEvent(application, {
      type: "embedded-editor-entered",
      workspacePath: project,
    });
    await expect(page.getByRole("region", { name: "VS Code workspace" })).toBeVisible();
    expect(await clickVsCodeTitleAction("Back to Agent")).toBe(true);

    await link.click();

    await expect(vscodeWorkspace).toBeVisible();
    await expect
      .poll(() => hasVsCodeTitleAction("Toggle Chat Sidebar"), { timeout: 20_000 })
      .toBe(true);
    const toggleChatSidebar = () =>
      emitRendererEvent(application, {
        type: "embedded-editor-toggle-chat",
        workspacePath: project,
      });
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
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole("button", { name: "Toggle sidebar" })
      .click();
    await expect(page.locator('[data-slot="sidebar"]')).toBeHidden();
    await expect.poll(() => hasVsCodeTitleAction("Toggle Sessions Sidebar")).toBe(true);
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
    const [chatBounds, dialogBounds, imageBounds] = await Promise.all([
      page.locator('aside [data-slot="chat"]').boundingBox(),
      imageDialog.boundingBox(),
      imageDialog.locator("img").boundingBox(),
    ]);
    expect(dialogBounds).toEqual(chatBounds);
    expect(imageBounds!.x).toBeGreaterThanOrEqual(dialogBounds!.x);
    expect(imageBounds!.x + imageBounds!.width).toBeLessThanOrEqual(
      dialogBounds!.x + dialogBounds!.width,
    );
    expect(imageBounds!.y).toBeGreaterThanOrEqual(dialogBounds!.y);
    expect(imageBounds!.y + imageBounds!.height).toBeLessThanOrEqual(
      dialogBounds!.y + dialogBounds!.height,
    );
    await page.getByRole("button", { name: "Close Image 1" }).click();

    const resizeHandle = page.getByRole("separator", { name: "Resize current session sidebar" });
    await expect(resizeHandle).toHaveAttribute("aria-valuenow", "420");
    const resizeBounds = await resizeHandle.boundingBox();
    expect(resizeBounds?.width).toBe(9);
    await page.mouse.move(resizeBounds!.x + 7, resizeBounds!.y + resizeBounds!.height / 2);
    await page.mouse.down();
    await page.mouse.move(resizeBounds!.x + 47, resizeBounds!.y + resizeBounds!.height / 2);
    await page.mouse.up();
    await expect(resizeHandle).toHaveAttribute("aria-valuenow", "380");
    await expect(page.locator("aside")).toHaveCSS("width", "380px");
    await resizeHandle.focus();
    await resizeHandle.press("ArrowLeft");
    await expect(resizeHandle).toHaveAttribute("aria-valuenow", "396");
    const drawerInput = page.getByRole("combobox", { name: "Message" });
    await expect(drawerInput).toHaveValue("Keep this IDE draft");
    await drawerInput.focus();
    await expect(drawerInput).toBeFocused();
    await drawerInput.fill("Chat from the IDE drawer");
    await expect(drawerInput).toHaveValue("Chat from the IDE drawer");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

    await emitRendererEvent(application, {
      type: "embedded-editor-selection",
      workspacePath: project,
      path: "src/modelMeta.ts",
      startLine: 0,
      endLine: 0,
    });
    await expect(page.getByText("src/modelMeta.ts:1", { exact: true })).toBeVisible();
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
