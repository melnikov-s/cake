import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

async function darkCanvasPixels(page: Page) {
  const canvas = page.locator(".excalidraw__canvas.static");
  await expect(canvas).toBeVisible();
  return canvas.evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Cake Draw canvas did not expose a 2D context");
    const pixels = context.getImageData(0, 0, element.width, element.height).data;
    let dark = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (
        pixels[offset]! < 150 &&
        pixels[offset + 1]! < 150 &&
        pixels[offset + 2]! < 150 &&
        pixels[offset + 3]! > 150
      )
        dark += 1;
    }
    return dark;
  });
}

test("authors and restores a readable named Mermaid diagram in Electron", async () => {
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
    await application.evaluate(
      (_electron, event) => {
        const emit = (
          globalThis as typeof globalThis & {
            cakeSmokeEmitRendererEvent?: (value: unknown) => void;
          }
        ).cakeSmokeEmitRendererEvent;
        if (!emit) throw new Error("Cake smoke event source is unavailable");
        emit(event);
      },
      {
        type: "draw-control-requested",
        sessionId: "visual-draw-mermaid-architecture",
        drawRequestId: "00000000-0000-4000-8000-000000000100",
        invocation: {
          _tag: "Mermaid",
          id: "cake-desktop-architecture",
          replace: true,
          diagram: `flowchart TB
  subgraph renderer["Sandboxed Renderer"]
    models["Renderer Models + Stores with measured replacement labels"]
    chat["Shared Chat and Conversation surfaces"]
  end
  subgraph main["Electron Main"]
    services["Cake services"]
    pi["Pi Runtime agent loop + transcript"]
  end
  models -->|typed RPC| services
  chat --> services
  services --> pi`,
        },
      },
    );
    await page.waitForTimeout(700);

    const beforeNavigation = await darkCanvasPixels(page);
    expect(beforeNavigation).toBeGreaterThan(1_000);
    await page.getByRole("button", { name: "Back to agent" }).click();
    await page.getByRole("button", { name: "Open Cake Draw" }).click();
    await expect(page.locator(".excalidraw__canvas.interactive")).toBeVisible();
    await page.waitForTimeout(300);
    const afterNavigation = await darkCanvasPixels(page);
    expect(afterNavigation).toBeGreaterThan(beforeNavigation * 0.7);

    await application.close();
    applicationClosed = true;
    const boardDirectory = join(paths.cakeHome, "state", "draw-boards", "boards");
    const boardFiles = await readdir(boardDirectory);
    expect(boardFiles).toHaveLength(1);
    const persisted = JSON.parse(await readFile(join(boardDirectory, boardFiles[0]!), "utf8"));
    expect(persisted.data.snapshot.appState).toMatchObject({
      scrollX: expect.any(Number),
      scrollY: expect.any(Number),
      zoom: { value: expect.any(Number) },
    });
    const elements = persisted.data.snapshot.elements as Array<{
      id: string;
      type: string;
      x: number;
      y: number;
      width: number;
      height: number;
      text?: string;
      originalText?: string;
      containerId?: string | null;
      frameId?: string | null;
      boundElements?: Array<{ id: string }> | null;
      startBinding?: { elementId: string } | null;
      endBinding?: { elementId: string } | null;
      customData?: {
        cakeDiagram?: { diagramId: string; semanticId: string; role: string };
        cakeGeneratedCompanionFor?: string;
        cakeGeneratedCompanionKind?: string;
      };
    }>;
    const ids = new Set(elements.map(({ id }) => id));
    const isCompanion = (element: (typeof elements)[number]) =>
      element.type === "text" &&
      (!!element.containerId || !!element.customData?.cakeGeneratedCompanionFor);
    const roots = elements.filter((element) => !isCompanion(element));

    expect(elements.length).toBeGreaterThan(8);
    expect(roots.every(({ id }) => /^shape:[A-Za-z0-9_-]+$/.test(id))).toBe(true);
    expect(elements.every(({ type }) => type !== "image")).toBe(true);
    expect(elements.map(({ originalText }) => originalText).filter(Boolean)).toEqual(
      expect.arrayContaining([
        "Sandboxed Renderer",
        "Electron Main",
        "Renderer Models + Stores with measured replacement labels",
        "Shared Chat and Conversation surfaces",
      ]),
    );
    expect(
      roots.every(
        (element) => element.customData?.cakeDiagram?.diagramId === "cake-desktop-architecture",
      ),
    ).toBe(true);
    expect(new Set(roots.map((element) => element.customData?.cakeDiagram?.role))).toEqual(
      new Set(["group", "node", "edge"]),
    );

    const nodes = roots.filter((element) => element.customData?.cakeDiagram?.role === "node");
    for (let left = 0; left < nodes.length; left += 1) {
      for (let right = left + 1; right < nodes.length; right += 1) {
        const a = nodes[left]!;
        const b = nodes[right]!;
        const overlap =
          a.x < b.x + b.width &&
          a.x + a.width > b.x &&
          a.y < b.y + b.height &&
          a.y + a.height > b.y;
        expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false);
      }
    }
    const titles = elements.filter(
      (element) => element.customData?.cakeGeneratedCompanionKind === "title",
    );
    expect(titles).toHaveLength(2);
    for (const title of titles) {
      expect(
        nodes.some(
          (node) =>
            title.x < node.x + node.width &&
            title.x + title.width > node.x &&
            title.y < node.y + node.height &&
            title.y + title.height > node.y,
        ),
      ).toBe(false);
    }
    expect(
      elements.some((element) => element.customData?.cakeGeneratedCompanionKind === "connector"),
    ).toBe(true);

    for (const element of elements) {
      if (element.containerId) expect(ids.has(element.containerId)).toBe(true);
      if (element.frameId) expect(ids.has(element.frameId)).toBe(true);
      if (element.customData?.cakeGeneratedCompanionFor)
        expect(ids.has(element.customData.cakeGeneratedCompanionFor)).toBe(true);
      for (const binding of element.boundElements ?? []) expect(ids.has(binding.id)).toBe(true);
      if (element.startBinding) expect(ids.has(element.startBinding.elementId)).toBe(true);
      if (element.endBinding) expect(ids.has(element.endBinding.elementId)).toBe(true);
    }
  } finally {
    if (!applicationClosed) await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
