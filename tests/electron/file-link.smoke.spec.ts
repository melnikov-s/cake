import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";
import { openSessionById } from "./fixtures/workspace-navigation";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("a file-path link opens IDE mode with VS Code and the shared Cake chat drawer", async () => {
  test.setTimeout(90_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-file-link-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "7a4eb006-211d-42c9-8023-7ce16414e89c";
  const reviewThreadId = "vscode-annotation-thread";
  const timestamp = new Date(0).toISOString();
  const imageData = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"><rect width="1600" height="1200" fill="red"/></svg>',
  ).toString("base64");
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const reviewDirectory = join(cakeHome, "state", "reviews", digest(project), digest(sessionId));
  // A code-review thread is an ordinary side chat: its transcript is a Pi sidecar.
  const sidecarSessionId = "vscode-annotation-sidecar";
  const sidecarDirectory = join(
    cakeHome,
    "pi",
    "review-sessions",
    digest(project),
    digest(sessionId),
    digest(reviewThreadId),
  );
  const sidecarFile = join(sidecarDirectory, `1970-01-01T00-00-00-000Z_${sidecarSessionId}.jsonl`);

  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(join(project, "src"), { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
    mkdir(sidecarDirectory, { recursive: true }),
    mkdir(reviewDirectory, { recursive: true }),
  ]);
  await writeFile(join(project, "src", "modelMeta.ts"), "export const meta = 1;\n");
  await writeFile(
    join(userData, "window-state.json"),
    windowState({ project, sessionId, theme: "dark" }),
  );
  await mkdir(join(cakeHome, "state"), { recursive: true });
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
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
      agentSessionId: sidecarSessionId,
      agentSessionFile: sidecarFile,
      pendingComments: [],
      status: "open",
      createdAt: timestamp,
      updatedAt: timestamp,
    })}\n`,
  );
  await writeFile(
    sidecarFile,
    [
      { type: "session", version: 3, id: sidecarSessionId, timestamp, cwd: project },
      {
        type: "message",
        id: "annotation-question",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Why is this exported?" }],
          timestamp: 0,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
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
              text:
                `Phase 4 — Model references ([\`src/modelMeta.ts#L1\`](src/modelMeta.ts#L1)) is done. Read [the website](https://example.com/docs "Authored title") or [this session](cake://session/${sessionId}).\n\n` +
                "The model metadata lives alongside the application contract so every caller can inspect the same provider and model identity. The desktop presents this source through the embedded editor while the conversation remains authoritative in Pi. Review the associated definitions before changing the configuration, and keep the current chat draft when moving between the editor and agent views. ".repeat(
                  14,
                ),
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
      PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });

  try {
    const page = await application.firstWindow();
    // Launch starts in global Cake Chat (40566199); open the seeded image-led Session.
    await openSessionById(page, sessionId);
    const link = page.locator('a[href="src/modelMeta.ts#L1"]');
    await expect(link).toHaveText("src/modelMeta.ts#L1");
    // A freshly opened transcript can still emit a settling scroll, which dismisses a pending
    // tooltip by design. Re-hover as a reader would until the destination tooltip shows.
    const hoverTooltip = async (target: typeof link, text: string | RegExp) =>
      expect(async () => {
        await page.mouse.move(1, 1);
        await target.hover();
        await expect(page.getByRole("tooltip")).toHaveText(text, { timeout: 1_500 });
      }).toPass({ timeout: 15_000 });
    await hoverTooltip(link, "src/modelMeta.ts#L1");
    await expect(link).toHaveAccessibleDescription("src/modelMeta.ts#L1");
    const websiteLink = page.getByRole("link", { name: "the website" });
    await hoverTooltip(websiteLink, "https://example.com/docs");
    await expect(websiteLink).toHaveAccessibleDescription("https://example.com/docs");
    const sessionLink = page.getByRole("link", { name: "this session" });
    // Session links describe their label, the Session's title and then the reference (5c284c46).
    const sessionDescription = new RegExp(`^this session.+cake://session/${sessionId}$`, "s");
    await hoverTooltip(sessionLink, sessionDescription);
    await expect(sessionLink).toHaveAccessibleDescription(sessionDescription);
    const presentation = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      return { color: style.color, decoration: style.textDecorationLine };
    };
    const filePresentation = await link.evaluate(presentation);
    expect(filePresentation.decoration).toBe("underline");
    expect(await websiteLink.evaluate(presentation)).toEqual(filePresentation);
    // Session links render as named pills rather than underlined prose (5c284c46).
    expect(await sessionLink.evaluate(presentation)).toMatchObject({ decoration: "none" });
    const agentInput = page.getByRole("combobox", { name: "Message" });
    // The embedded editor is a separate WebContentsView. Its own content is not part of
    // the Cake page, so these checks read the view's geometry from the main process only.
    const vscodeView = () =>
      application.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const view = window?.contentView.children.find((child) =>
          child.webContents.getURL().startsWith("http://127.0.0.1:"),
        );
        if (!window || !view) return { visible: false, width: 0 };
        return { visible: view.getVisible(), width: view.getBounds().width };
      });
    const vscodeIsVisible = async () => (await vscodeView()).visible;

    await agentInput.click();
    await agentInput.pressSequentially("Keep this IDE draft");
    await expect(agentInput).toHaveValue("Keep this IDE draft");
    await link.click();
    const vscodeWorkspace = page.getByRole("region", { name: "VS Code workspace" });
    await expect(vscodeWorkspace).toBeVisible();
    await expect(page.getByRole("button", { name: "VS Code", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect.poll(vscodeIsVisible, { timeout: 20_000 }).toBe(true);
    // A healthy editor has no status/error placeholder.
    await expect(page.locator(".embedded-editor-pane")).toBeEmpty();
    // VS Code mode keeps the conversation in a companion beside the editor; the Workspace
    // navigator was replaced by its Chat / Todos / Sessions tabs.
    const companion = page.getByRole("complementary", {
      name: "Current conversation companion",
    });
    await expect(companion).toBeVisible();
    const companionTabs = companion.getByRole("group", { name: "Companion content" });
    await expect(companionTabs.getByRole("button", { name: "Chat", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const drawerInput = companion.getByRole("combobox", { name: "Message" });
    await expect(drawerInput).toHaveValue("Keep this IDE draft");
    // The opened file is the editor selection the next message refers to.
    await expect(
      companion.getByRole("button", { name: "Reveal src/modelMeta.ts:1:1", exact: true }),
    ).toBeVisible();
    await expect(companion.getByText(/Phase 4 — Model references/)).toBeVisible();

    // Closing the Workspace gives the editor the companion's width (inside the window's soft
    // inset, c7c99e7f); opening it restores the companion and the in-progress draft.
    const editorWithCompanion = (await vscodeView()).width!;
    await page.getByRole("button", { name: "Close Workspace", exact: true }).click();
    await expect(companion).toBeHidden();
    await expect
      .poll(async () => (await vscodeView()).width!)
      .toBeGreaterThan(editorWithCompanion + 200);
    await page.getByRole("button", { name: "Open Workspace", exact: true }).click();
    await expect(companion).toBeVisible();
    await expect(drawerInput).toHaveValue("Keep this IDE draft");
    await expect.poll(async () => (await vscodeView()).width).toBe(editorWithCompanion);

    // Main returns to the agent conversation with the same draft; the file link reopens VS Code.
    await page.getByRole("button", { name: "Main", exact: true }).click();
    await expect(vscodeWorkspace).toBeHidden();
    await expect.poll(vscodeIsVisible).toBe(false);
    await expect(page.locator(".transcript").getByText(/Phase 4 — Model references/)).toBeVisible();
    await expect(agentInput).toHaveValue("Keep this IDE draft");
    await page.getByRole("button", { name: "VS Code", exact: true }).click();
    await expect(vscodeWorkspace).toBeVisible();
    await expect(companion).toBeVisible();
    await expect.poll(vscodeIsVisible).toBe(true);

    // Fullscreen message and image surfaces cover the native editor view while open.
    const response = companion.locator("article").filter({ hasText: "Phase 4" }).last();
    await response.hover();
    await companion.getByRole("button", { name: "View response fullscreen" }).click();
    const messageDialog = page.getByRole("dialog", { name: "Cake" });
    await expect(messageDialog).toBeVisible();
    await expect.poll(vscodeIsVisible).toBe(false);
    await page.getByRole("button", { name: "Exit fullscreen Cake" }).click();
    await expect.poll(vscodeIsVisible).toBe(true);

    const imagePreview = companion.getByRole("button", { name: "View Image 1 enlarged" });
    await imagePreview.click();
    const imageDialog = page.getByRole("dialog", { name: "Image 1" });
    await expect(imageDialog).toBeVisible();
    await expect.poll(vscodeIsVisible).toBe(false);
    const [dialogBounds, imageBounds, viewport] = await Promise.all([
      imageDialog.boundingBox(),
      imageDialog.locator("img").boundingBox(),
      page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
    ]);
    // Fullscreen presentations fill the shell beside the navigation rail (37b915559).
    const rail = await page
      .getByRole("navigation", { name: "Projects and global utilities" })
      .boundingBox();
    expect(dialogBounds).toEqual({
      x: rail!.x + rail!.width,
      y: 0,
      width: viewport.width - rail!.x - rail!.width,
      height: viewport.height,
    });
    expect(imageBounds!.x).toBeGreaterThanOrEqual(dialogBounds!.x);
    expect(imageBounds!.x + imageBounds!.width).toBeLessThanOrEqual(
      dialogBounds!.x + dialogBounds!.width,
    );
    expect(imageBounds!.y).toBeGreaterThanOrEqual(dialogBounds!.y);
    expect(imageBounds!.y + imageBounds!.height).toBeLessThanOrEqual(
      dialogBounds!.y + dialogBounds!.height,
    );
    await page.getByRole("button", { name: "Exit fullscreen Image 1" }).click();
    await expect.poll(vscodeIsVisible).toBe(true);

    // The companion resizes by pointer drag and by keyboard on its separator, keeping the
    // assistant and the draft at every width while the editor takes the remaining space.
    const resizeHandle = page.getByRole("separator", { name: "Resize current session sidebar" });
    const composerAvatar = companion.locator(
      '[data-slot="composer-leading-accessory"] [data-slot="avatar"]',
    );
    await expect(composerAvatar).toBeVisible();
    const startWidth = Number(await resizeHandle.getAttribute("aria-valuenow"));
    const editorWidth = (await vscodeView()).width!;
    const resizeBounds = (await resizeHandle.boundingBox())!;
    await page.mouse.move(
      resizeBounds.x + resizeBounds.width / 2,
      resizeBounds.y + resizeBounds.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      resizeBounds.x + resizeBounds.width / 2 + 40,
      resizeBounds.y + resizeBounds.height / 2,
      { steps: 4 },
    );
    await page.mouse.up();
    await expect(resizeHandle).toHaveAttribute("aria-valuenow", String(startWidth - 40));
    await expect.poll(async () => (await vscodeView()).width).toBe(editorWidth + 40);
    await expect(composerAvatar).toBeVisible();
    // Keyboard users reach the separator just before the companion's first control.
    const chatTab = companionTabs.getByRole("button", { name: "Chat", exact: true });
    await chatTab.click();
    await expect(chatTab).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(resizeHandle).toBeFocused();
    await resizeHandle.press("ArrowLeft");
    await expect(resizeHandle).toHaveAttribute("aria-valuenow", String(startWidth - 40 + 16));
    await expect(composerAvatar).toBeVisible();
    await resizeHandle.press("Home");
    const minimumWidth = Number(await resizeHandle.getAttribute("aria-valuenow"));
    expect(minimumWidth).toBeLessThan(startWidth - 40);
    await expect(composerAvatar).toBeVisible();
    await expect(drawerInput).toHaveValue("Keep this IDE draft");
    await drawerInput.click();
    await expect(drawerInput).toBeFocused();
    await drawerInput.press("ControlOrMeta+A");
    await drawerInput.pressSequentially("Chat from the IDE drawer");
    await expect(drawerInput).toHaveValue("Chat from the IDE drawer");
    await expect(companion.getByRole("button", { name: "Send" })).toBeEnabled();

    const assistantTrigger = companion.getByRole("button", { name: "Ask session assistant" });
    await assistantTrigger.click();
    const quickAssistant = page.getByRole("dialog", { name: "Quick session assistant" });
    await expect(quickAssistant.getByLabel("Ask session assistant")).toBeFocused();
    const [drawerBounds, assistantBounds] = await Promise.all([
      companion.boundingBox(),
      quickAssistant.boundingBox(),
    ]);
    expect(assistantBounds!.x).toBeGreaterThanOrEqual(drawerBounds!.x + 8);
    expect(assistantBounds!.x + assistantBounds!.width).toBeLessThanOrEqual(
      drawerBounds!.x + drawerBounds!.width - 8,
    );
    await page.keyboard.press("Escape");
    await expect(quickAssistant).toHaveCount(0);

    await page.getByRole("button", { name: "Main", exact: true }).click();
    await expect(vscodeWorkspace).toBeHidden();
    await expect(page.getByText("Phase 4 — Model references")).toBeVisible();
    await expect(agentInput).toHaveValue("Chat from the IDE drawer");
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
