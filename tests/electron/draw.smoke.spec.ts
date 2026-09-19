import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const sessionId = "draw-smoke-session";

async function launchFixture(root: string, initialize = true) {
  const userData = join(root, "user-data");
  const project = join(root, "project");
  const cakeHome = join(root, "cake-home");
  const sessionDirectory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const timestamp = new Date(0).toISOString();
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
  if (initialize) {
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
            content: [{ type: "text", text: "Use the whiteboard" }],
            timestamp: 0,
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
  }
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
  return { application };
}

test("Cake Draw preserves chat and its session board through Electron", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-draw-smoke-"));
  let application: ElectronApplication | undefined;
  try {
    ({ application } = await launchFixture(temporaryRoot));
    const page = await application.firstWindow();
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Open Cake Draw" }).click();
    await expect(page.getByRole("region", { name: "Cake Draw whiteboard" })).toBeVisible({
      timeout: 20_000,
    });
    const canvas = page.locator(".excalidraw__canvas.interactive");
    await expect(canvas).toBeVisible();
    const drawWorkspace = page.getByRole("region", { name: "Cake Draw whiteboard" });
    await expect(drawWorkspace.locator(".main-menu-trigger")).toBeHidden();
    await expect(drawWorkspace.locator(".default-sidebar-trigger")).toBeHidden();

    await page.getByRole("button", { name: "Toggle sidebar" }).click();
    const collapsedSidebarToggle = page.locator(
      '[aria-label="Cake Draw whiteboard"] [data-slot="header-sidebar-toggle"]',
    );
    await expect(collapsedSidebarToggle).toBeVisible();
    expect((await collapsedSidebarToggle.boundingBox())?.x).toBeGreaterThanOrEqual(84);
    await expect(page.getByRole("button", { name: "Go back in session history" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Go forward in session history" })).toBeVisible();
    await collapsedSidebarToggle.click();

    await composer.click();
    await expect(composer).toBeFocused();
    await page.keyboard.type("Retained Draw draft");
    await expect(composer).toHaveValue("Retained Draw draft");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

    const box = await canvas.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y };
    });
    await page.getByRole("radio", { name: "Draw", exact: true }).click({ force: true });
    await page.mouse.move(box.x + 180, box.y + 170);
    await page.mouse.down();
    await page.mouse.move(box.x + 240, box.y + 220, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled();

    await expect(composer).toHaveValue("Retained Draw draft");
    await page.getByRole("button", { name: "Back to agent" }).click();
    await expect(page.getByRole("button", { name: "Open Cake Draw" })).toBeVisible();
    await page.getByRole("button", { name: "Open Cake Draw" }).click();
    await expect(canvas).toBeVisible();
    await canvas.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
    await page.keyboard.press("Backspace");
    await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");

    await application.close();
    application = undefined;

    const boardDirectory = join(temporaryRoot, "cake-home", "state", "draw-boards", "boards");
    const boardFiles = await readdir(boardDirectory);
    expect(boardFiles).toHaveLength(1);
    const persistedBoard = JSON.parse(await readFile(join(boardDirectory, boardFiles[0]!), "utf8"));
    expect(persistedBoard.data.snapshot.elements.length).toBeGreaterThan(0);

    ({ application } = await launchFixture(temporaryRoot, false));
    const reopened = await application.firstWindow();
    await expect(reopened.getByRole("combobox", { name: "Message", exact: true })).toBeVisible({
      timeout: 20_000,
    });
    const reopenedDraw = reopened.getByRole("region", { name: "Cake Draw whiteboard" });
    if (!(await reopenedDraw.isVisible()))
      await reopened.getByRole("button", { name: "Open Cake Draw" }).click();
    const reopenedCanvas = reopened.locator(".excalidraw__canvas.interactive");
    await expect(reopenedCanvas).toBeVisible();
    await reopenedCanvas.click();
    await reopened.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
    await reopened.keyboard.press("Backspace");
    await expect(reopened.getByRole("button", { name: "Undo" })).toBeEnabled();
  } finally {
    await application?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Cake Draw native drawing supports one-step undo in Electron", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-draw-undo-smoke-"));
  let application: ElectronApplication | undefined;
  try {
    ({ application } = await launchFixture(temporaryRoot));
    const page = await application.firstWindow();
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Open Cake Draw" }).click();
    const canvas = page.locator(".excalidraw__canvas.interactive");
    await expect(canvas).toBeVisible({ timeout: 20_000 });
    const box = await canvas.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y };
    });
    await page.getByRole("radio", { name: "Rectangle", exact: true }).click({ force: true });
    await page.mouse.move(box.x + 140, box.y + 140);
    await page.mouse.down();
    await page.mouse.move(box.x + 260, box.y + 220, { steps: 4 });
    await page.mouse.up();
    await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled();

    await canvas.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    await expect(page.getByRole("button", { name: "Redo" })).toBeEnabled();
  } finally {
    await application?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
