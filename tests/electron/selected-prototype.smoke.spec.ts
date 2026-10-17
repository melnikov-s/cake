import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";
import { decodeArtifactLineageId } from "../../src/contracts/artifacts/artifact-lineage";
import { ArtifactStorage } from "../../src/services/storage/ArtifactStorage";
import { makeArtifactStorageLive } from "../../src/services/storage/ArtifactStorageLive";
import { makeWidgetBrowserOutputsLive } from "../../src/services/widgets/WidgetBrowserOutputsLive";
import { WidgetBrowserOutputs } from "../../src/services/widgets/WidgetBrowserOutputs";
import { compileInlineWidget } from "../../src/services/widgets/inline-widget-service";
import { ArtifactProjection } from "../../src/services/artifacts/ArtifactProjection";
import { makeArtifactProjectionLive } from "../../src/services/artifacts/ArtifactProjectionLive";
import { encodePrototype, prototypeFixture } from "../fixtures/prototype-source";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("one structured five-option chooser persists a choice independently of visible navigation and hands off source without pixels", async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-selected-prototype-"));
  const paths = {
    cakeHome: join(root, "cake-home"),
    project: join(root, "project"),
    userData: join(root, "user-data"),
  };
  const artifactRoot = join(paths.cakeHome, "state", "artifacts");
  await findVisualCaptureScenario("inline-artifact")!.seed(paths, "light");
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      makeArtifactStorageLive(artifactRoot),
      makeWidgetBrowserOutputsLive(join(artifactRoot, "browser-outputs")),
    ).pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const id = decodeArtifactLineageId("inline-visual");
    const storage = await runtime.runPromise(ArtifactStorage);
    const first = await runtime.runPromise(storage.read(id));
    if (first?.snapshot.kind !== "widget") throw new Error("Missing fixture widget");
    const source = encodePrototype(prototypeFixture());
    const compiled = await compileInlineWidget("react", source, "artifact");
    const browser = await runtime.runPromise(
      Effect.flatMap(WidgetBrowserOutputs, (outputs) => outputs.retain(compiled)),
    );
    await runtime.runPromise(
      storage.publish({
        lineageId: id,
        expectedLatestRevision: 1,
        workingDirectory: paths.project,
        snapshot: {
          ...first.snapshot,
          revision: 2,
          payload: { ...first.snapshot.payload, source, browser },
        },
      }),
    );
    await runtime.dispose();
    app = await electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: paths.userData,
        CAKE_HOME: paths.cakeHome,
        PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 1000),
    );
    const host = page.locator('[data-artifact-id="inline-visual"]').first();
    await host.scrollIntoViewIfNeeded();
    const frame = host.locator("iframe").contentFrame();
    await expect(frame.getByText("option-1 design", { exact: true })).toBeVisible();
    await expect(frame.getByText("Saved: none", { exact: true })).toBeVisible();
    for (const n of [1, 2, 3, 4, 5])
      await expect(frame.getByRole("button", { name: `option-${n}`, exact: true })).toBeVisible();
    // Exercise keyboard activation in the hidden Electron iframe; pointer stability
    // checks wait on animation frames that this offscreen fixture does not produce.
    await frame.getByRole("button", { name: "option-3", exact: true }).focus();
    await frame.getByRole("button", { name: "option-3", exact: true }).press("Enter");
    await expect(frame.getByText("option-3 design", { exact: true })).toBeVisible();
    await expect(frame.getByText("Saved: none", { exact: true })).toBeVisible();
    await frame.getByRole("button", { name: "Choose this", exact: true }).focus();
    await frame.getByRole("button", { name: "Choose this", exact: true }).press("Enter");
    await expect(frame.getByText("Saved: option-3", { exact: true })).toBeVisible();
    await frame.getByRole("button", { name: "option-5", exact: true }).focus();
    await frame.getByRole("button", { name: "option-5", exact: true }).press("Enter");
    await expect(frame.getByText("option-5 design", { exact: true })).toBeVisible();
    await expect(frame.getByText("Saved: option-3", { exact: true })).toBeVisible();
    await host.getByRole("button", { name: "View Inline visualization fullscreen" }).click();
    const dialog = page.getByRole("dialog", { name: "Inline visualization", exact: true });
    const reopened = dialog.locator("iframe").contentFrame();
    await expect(reopened.getByText("Saved: option-3", { exact: true })).toBeVisible();
    await expect(reopened.getByText("option-5 design", { exact: true })).toBeVisible();
    await page.reload();
    await expect(
      host.locator("iframe").contentFrame().getByText("Saved: option-3", { exact: true }),
    ).toBeVisible();
    await expect(
      host.locator("iframe").contentFrame().getByText("option-1 design", { exact: true }),
    ).toBeVisible();
    const result = await app.evaluate(async (_electron, workingDirectory) => {
      const invoke = Reflect.get(globalThis, "cakeSmokeInvokeArtifact") as (input: {
        sessionId: string;
        workingDirectory: string;
        command: string;
        input: Record<string, unknown>;
      }) => Promise<{ details: { result: unknown }; content: { type: string }[] }>;
      const base = { sessionId: "visual-inline-artifact", workingDirectory };
      const state = await invoke({
        ...base,
        command: "artifacts.state.read",
        input: { lineageId: "inline-visual" },
      });
      const saved = state.details.result as { version: number };
      const captured = await invoke({
        ...base,
        command: "artifacts.selection.capture",
        input: {
          reference: "cake://artifact/inline-visual@r2",
          expectedStateVersion: saved.version,
        },
      });
      const source = await invoke({
        ...base,
        command: "artifacts.source",
        input: { selection: captured.details.result, moduleId: "option-3" },
      });
      return { captured, source };
    }, paths.project);
    expect(JSON.stringify(result.captured)).toContain('"optionId":"option-3"');
    expect(JSON.stringify(result.source)).toContain("option-3 design");
    expect(JSON.stringify(result.source)).not.toMatch(
      /option-1|option-2|option-4|option-5|PRIVATE|image\/png/,
    );
    expect(result.source.content.every((block) => block.type === "text")).toBe(true);
  } finally {
    await app?.close();
    await runtime.dispose();
    const projections = ManagedRuntime.make(
      makeArtifactProjectionLive(join(paths.cakeHome, "cache")).pipe(
        Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
      ),
    );
    try {
      await projections.runPromise(
        Effect.flatMap(ArtifactProjection, (projection) =>
          projection.cleanupSession("visual-inline-artifact"),
        ),
      );
    } finally {
      await projections.dispose();
    }
    await rm(root, { recursive: true, force: true });
  }
});
