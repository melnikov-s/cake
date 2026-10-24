import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { callRpcHarness, openRpcHarness } from "./rpc-harness";
import { emitRendererEvent } from "./main-harness";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("Quake terminal runs a shell and retains tabs when a Project Session is resolved", async () => {
  test.setTimeout(90_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-terminal-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const sessionId = "terminal-smoke-session";
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const timestamp = new Date(0).toISOString();
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(userData, "window-state.json"),
    windowState({ project, sessionId, theme: "dark" }),
  );
  await mkdir(join(cakeHome, "state"), { recursive: true });
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: project,
          name: "project",
          addedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
        },
      ],
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
          content: [{ type: "text", text: "Test the terminal" }],
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
    await expect(page.getByLabel("Message")).toBeVisible({ timeout: 20_000 });

    // Menu items remain clickable while configurable keyboard shortcuts are
    // handled centrally by the renderer.
    const toggleTerminalViaMenu = () =>
      application.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu()
          ?.items.flatMap((entry) => entry.submenu?.items ?? [])
          .find((entry) => entry.label === "Toggle Terminal");
        if (!item) throw new Error("Toggle Terminal menu item missing");
        item.click({}, undefined);
      });

    const panel = page.locator('section[aria-label="Terminal"]');
    await expect(panel).toHaveAttribute("aria-hidden", "true");
    await toggleTerminalViaMenu();
    await expect(panel).toHaveAttribute("aria-hidden", "false");
    await expect(panel.locator(".xterm-screen:visible")).toBeVisible();
    const terminalRows = panel.locator(".xterm-rows:visible");
    await expect(terminalRows).toHaveCSS("font-size", "14px");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "125%";
    });
    await expect(terminalRows).toHaveCSS("font-size", "17.5px");
    await page.evaluate(() => {
      document.documentElement.style.removeProperty("font-size");
    });
    await expect(terminalRows).toHaveCSS("font-size", "14px");
    await panel.locator(".xterm-screen:visible").click();
    await page.keyboard.type("printf CAKE_TERMINAL_OK");
    await page.keyboard.press("Enter");
    await expect(panel.locator(".xterm-rows:visible")).toContainText("CAKE_TERMINAL_OK", {
      timeout: 10_000,
    });

    await page.keyboard.press("Meta+t");
    await expect(panel.getByRole("tab")).toHaveCount(2);

    await page.getByRole("button", { name: "Pin terminal to bottom" }).click();
    const workspace = page.locator('[data-slot="workspace"]');
    const sidebar = page.locator('[data-slot="sidebar"]');
    const dockedBounds = await panel.boundingBox();
    const workspaceBounds = await workspace.boundingBox();
    const sidebarBounds = await sidebar.boundingBox();
    expect(dockedBounds).not.toBeNull();
    expect(workspaceBounds).not.toBeNull();
    expect(sidebarBounds).not.toBeNull();
    expect(dockedBounds!.x).toBeGreaterThanOrEqual(workspaceBounds!.x);
    expect(dockedBounds!.x).toBeGreaterThanOrEqual(sidebarBounds!.x + sidebarBounds!.width - 1);
    expect(dockedBounds!.width).toBeLessThanOrEqual(workspaceBounds!.width + 1);
    expect(dockedBounds!.y + dockedBounds!.height).toBeLessThanOrEqual(
      workspaceBounds!.y + workspaceBounds!.height + 1,
    );

    await panel.locator(".xterm-screen:visible").click();
    await page.keyboard.press("Meta+t");
    await expect(panel.getByRole("tab")).toHaveCount(3);
    await page.getByRole("button", { name: "Move terminal to top" }).click();
    await expect(page.getByRole("button", { name: "Pin terminal to bottom" })).toBeVisible();

    await toggleTerminalViaMenu();
    await expect(panel).toHaveAttribute("aria-hidden", "true");
    await toggleTerminalViaMenu();
    await expect(panel).toHaveAttribute("aria-hidden", "false");
    await panel.getByRole("tab").first().click();
    await expect(panel.locator(".xterm-rows:visible")).toContainText("CAKE_TERMINAL_OK");

    // Native VS Code must leave the terminal's region clickable, not merely
    // report a visible DOM element underneath its WebContentsView.
    await toggleTerminalViaMenu();
    await emitRendererEvent(application, {
      type: "project-session-control-requested",
      sessionId,
      controlRequestId: crypto.randomUUID(),
      invocation: { _tag: "InvokeAppControl", command: "vscode.enter", input: {} },
    });
    const nativeEditorBounds = () =>
      application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const view = window.contentView.children.find(
          (child) =>
            "webContents" in child && child.webContents.getURL().startsWith("http://127.0.0.1:"),
        );
        return view?.getBounds();
      });
    const editorHostBounds = await page.locator(".embedded-editor-pane").boundingBox();
    await expect.poll(nativeEditorBounds, { timeout: 20_000 }).toEqual({
      x: Math.round(editorHostBounds!.x),
      y: Math.round(editorHostBounds!.y),
      width: Math.round(editorHostBounds!.width),
      height: Math.round(editorHostBounds!.height),
    });
    const originalEditorBounds = await nativeEditorBounds();
    await toggleTerminalViaMenu();
    await expect(panel).toHaveAttribute("aria-hidden", "false");
    const terminalBottom = async () => {
      const bounds = await panel.boundingBox();
      return bounds!.y + bounds!.height;
    };
    await expect
      .poll(async () => (await nativeEditorBounds())!.y - (await terminalBottom()))
      .toBeGreaterThanOrEqual(0);
    await panel.locator(".xterm-screen:visible").click();
    await page.keyboard.type("printf CAKE_TERMINAL_ABOVE_VSCODE");
    await page.keyboard.press("Enter");
    await expect(panel.locator(".xterm-rows:visible")).toContainText("CAKE_TERMINAL_ABOVE_VSCODE");
    const resize = page.getByRole("separator", { name: "Resize terminal" });
    await resize.focus();
    await page.keyboard.press("ArrowDown");
    await expect(resize).toHaveAttribute("aria-valuenow", "376");
    await expect
      .poll(async () => (await nativeEditorBounds())!.y - (await terminalBottom()))
      .toBeGreaterThanOrEqual(0);
    await page.getByRole("button", { name: "Pin terminal to bottom" }).click();
    await expect
      .poll(async () => {
        const editor = (await nativeEditorBounds())!;
        return editor.y + editor.height - (await panel.boundingBox())!.y;
      })
      .toBeLessThanOrEqual(1);
    await page.getByRole("button", { name: "Move terminal to top" }).click();
    await expect
      .poll(async () => (await nativeEditorBounds())!.y - (await terminalBottom()))
      .toBeGreaterThanOrEqual(0);
    await toggleTerminalViaMenu();
    await expect.poll(nativeEditorBounds).toEqual(originalEditorBounds);
    await emitRendererEvent(application, {
      type: "embedded-editor-back-to-agent",
      workspacePath: project,
    });
    await expect(page.getByRole("region", { name: "VS Code workspace" })).toBeHidden();
    await toggleTerminalViaMenu();

    await panel.getByRole("tab").last().click();
    await panel.locator(".xterm-screen:visible").click();
    await page.keyboard.type("sleep 60");
    await page.keyboard.press("Enter");
    await expect(panel.locator(".xterm-rows:visible")).toContainText("sleep 60");
    await page.waitForTimeout(250);
    await toggleTerminalViaMenu();
    await expect(panel).toHaveAttribute("aria-hidden", "true");
    const resolveAction = page.locator(
      `.session-item[data-session-id='${sessionId}'] .session-resolve-action`,
    );
    await resolveAction.click();
    await expect(page.getByText(/Retire and stop running programs?\?/)).toHaveCount(0);
    await page.getByRole("button", { name: "Expand Resolved" }).click();
    await page.getByRole("button", { name: "Expand project resolved" }).last().click();
    const resolvedSession = page.locator(
      `[data-slot="resolved-lane"] .session-item[data-session-id="${sessionId}"]`,
    );
    await expect(resolvedSession.locator(".session-resolve-action")).toHaveAttribute(
      "aria-label",
      /^Restore /,
    );
    await resolvedSession.locator(".session-resolve-action").click();
    await page.locator(`.session-item[data-session-id="${sessionId}"] .session-row`).click();

    await toggleTerminalViaMenu();
    await expect(panel.getByRole("tab")).toHaveCount(3);
    for (let index = 0; index < 3; index++) {
      await panel.getByRole("tab").nth(index).click();
      await panel.locator(".xterm-screen:visible").click();
      await page.keyboard.press("Control+C");
    }
    await page.keyboard.type("printf CAKE_TERMINAL_IDLE");
    await page.keyboard.press("Enter");
    await expect(panel.locator(".xterm-rows:visible")).toContainText("CAKE_TERMINAL_IDLE");

    // Retirement inspects and closes all windows, even after external checkout removal.
    const otherWindow = await openRpcHarness(application, "terminal-retirement");
    const otherTerminal = await callRpcHarness<{ terminalId: string }>(
      otherWindow,
      "invokeNative",
      {
        type: "open-terminal",
        requestId: crypto.randomUUID(),
        target: { workingDirectory: project },
        cols: 80,
        rows: 24,
      },
    );
    await callRpcHarness(otherWindow, "invokeNative", {
      type: "write-terminal",
      requestId: crypto.randomUUID(),
      terminalId: otherTerminal.terminalId,
      data: "sleep 60\r",
    });
    await panel.locator(".xterm-screen:visible").click();
    await page.keyboard.type("sleep 60");
    await page.keyboard.press("Enter");
    const runningProgramCount = async () =>
      (
        await callRpcHarness<{ runningProgramCount: number }>(otherWindow, "invokeNative", {
          type: "get-terminal-status",
          requestId: crypto.randomUUID(),
          workingDirectory: project,
        })
      ).runningProgramCount;
    await expect.poll(runningProgramCount).toBe(2);
    await rm(project, { recursive: true, force: true });
    await expect.poll(runningProgramCount).toBe(2);
    await callRpcHarness(otherWindow, "invokeNative", {
      type: "close-working-directory-terminals",
      requestId: crypto.randomUUID(),
      workingDirectory: project,
    });
    await expect.poll(runningProgramCount).toBe(0);
    await expect(panel.getByText(/Shell exited/)).toHaveCount(3);
    await expect(panel.getByText(/Shell exited/).filter({ visible: true })).toBeVisible();
    await expect(
      callRpcHarness(otherWindow, "invokeNative", {
        type: "write-terminal",
        requestId: crypto.randomUUID(),
        terminalId: otherTerminal.terminalId,
        data: "echo SHOULD_NOT_RUN\r",
      }),
    ).rejects.toThrow();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
