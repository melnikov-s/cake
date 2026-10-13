import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-data";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const artifactId = "editable-excalidraw";
const stateScope = { lineageId: artifactId };

type SceneElement = { id: string; type: string; x: number; [key: string]: unknown };
type Scene = { elements: SceneElement[]; [key: string]: unknown };
type State = { version: number; value: Scene };
type Capture = { pngBase64: string; diagnostics: string[]; persistedAfterCapture: boolean };

const initialScene = {
  type: "excalidraw",
  version: 2,
  source: "cake-artifact-test",
  elements: [
    {
      id: "authority-box",
      type: "rectangle",
      x: 80,
      y: 80,
      width: 260,
      height: 120,
      strokeColor: "#1971c2",
      backgroundColor: "#a5d8ff",
      fillStyle: "solid",
      strokeWidth: 2,
      roughness: 1,
      seed: 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      groupIds: [],
      boundElements: [],
      customData: { preserve: "unrelated user data" },
    },
    {
      id: "authority-label",
      type: "text",
      x: 110,
      y: 120,
      width: 180,
      height: 25,
      text: "Shared authority",
      originalText: "Shared authority",
      fontSize: 24,
      fontFamily: 5,
      textAlign: "left",
      verticalAlign: "top",
      lineHeight: 1.25,
      autoResize: true,
      strokeColor: "#1e1e1e",
      seed: 2,
      version: 1,
      versionNonce: 2,
      isDeleted: false,
      groupIds: [],
      boundElements: [],
    },
  ],
  appState: { viewBackgroundColor: "#ffffff", gridSize: null, scrollX: 0, scrollY: 0 },
  files: {},
  selection: {},
};

test("installed Excalidraw edits shared live state and reopens retained output without its package", async () => {
  test.setTimeout(240_000);
  const root = await mkdtemp(join(tmpdir(), "cake-excalidraw-artifact-"));
  const cakeHome = join(root, "cake-home");
  const userData = join(root, "user-data");
  const project = join(root, "project");
  await Promise.all([
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(userData, { recursive: true }),
    mkdir(project, { recursive: true }),
  ]);
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({ schemaVersion: 1, projects: [], trustedProjectPaths: [] }),
  );
  const launch = () =>
    electron.launch({
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
  let application: ElectronApplication | undefined;
  const invoke = async <Result>(
    command: string,
    input: Record<string, unknown>,
  ): Promise<Result> => {
    if (!application) throw new Error("Application is unavailable");
    const result = await application.evaluate(
      async (_electron, request) => {
        const operation = Reflect.get(globalThis, "cakeSmokeInvokeArtifact") as (
          value: typeof request,
        ) => Promise<{ details: { result: Result } }>;
        return operation(request);
      },
      { sessionId: CAKE_CHAT_SESSION_ID, workingDirectory: project, command, input },
    );
    return result.details.result;
  };
  try {
    application = await launch();
    let page = await application.firstWindow();
    await expect(page.getByRole("button", { name: "Cake Chat", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    const packages = (operation: "list" | "install" | "remove", value?: string) =>
      application!.evaluate(
        async (_electron, input) => {
          const manage = Reflect.get(globalThis, "cakeSmokeWidgetPackage") as (
            request: typeof input,
          ) => Promise<{ directory: string; packages: { name: string; version: string }[] }>;
          return manage(input);
        },
        { operation, value },
      );
    expect((await packages("list")).packages).toEqual([]);
    const installed = await packages("install", "@excalidraw/excalidraw@0.18.1");
    expect(installed.packages).toContainEqual({
      name: "@excalidraw/excalidraw",
      version: "0.18.1",
    });
    expect(installed.directory.startsWith(cakeHome)).toBe(true);
    const source = await readFile(
      join(repositoryRoot, ".agents/skills/excalidraw-artifacts/assets/editor.tsx"),
      "utf8",
    );
    const capture = await application.evaluate(
      async (_electron, input) => {
        const operation = Reflect.get(globalThis, "cakeSmokeCaptureInlineWidget") as (
          value: typeof input,
        ) => Promise<Capture>;
        return operation(input);
      },
      {
        sessionId: CAKE_CHAT_SESSION_ID,
        workingDirectory: project,
        artifactId,
        source,
        artifactState: initialScene,
      },
    );
    expect(capture.persistedAfterCapture).toBe(true);
    expect(capture.diagnostics).toContain("host=hidden-offscreen");
    const paintedPixels = await application.evaluate(({ nativeImage }, base64) => {
      const bitmap = nativeImage.createFromBuffer(Buffer.from(base64, "base64")).toBitmap();
      let blue = 0;
      for (let index = 0; index < bitmap.length; index += 4)
        if (
          bitmap[index]! > 235 &&
          bitmap[index + 1]! > 190 &&
          bitmap[index + 1]! < 235 &&
          bitmap[index + 2]! > 140 &&
          bitmap[index + 2]! < 190
        )
          blue += 1;
      return blue;
    }, capture.pngBase64);
    expect(paintedPixels).toBeGreaterThan(1_000);
    await mkdir(join(repositoryRoot, ".visual-captures"), { recursive: true });
    await writeFile(
      join(repositoryRoot, ".visual-captures/excalidraw-artifact.png"),
      Buffer.from(capture.pngBase64, "base64"),
    );
    await test.info().attach("excalidraw-artifact.png", {
      body: Buffer.from(capture.pngBase64, "base64"),
      contentType: "image/png",
    });

    const openArtifact = async () => {
      await page.getByRole("button", { name: "1 artifacts", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Artifacts", exact: true })
        .getByRole("button", { name: /Captured widget fixture/ })
        .click();
      return page.locator(`[data-artifact-id="${artifactId}"] iframe`).first();
    };
    let iframe = await openArtifact();
    const drawing = iframe.contentFrame();
    await expect(drawing.locator(".excalidraw canvas").first()).toBeVisible();
    await expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-downloads");
    const fonts = await drawing.locator("body").evaluate(async () => {
      await document.fonts.load("24px Excalifont");
      await document.fonts.ready;
      return [...document.fonts]
        .filter((font) => font.family.includes("Excalifont"))
        .map((font) => font.status);
    });
    expect(fonts).toContain("loaded");
    expect(
      await drawing.locator("body").evaluate(async () => {
        try {
          await fetch("https://example.com/cake-widget-network-probe");
          return "network permitted";
        } catch {
          return "network blocked";
        }
      }),
    ).toBe("network blocked");
    expect(
      await drawing
        .locator(".excalidraw")
        .evaluate((element) => getComputedStyle(element).position),
    ).toBe("relative");

    // Real pointer interaction creates a native editable shape, not a test-side state replacement.
    await drawing
      .getByTitle(/Rectangle/)
      .first()
      .click();
    const canvas = drawing.locator("canvas.interactive");
    const bounds = await canvas.boundingBox();
    if (!bounds) throw new Error("Native Excalidraw interactive canvas is unavailable");
    await page.mouse.move(bounds.x + 380, bounds.y + 250);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 470, bounds.y + 320, { steps: 8 });
    await page.mouse.up();
    await drawing.getByRole("button", { name: "Save drawing", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await invoke<State>("artifacts.state.read", stateScope)).value.elements.filter(
            (element) => element.type === "rectangle",
          ).length,
      )
      .toBe(2);
    const manuallySaved = await invoke<State>("artifacts.state.read", stateScope);
    const manualShape = manuallySaved.value.elements.find(
      (element) => element.id !== "authority-box" && element.type === "rectangle",
    )!;
    const unrelated = structuredClone(manualShape);
    const index = manuallySaved.value.elements.findIndex(
      (element) => element.id === "authority-box",
    );
    // The data-only agent primitive makes one surgical CAS edit, preserving every unrelated element.
    await invoke("artifacts.state.update", {
      ...stateScope,
      expectedVersion: manuallySaved.version,
      edits: [{ op: "set", path: `/elements/${index}/x`, value: 120 }],
    });
    const edited = await invoke<State>("artifacts.state.read", stateScope);
    expect(edited.value.elements.find((element) => element.id === manualShape.id)).toEqual(
      unrelated,
    );
    expect(edited.value.elements.find((element) => element.id === "authority-box")).toMatchObject({
      x: 120,
      customData: { preserve: "unrelated user data" },
    });

    const staged = structuredClone(edited.value);
    staged.elements[index] = { ...staged.elements[index]!, y: 110 };
    const revision = await application.evaluate(
      async (_electron, input) => {
        const operation = Reflect.get(globalThis, "cakeSmokeCaptureInlineWidget") as (
          request: typeof input,
        ) => Promise<Capture & { exactRef: string }>;
        return operation(input);
      },
      {
        sessionId: CAKE_CHAT_SESSION_ID,
        workingDirectory: project,
        artifactId,
        expectedRevision: 1,
        source,
        artifactState: staged,
      },
    );
    expect(revision.exactRef).toBe(`cake://artifact/${artifactId}@r2`);
    expect(
      (await invoke<State>("artifacts.state.read", stateScope)).value.elements.find(
        (element) => element.id === manualShape.id,
      ),
    ).toEqual(unrelated);
    await expect(
      invoke("artifacts.state.update", {
        ...stateScope,
        expectedVersion: manuallySaved.version,
        edits: [{ op: "set", path: `/elements/${index}/x`, value: 999 }],
      }),
    ).rejects.toThrow(/version|conflict/i);

    // Library and fullscreen views keep two live SDK instances attached to the same lineage.
    await page.getByRole("button", { name: "View Captured widget fixture fullscreen" }).click();
    await expect(page.locator('iframe[title="Captured widget fixture"]')).toHaveCount(2);
    const fullscreenDrawing = page
      .getByRole("dialog", { name: "Captured widget fixture", exact: true })
      .locator("iframe")
      .contentFrame();
    await expect(
      fullscreenDrawing.getByRole("button", { name: "Save drawing", exact: true }),
    ).toBeVisible();
    const latest = await invoke<State>("artifacts.state.read", stateScope);
    const synchronized = await invoke<State>("artifacts.state.update", {
      ...stateScope,
      expectedVersion: latest.version,
      edits: [{ op: "set", path: `/elements/${index}/x`, value: 160 }],
    });
    for (const frame of [drawing, fullscreenDrawing])
      await expect(frame.getByRole("status")).toContainText(`version ${synchronized.version}`);
    for (const name of ["Export PNG", "Export SVG", "Export drawing"]) {
      const downloaded = page.waitForEvent("download");
      await fullscreenDrawing.getByRole("button", { name, exact: true }).click();
      const download = await downloaded;
      expect(await download.failure()).toBeNull();
      const file = (await download.path())!;
      await test.info().attach(download.suggestedFilename(), { path: file });
      if (name === "Export drawing") {
        const scene = JSON.parse(await readFile(file, "utf8")) as Scene;
        expect(scene.elements.find((element) => element.id === "authority-box")?.x).toBe(160);
        expect(scene.elements.find((element) => element.id === manualShape.id)).toEqual(unrelated);
      }
    }
    await page.getByRole("button", { name: "Exit fullscreen Captured widget fixture" }).click();
    expect((await packages("remove", "@excalidraw/excalidraw")).packages).toEqual([]);
    await application.close();
    application = await launch();
    page = await application.firstWindow();
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    iframe = await openArtifact();
    await expect(iframe.contentFrame().locator(".excalidraw canvas").first()).toBeVisible();
    await expect(
      iframe.contentFrame().getByRole("button", { name: "Save drawing", exact: true }),
    ).toBeVisible();
    const retainedFonts = await iframe
      .contentFrame()
      .locator("body")
      .evaluate(async () => {
        await document.fonts.load("24px Excalifont");
        return [...document.fonts]
          .filter((font) => font.family.includes("Excalifont"))
          .map((font) => font.status);
      });
    expect(retainedFonts).toContain("loaded");
    const reopened = await invoke<State>("artifacts.state.read", stateScope);
    expect(reopened.value.elements.find((element) => element.id === manualShape.id)).toEqual(
      unrelated,
    );
    expect(reopened.value.elements.find((element) => element.id === "authority-box")?.x).toBe(160);
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    ).toBe(true);
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
  }
});
