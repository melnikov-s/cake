import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("imports Mermaid as readable native shapes with intact agent IDs in Electron", async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-draw-mermaid-"));
  const paths = {
    cakeHome: join(root, "cake-home"),
    project: join(root, "project"),
    userData: join(root, "user-data"),
  };
  const scenario = findVisualCaptureScenario("draw-mermaid-architecture")!;
  await scenario.seed(paths, "light");
  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: paths.userData,
      CAKE_HOME: paths.cakeHome,
    },
  });
  let applicationClosed = false;
  try {
    const page = await application.firstWindow();
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900);
    });
    await scenario.prepare(page, "default", application);
    await expect(page.locator(".excalidraw__canvas.interactive")).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled();

    await application.close();
    applicationClosed = true;
    const boardDirectory = join(paths.cakeHome, "state", "draw-boards", "boards");
    const boardFiles = await readdir(boardDirectory);
    expect(boardFiles).toHaveLength(1);
    const persisted = JSON.parse(await readFile(join(boardDirectory, boardFiles[0]!), "utf8"));
    const elements = persisted.data.snapshot.elements as Array<{
      id: string;
      type: string;
      text?: string;
      containerId?: string | null;
      frameId?: string | null;
      boundElements?: Array<{ id: string }> | null;
      startBinding?: { elementId: string } | null;
      endBinding?: { elementId: string } | null;
    }>;
    const ids = new Set(elements.map(({ id }) => id));

    expect(elements.length).toBeGreaterThan(4);
    expect(elements.every(({ id }) => /^shape:[A-Za-z0-9_-]+$/.test(id))).toBe(true);
    expect(elements.every(({ type }) => type !== "image")).toBe(true);
    expect(elements.map(({ text }) => text).filter(Boolean)).toContain(
      "Sandboxed Renderer\nModels + Stores",
    );
    const connectorIndexes = elements.flatMap((element, index) =>
      element.type === "line" || element.type === "arrow" ? [index] : [],
    );
    const nodeIndexes = elements.flatMap((element, index) =>
      element.type === "rectangle" || element.type === "ellipse" || element.type === "diamond"
        ? [index]
        : [],
    );
    const labelIndexes = elements.flatMap((element, index) =>
      element.type === "text" ? [index] : [],
    );
    expect(Math.max(...connectorIndexes)).toBeLessThan(Math.min(...nodeIndexes));
    expect(Math.min(...labelIndexes)).toBeGreaterThan(Math.max(...nodeIndexes));
    for (const element of elements) {
      if (element.containerId) expect(ids.has(element.containerId)).toBe(true);
      if (element.frameId) expect(ids.has(element.frameId)).toBe(true);
      for (const binding of element.boundElements ?? []) expect(ids.has(binding.id)).toBe(true);
      if (element.startBinding) expect(ids.has(element.startBinding.elementId)).toBe(true);
      if (element.endBinding) expect(ids.has(element.endBinding.elementId)).toBe(true);
    }
  } finally {
    if (!applicationClosed) await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
