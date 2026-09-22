import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import type {
  DrawControlInvocation,
  DrawControlResponse,
} from "../../src/domain/draw/draw-control";
import type { DrawScene } from "../../src/domain/draw/draw-editor";

async function drawControl(application: ElectronApplication, invocation: DrawControlInvocation) {
  const response = await application.evaluate(
    async (_electron, input) => {
      const control = Reflect.get(globalThis, "cakeSmokeDrawControl") as (
        sessionId: string,
        invocation: DrawControlInvocation,
      ) => Promise<DrawControlResponse>;
      return control(input.sessionId, input.invocation);
    },
    { sessionId, invocation },
  );
  if (!response.ok) throw new Error(`${response.code}: ${response.message}`);
  return response;
}

function expectContained(scene: DrawScene) {
  expect(scene.shapes.length).toBeGreaterThan(0);
  const viewport = scene.viewportBounds;
  for (const shape of scene.shapes) {
    const bounds = shape.bounds!;
    expect(bounds.x, shape.id).toBeGreaterThan(viewport.x);
    expect(bounds.y, shape.id).toBeGreaterThan(viewport.y);
    expect(bounds.x + bounds.width, shape.id).toBeLessThan(viewport.x + viewport.width);
    expect(bounds.y + bounds.height, shape.id).toBeLessThan(viewport.y + viewport.height);
  }
}

const repositoryRoot = resolve(import.meta.dirname, "../..");
const sessionId = "draw-smoke-session";

async function mockNextSave(application: ElectronApplication, filePath: string) {
  await application.evaluate(({ dialog }, target) => {
    Object.defineProperty(dialog, "showSaveDialog", {
      configurable: true,
      value: async () => ({ canceled: false, filePath: target }),
    });
  }, filePath);
}

async function launchFixture(
  root: string,
  initialize = true,
  seedLayeringBoard = false,
  theme = seedLayeringBoard ? "light" : "dark",
) {
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
        theme,
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
    if (seedLayeringBoard) {
      const boardId = "00000000-0000-4000-8000-000000000001";
      const board = {
        id: boardId,
        sessionId,
        title: "Connector layering",
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const drawRoot = join(cakeHome, "state", "draw-boards");
      const snapshot = JSON.parse(
        await readFile(
          join(repositoryRoot, "tests/fixtures/draw-connector-layering.snapshot.json"),
          "utf8",
        ),
      );
      await mkdir(join(drawRoot, "boards"), { recursive: true });
      await Promise.all([
        writeFile(
          join(drawRoot, "catalog.json"),
          `${JSON.stringify({ version: 1, boards: [board] }, null, 2)}\n`,
        ),
        writeFile(
          join(drawRoot, "boards", `${boardId}.json`),
          `${JSON.stringify({ version: 1, data: { board, snapshot } })}\n`,
        ),
      ]);
    }
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

test("Cake Draw compact authoring preserves native edits, frames, receipts, and undo", async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-draw-authoring-"));
  const { application } = await launchFixture(root);
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Open Cake Draw" }).click();
    const canvas = page.locator(".excalidraw__canvas.interactive");
    await expect(canvas).toBeVisible({ timeout: 20_000 });
    const first = await drawControl(application, {
      _tag: "Apply",
      operations: [
        {
          type: "flow",
          nodes: [
            { id: "shape:request", text: "Request" },
            { id: "shape:service", text: "Service" },
          ],
          frame: { id: "shape:runtime", title: "Runtime" },
        },
      ],
    });
    if (first.kind !== "applied") throw new Error("Expected Apply receipt");
    expectContained(first.scene);
    expect(first.receipt.layout).toHaveLength(4);
    expect(first.scene.shapes.filter(({ frameId }) => frameId === "shape:runtime")).toHaveLength(3);
    const node = first.scene.shapes.find(({ id }) => id === "shape:request")!;
    const box = (await canvas.boundingBox())!;
    const scale = box.width / first.scene.viewportBounds.width;
    const x = box.x + (node.bounds!.x - first.scene.viewportBounds.x + 12) * scale;
    const y = box.y + (node.bounds!.y - first.scene.viewportBounds.y + 12) * scale;
    // Real native pointer edit, not a test-only scene patch.
    await page.mouse.click(box.x + 10, box.y + 10);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 24, y + 12, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(async () => {
        const read = await drawControl(application, { _tag: "Read", scope: "page" });
        if (read.kind !== "read") throw new Error("Expected scene");
        return read.scene.shapes.find(({ id }) => id === node.id)!.bounds!.x;
      })
      .not.toBe(node.bounds!.x);
    const edited = await drawControl(application, { _tag: "Read", scope: "page" });
    if (edited.kind !== "read") throw new Error("Expected edited scene");
    const extension = await drawControl(application, {
      _tag: "Apply",
      operations: [
        {
          type: "flow",
          nodes: [{ id: "shape:storage", text: "Storage" }],
          placement: { relativeTo: "shape:runtime", side: "below" },
        },
      ],
    });
    if (extension.kind !== "applied") throw new Error("Expected Apply receipt");
    for (const shape of edited.scene.shapes)
      expect(extension.scene.shapes.find(({ id }) => id === shape.id)).toEqual(shape);
    const frame = edited.scene.shapes.find(({ id }) => id === "shape:runtime")!;
    expect(extension.receipt.layout![0]!.bounds.y).toBeCloseTo(
      frame.bounds!.y + frame.bounds!.height + 80,
    );
    const directory = join(root, "cake-home", "state", "draw-boards", "boards");
    const file = (await readdir(directory))[0]!;
    const saved = JSON.parse(await readFile(join(directory, file), "utf8")).data.snapshot;
    expect(saved.elements.some((element: { id: string }) => element.id === "shape:storage")).toBe(
      true,
    );
    await drawControl(application, { _tag: "Undo", checkpointId: extension.checkpointId });
    const undone = await drawControl(application, { _tag: "Read", scope: "page" });
    if (undone.kind !== "read") throw new Error("Expected restored scene");
    expect(undone.scene.shapes).toEqual(edited.scene.shapes);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const windowWidth of [1024, 1440]) {
  test(`Cake Draw fits and renders the actual viewport at window width ${windowWidth}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-draw-framing-"));
    const { application } = await launchFixture(root, true, false, "light");
    try {
      const page = await application.firstWindow();
      await application.evaluate(({ BrowserWindow }, width) => {
        BrowserWindow.getAllWindows()[0]!.setContentSize(width, 900);
      }, windowWidth);
      await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await page.getByRole("button", { name: "Open Cake Draw" }).click();
      const canvas = page.locator(".excalidraw__canvas.interactive");
      await expect(canvas).toBeVisible({ timeout: 20_000 });
      const applied = await drawControl(application, {
        _tag: "Apply",
        operations: [
          {
            type: "create",
            shape: {
              id: "shape:cake",
              type: "geo",
              x: 80,
              y: 80,
              width: 240,
              height: 120,
              text: "Cake",
              color: "light-blue",
              fill: "solid",
            },
          },
          {
            type: "create-relative",
            shape: {
              id: "shape:pi",
              type: "geo",
              width: 240,
              height: 120,
              text: "Pi",
              color: "light-green",
              fill: "solid",
              placement: { relativeTo: "shape:cake", side: "right", gap: 280 },
            },
          },
          { type: "connect", id: "shape:link", fromId: "shape:cake", toId: "shape:pi" },
          { type: "style", ids: ["shape:link"], style: { startArrowhead: "arrow" } },
        ],
      });
      if (!("scene" in applied)) throw new Error("Expected completed scene");
      expect(applied.scene.shapes).toHaveLength(3);
      expectContained(applied.scene);
      const boardDirectory = join(root, "cake-home", "state", "draw-boards", "boards");
      const boardFile = (await readdir(boardDirectory))[0]!;
      const saved = JSON.parse(await readFile(join(boardDirectory, boardFile), "utf8")).data
        .snapshot;
      expect(saved.appState.scrollX).toBeCloseTo(-applied.scene.viewportBounds.x);
      expect(saved.appState.scrollY).toBeCloseTo(-applied.scene.viewportBounds.y);
      const read = await drawControl(application, { _tag: "Read", scope: "page" });
      if (!("scene" in read)) throw new Error("Expected scene");
      expectContained(read.scene);

      const viewport = await drawControl(application, {
        _tag: "Render",
        scope: "viewport",
        format: "png",
      });
      if (!("render" in viewport)) throw new Error("Expected render");
      const box = (await canvas.boundingBox())!;
      expect(Math.abs(viewport.render.width - box.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(viewport.render.height - box.height)).toBeLessThanOrEqual(1);
      // Compare the tool's raster with the real canvas, not another fitted export.
      const pixels = await page
        .locator(".excalidraw__canvas.static")
        .evaluate(async (element: HTMLCanvasElement, data) => {
          const image = new Image();
          image.src = data;
          await image.decode();
          const actual = document.createElement("canvas");
          actual.width = image.width;
          actual.height = image.height;
          const context = actual.getContext("2d")!;
          context.drawImage(element, 0, 0, actual.width, actual.height);
          const screen = context.getImageData(0, 0, actual.width, actual.height).data;
          context.clearRect(0, 0, actual.width, actual.height);
          context.drawImage(image, 0, 0);
          const rendered = context.getImageData(0, 0, actual.width, actual.height).data;
          let mismatches = 0;
          for (let i = 0; i < screen.length; i += 4) {
            if (
              Math.abs(screen[i]! - rendered[i]!) +
                Math.abs(screen[i + 1]! - rendered[i + 1]!) +
                Math.abs(screen[i + 2]! - rendered[i + 2]!) >
              90
            )
              mismatches++;
          }
          return mismatches / (actual.width * actual.height);
        }, viewport.render.data);
      expect(pixels).toBeLessThan(0.025);

      // Explicit focus wins, and viewport renders retain the crop instead of refitting the other node.
      await drawControl(application, {
        _tag: "Apply",
        operations: [{ type: "zoom-to", ids: ["shape:cake"] }],
      });
      const focused = await drawControl(application, { _tag: "Read", scope: "viewport" });
      if (!("scene" in focused)) throw new Error("Expected scene");
      expect(focused.scene.shapes.some(({ id }) => id === "shape:cake")).toBe(true);
      const cropped = await drawControl(application, {
        _tag: "Render",
        scope: "viewport",
        format: "svg",
      });
      if (!("render" in cropped)) throw new Error("Expected render");
      expect(cropped.render.width).toBe(viewport.render.width);
      expect(cropped.render.height).toBe(viewport.render.height);
    } finally {
      await application.close();
      await rm(root, { recursive: true, force: true });
    }
  });
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

    const pngPath = join(temporaryRoot, "board.png");
    await mockNextSave(application, pngPath);
    await page.getByRole("button", { name: "Export Cake Draw board" }).click();
    await page.getByRole("menuitem", { name: "PNG image" }).click();
    await expect(page.getByRole("status")).toContainText("Exported PNG");
    expect([...(await readFile(pngPath))].slice(0, 8)).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);

    const svgPath = join(temporaryRoot, "board.svg");
    await mockNextSave(application, svgPath);
    await page.getByRole("button", { name: "Export Cake Draw board" }).click();
    await page.getByRole("menuitem", { name: "SVG image" }).click();
    await expect(page.getByRole("status")).toContainText("Exported SVG");
    expect(await readFile(svgPath, "utf8")).toContain("<svg");

    const excalidrawPath = join(temporaryRoot, "board.excalidraw");
    await mockNextSave(application, excalidrawPath);
    await page.getByRole("button", { name: "Export Cake Draw board" }).click();
    await page.getByRole("menuitem", { name: "Editable Excalidraw" }).click();
    await expect(page.getByRole("status")).toContainText("Exported EXCALIDRAW");
    const exportedDocument = JSON.parse(await readFile(excalidrawPath, "utf8"));
    expect(exportedDocument.type).toBe("excalidraw");
    expect(exportedDocument.elements.length).toBeGreaterThan(0);
    expect(exportedDocument.files).toEqual({});

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

test("Cake Draw masks agent connectors beneath opaque nodes while keeping edge labels visible", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-draw-layering-smoke-"));
  let application: ElectronApplication | undefined;
  try {
    ({ application } = await launchFixture(temporaryRoot, true, true));
    const page = await application.firstWindow();
    await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Open Cake Draw" }).click();
    const canvas = page.locator(".excalidraw__canvas.interactive");
    await expect(canvas).toBeVisible({ timeout: 20_000 });
    const renderedCanvas = page.locator(".excalidraw__canvas.static");
    await expect(renderedCanvas).toBeVisible();
    await page.waitForFunction(() => document.fonts.status === "loaded");

    const rendering = await renderedCanvas.evaluate((element: HTMLCanvasElement) => {
      const context = element.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Cake Draw canvas did not expose a 2D context");
      const { width, height } = element;
      const pixels = context.getImageData(0, 0, width, height).data;
      const closeTo = (offset: number, target: readonly [number, number, number]) =>
        Math.abs(pixels[offset]! - target[0]) <= 12 &&
        Math.abs(pixels[offset + 1]! - target[1]) <= 12 &&
        Math.abs(pixels[offset + 2]! - target[2]) <= 12 &&
        pixels[offset + 3]! > 200;
      const boundsFor = (target: readonly [number, number, number]) => {
        let minX = width;
        let minY = height;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            if (!closeTo((y * width + x) * 4, target)) continue;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
        }
        return { minX, minY, maxX, maxY };
      };
      const blue = boundsFor([77, 171, 247]);
      const green = boundsFor([105, 219, 124]);
      if (blue.maxX < 0 || green.maxX < 0) {
        const colors = new Map<string, number>();
        for (let offset = 0; offset < pixels.length; offset += 64) {
          const key = `${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]},${pixels[offset + 3]}`;
          colors.set(key, (colors.get(key) ?? 0) + 1);
        }
        return {
          foundNodes: false,
          blueInteriorIsFill: false,
          greenInteriorIsFill: false,
          connectorPixels: 0,
          labelPixelsAwayFromStroke: 0,
          topColors: [...colors].toSorted((left, right) => right[1] - left[1]).slice(0, 10),
        };
      }
      const centerY = Math.round((blue.minY + blue.maxY) / 2);
      const isDark = (x: number, y: number) => {
        const offset = (y * width + x) * 4;
        return (
          pixels[offset]! < 90 &&
          pixels[offset + 1]! < 90 &&
          pixels[offset + 2]! < 90 &&
          pixels[offset + 3]! > 150
        );
      };
      const blueInteriorIsFill = closeTo(
        (centerY * width + Math.round(blue.minX + (blue.maxX - blue.minX) * 0.2)) * 4,
        [77, 171, 247],
      );
      const greenInteriorIsFill = closeTo(
        (centerY * width + Math.round(green.minX + (green.maxX - green.minX) * 0.8)) * 4,
        [105, 219, 124],
      );
      const gapStart = blue.maxX + 3;
      const gapEnd = green.minX - 3;
      let connectorPixels = 0;
      let labelPixelsAwayFromStroke = 0;
      const labelCenter = Math.round((gapStart + gapEnd) / 2);
      for (let y = centerY - 24; y <= centerY + 24; y += 1) {
        for (let x = gapStart; x <= gapEnd; x += 1) {
          if (!isDark(x, y)) continue;
          if (Math.abs(y - centerY) <= 3) connectorPixels += 1;
          if (Math.abs(x - labelCenter) <= 55 && Math.abs(y - centerY) >= 6)
            labelPixelsAwayFromStroke += 1;
        }
      }
      return {
        foundNodes: true,
        blueInteriorIsFill,
        greenInteriorIsFill,
        connectorPixels,
        labelPixelsAwayFromStroke,
        topColors: [] as [string, number][],
      };
    });

    expect(rendering.foundNodes, JSON.stringify(rendering)).toBe(true);
    expect(rendering).toMatchObject({
      foundNodes: true,
      blueInteriorIsFill: true,
      greenInteriorIsFill: true,
    });
    expect(rendering.connectorPixels).toBeGreaterThan(20);
    expect(rendering.labelPixelsAwayFromStroke).toBeGreaterThan(10);
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
