import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-identity";

import { seedCakeChatHistory } from "./durable-chat-fixture";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const artifactId = "editable-excalidraw";
const stateScope = { lineageId: artifactId };

type SceneElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  version: number;
  [key: string]: unknown;
};
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
      boundElements: [{ type: "text", id: "authority-label" }],
      customData: { preserve: "unrelated user data" },
    },
    {
      id: "authority-label",
      type: "text",
      x: 110,
      y: 120,
      width: 220,
      height: 30,
      text: "Hello World",
      originalText: "Hello World",
      containerId: "authority-box",
      fontSize: 24,
      fontFamily: 5,
      textAlign: "center",
      verticalAlign: "middle",
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
  // esbuild traverses package ancestors; don't put this npm environment beneath
  // a shared OS temp directory that may contain hundreds of thousands of entries.
  const fixtureRoot = join(repositoryRoot, ".visual-captures", "widget-fixtures");
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, "cake-excalidraw-artifact-"));
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
  await seedCakeChatHistory(
    cakeHome,
    `cake://artifact/${artifactId}\n\n![Live drawing](cake://artifact/${artifactId})`,
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
    const template = await readFile(
      join(repositoryRoot, ".agents/skills/excalidraw-artifacts/assets/editor.tsx"),
      "utf8",
    );
    // Real native converter output (including own undefined defaults), not staged
    // JSON storage: both review and the first chat mount must initialize themselves.
    const source = template
      // Fail only the external save boundary; exercise the real editor recovery path.
      .replace(
        "const saved = await saveRef.current(flight.scene);",
        `if (Reflect.get(globalThis, "__cakeFailNextSave")) {
          Reflect.set(globalThis, "__cakeFailNextSave", false);
          throw new Error("Fixture autosave failure");
        }
        const saved = await saveRef.current(flight.scene);`,
      )
      .replace(
        "  const [jsonInitialScene]",
        `  initialScene.elements = library.convertToExcalidrawElements(${JSON.stringify(initialScene.elements)}, { regenerateIds: false });
  if (!initialScene.elements.some(element => Object.hasOwn(element, "customData") && element.customData === undefined)) throw new Error("Fixture must exercise native own undefined defaults");
  const [jsonInitialScene]`,
      )
      .replace(
        "  const [api, setApi]",
        `  useEffect(() => { if (hydrated && version === 0) void save(value); }, [hydrated, version]);
  const [api, setApi]`,
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
        capability: "artifact",
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
      await page.getByRole("button", { name: /^\d+ artifacts$/ }).click();
      await page
        .getByRole("dialog", { name: "Artifacts", exact: true })
        .getByRole("button", { name: /Captured widget fixture/ })
        .click();
      return page
        .getByRole("dialog", { name: "Captured widget fixture", exact: true })
        .locator("iframe")
        .first();
    };
    let iframe = page
      .locator(`[data-slot="artifact-disclosure"] [data-artifact-id="${artifactId}"] iframe`)
      .first();
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

    const malformed = await drawing.locator("body").evaluate(
      () =>
        new Promise<string>((resolve) => {
          const receive = (event: MessageEvent) => {
            if (event.data?.type !== "state-result" || event.data.value.id !== "malformed") return;
            removeEventListener("message", receive);
            resolve(event.data.value.ok ? "Unexpectedly saved" : event.data.value.error);
          };
          addEventListener("message", receive);
          parent.postMessage(
            {
              source: "cake-inline-widget",
              token: new URL(location.href).pathname.slice(1),
              type: "artifact-state-replace",
              value: {
                id: "malformed",
                expectedVersion: 1,
                value: { elements: [{ customData: undefined }] },
              },
            },
            "*",
          );
        }),
    );
    expect(malformed).toContain("value/elements/0/customData must be JSON");

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
    await expect
      .poll(
        async () =>
          (await invoke<State>("artifacts.state.read", stateScope)).value.elements.filter(
            (element) => element.type === "rectangle",
          ).length,
      )
      .toBe(2);
    // A later failure retains the native canvas and latest local edits for retry.
    await drawing.locator("body").evaluate(() => {
      Reflect.set(globalThis, "__cakeFailNextSave", true);
    });
    await drawing
      .getByTitle(/Rectangle/)
      .first()
      .click();
    await page.mouse.move(bounds.x + 500, bounds.y + 350);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 580, bounds.y + 410, { steps: 8 });
    await page.mouse.up();
    await expect(drawing.getByRole("alert")).toContainText("Fixture autosave failure");
    expect(
      (await invoke<State>("artifacts.state.read", stateScope)).value.elements.filter(
        (element) => element.type === "rectangle",
      ),
    ).toHaveLength(2);
    await expect(canvas).toBeVisible();
    await drawing.getByRole("button", { name: "Retry saving drawing", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await invoke<State>("artifacts.state.read", stateScope)).value.elements.filter(
            (element) => element.type === "rectangle",
          ).length,
      )
      .toBe(3);
    await expect(drawing.getByRole("alert")).toHaveCount(0);
    await expect(
      drawing.getByRole("button", { name: "Retry saving drawing", exact: true }),
    ).toHaveCount(0);
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
    let edited = await invoke<State>("artifacts.state.read", stateScope);
    expect(edited.value.elements.find((element) => element.id === manualShape.id)).toEqual(
      unrelated,
    );
    expect(edited.value.elements.find((element) => element.id === "authority-box")).toMatchObject({
      x: 120,
      customData: { preserve: "unrelated user data" },
    });

    // A label edit is document data, not an artifact source replacement. The
    // unchanged editor must remeasure/recenter it and save native versions itself.
    await expect
      .poll(async () => {
        const state = await invoke<State>("artifacts.state.read", stateScope);
        const label = state.value.elements.find((element) => element.id === "authority-label")!;
        const box = state.value.elements.find((element) => element.id === "authority-box")!;
        return Math.abs(label.x - (box.x + (box.width - label.width) / 2)) < 0.1;
      })
      .toBe(true);
    const beforeLabelEdit = await invoke<State>("artifacts.state.read", stateScope);
    const labelIndex = beforeLabelEdit.value.elements.findIndex(
      (element) => element.id === "authority-label",
    );
    const oldLabel = beforeLabelEdit.value.elements[labelIndex]!;
    await invoke("artifacts.state.update", {
      ...stateScope,
      expectedVersion: beforeLabelEdit.version,
      edits: [
        { op: "set", path: `/elements/${labelIndex}/text`, value: "Hello Universe" },
        { op: "set", path: `/elements/${labelIndex}/originalText`, value: "Hello Universe" },
      ],
    });
    await expect
      .poll(async () => {
        const state = await invoke<State>("artifacts.state.read", stateScope);
        const label = state.value.elements[labelIndex]!;
        return (
          label.originalText === "Hello Universe" &&
          label.width !== oldLabel.width &&
          label.version > oldLabel.version
        );
      })
      .toBe(true);
    edited = await invoke<State>("artifacts.state.read", stateScope);
    const editedLabel = edited.value.elements[labelIndex]!;
    const editedBox = edited.value.elements[index]!;
    expect(editedLabel.containerId).toBe("authority-box");
    expect(editedLabel.x).toBeCloseTo(editedBox.x + (editedBox.width - editedLabel.width) / 2);
    expect(editedLabel.y).toBeCloseTo(editedBox.y + (editedBox.height - editedLabel.height) / 2);
    expect(edited.value.elements.find((element) => element.id === manualShape.id)).toEqual(
      unrelated,
    );
    expect(await invoke("artifacts.resolve-reference", { reference: artifactId })).toMatchObject({
      selectedRevision: 1,
    });

    const independentId = "independent-excalidraw";
    await invoke("widgets.instantiate", {
      id: independentId,
      title: "Independent drawing",
      reference: `cake://artifact/${artifactId}@r1`,
      initialState: {
        ...edited.value,
        elements: edited.value.elements.map((element) =>
          element.id === "authority-label"
            ? { ...element, text: "Another drawing", originalText: "Another drawing" }
            : element,
        ),
      },
      fallback: { markdown: "Another drawing in the same reusable editor." },
    });
    expect(
      (await invoke<State>("artifacts.state.read", { lineageId: independentId })).value.elements[
        labelIndex
      ]?.originalText,
    ).toBe("Another drawing");
    expect(await invoke<State>("artifacts.state.read", stateScope)).toEqual(edited);

    // Open another ordinary instance BEFORE publishing; neither may need manual revision selection.
    const paneIframe = await openArtifact();
    await expect(paneIframe.contentFrame().locator(".excalidraw canvas").first()).toBeVisible();
    // Menu opening is already fullscreen and uses one live browsing context.
    const paneSource = await paneIframe.getAttribute("src");
    if (!paneSource) throw new Error("Missing compiled pane widget URL");
    await expect(page.locator('iframe[title="Captured widget fixture"]')).toHaveCount(2);
    await expect(
      page.getByRole("dialog", { name: "Captured widget fixture", exact: true }).locator("iframe"),
    ).toHaveAttribute("src", paneSource);
    const fullscreenDrawing = page
      .getByRole("dialog", { name: "Captured widget fixture", exact: true })
      .locator("iframe")
      .contentFrame();
    await expect(fullscreenDrawing.locator("canvas.interactive")).toBeVisible();
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
        source: source.replaceAll("<main>", '<main data-source-revision="2">'),
        capability: "artifact",
      },
    );
    expect(revision.exactRef).toBe(`cake://artifact/${artifactId}@r2`);
    // Source-only publication must not replace or re-seed the mutable document.
    expect(await invoke<State>("artifacts.state.read", stateScope)).toEqual(edited);
    await expect(fullscreenDrawing.locator('main[data-source-revision="2"]')).toBeVisible();
    await expect(iframe.contentFrame().locator('main[data-source-revision="2"]')).toBeVisible();
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

    const latest = await invoke<State>("artifacts.state.read", stateScope);
    const synchronized = await invoke<State>("artifacts.state.update", {
      ...stateScope,
      expectedVersion: latest.version,
      edits: [{ op: "set", path: `/elements/${index}/x`, value: 160 }],
    });
    expect(synchronized.value.elements[index]?.x).toBe(160);
    await expect(paneIframe.contentFrame().locator('main[data-source-revision="2"]')).toBeVisible();
    await page.getByRole("button", { name: "Exit fullscreen Captured widget fixture" }).click();
    expect((await packages("remove", "@excalidraw/excalidraw")).packages).toEqual([]);
    await application.close();
    application = await launch();
    page = await application.firstWindow();
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    iframe = await openArtifact();
    await expect(iframe.contentFrame().locator(".excalidraw canvas").first()).toBeVisible();
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
      reopened.value.elements.find((element) => element.id === "authority-label"),
    ).toMatchObject({ originalText: "Hello Universe", containerId: "authority-box" });
    expect(
      (await invoke<State>("artifacts.state.read", { lineageId: independentId })).value.elements[
        labelIndex
      ]?.originalText,
    ).toBe("Another drawing");
    await iframe
      .contentFrame()
      .locator(".excalidraw")
      .screenshot({
        path: join(repositoryRoot, ".visual-captures", "excalidraw-artifact-reopened.png"),
      });
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    ).toBe(true);
  } finally {
    await application?.close();
    await promisify(execFile)("chmod", ["-R", "u+w", root]);
    await rm(root, { recursive: true, force: true });
  }
});
