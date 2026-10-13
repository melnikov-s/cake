import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect, Layer, ManagedRuntime } from "effect";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";
import { createCakeArtifactOperations } from "../../src/domain/artifacts/cake-artifact-operations";
import { resolveEffectiveReference } from "../../src/domain/artifacts/artifactWorkflows";
import {
  artifactRevisionToRecord,
  ArtifactStableRef,
  decodeArtifactLineageId,
} from "../../src/contracts/artifacts/artifact-lineage";
import { Schema } from "effect";
import { CakeOperationRegistry } from "../../src/services/pi/runtime/cake-operation-registry";
import { ArtifactStorage } from "../../src/services/storage/ArtifactStorage";
import { makeArtifactStorageLive } from "../../src/services/storage/ArtifactStorageLive";
import { makeSessionFamilyStorageLive } from "../../src/services/storage/SessionFamilyStorage";
import { ArtifactProjection } from "../../src/services/artifacts/ArtifactProjection";
import { makeArtifactProjectionLive } from "../../src/services/artifacts/ArtifactProjectionLive";
import { WidgetBrowserOutputs } from "../../src/services/widgets/WidgetBrowserOutputs";
import { makeWidgetBrowserOutputsLive } from "../../src/services/widgets/WidgetBrowserOutputsLive";
import { compileInlineWidget } from "../../src/services/widgets/inline-widget-service";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("repeated-inline-presentation-renders-at-new-turn with latest source and live lineage state", async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-present-existing-"));
  const paths = {
    cakeHome: join(root, "cake-home"),
    project: join(root, "project"),
    userData: join(root, "user-data"),
  };
  await findVisualCaptureScenario("inline-artifact")!.seed(paths, "dark");
  const artifactRoot = join(paths.cakeHome, "state", "artifacts");
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      makeArtifactStorageLive(artifactRoot),
      makeArtifactProjectionLive(join(root, "projections")),
      makeSessionFamilyStorageLive(join(paths.cakeHome, "state", "session-families.json")),
      makeWidgetBrowserOutputsLive(join(artifactRoot, "browser-outputs")),
    ).pipe(Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
  );
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const sessionRoot = join(paths.cakeHome, "pi", "sessions");
    const relativeFile = (await readdir(sessionRoot, { recursive: true })).find((file) =>
      file.endsWith(".jsonl"),
    );
    if (!relativeFile) throw new Error("Missing fixture Pi session");
    const manager = SessionManager.open(join(sessionRoot, relativeFile));
    const sessionId = manager.getSessionId();
    const assistant = manager
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "assistant");
    if (assistant?.type !== "message" || assistant.message.role !== "assistant")
      throw new Error("Missing fixture assistant");
    const original = assistant.message;
    const storage = await runtime.runPromise(ArtifactStorage);
    const id = decodeArtifactLineageId("inline-visual");
    const first = await runtime.runPromise(storage.read(id));
    if (first?.snapshot.kind !== "widget") throw new Error("Missing fixture widget");
    // Replace only the deterministic generation boundary. Compilation, retention,
    // storage, linked access, native operation, Pi pointers and renderer are real.
    const source = `import React from "react";
import { useArtifactState } from "@cake/artifact-sdk";
export default function Visual() {
  const { value, hydrated } = useArtifactState({ title: "stale seed" });
  return <main><h2>Source revision two</h2><p>{hydrated ? value.title : "Loading state"}</p></main>;
}`;
    for (const revision of [2, 3]) {
      const revisionSource =
        revision === 2 ? source : source.replace("Source revision two", "Source revision three");
      const compiled = await compileInlineWidget("react", revisionSource, "artifact");
      const browser = await runtime.runPromise(
        Effect.flatMap(WidgetBrowserOutputs, (outputs) => outputs.retain(compiled)),
      );
      await runtime.runPromise(
        storage.publish({
          lineageId: id,
          expectedLatestRevision: revision - 1,
          workingDirectory: paths.project,
          snapshot: {
            ...first.snapshot,
            revision,
            payload: { ...first.snapshot.payload, source: revisionSource, browser },
          },
        }),
      );
    }
    await runtime.runPromise(
      storage.replaceState({
        lineageId: id,
        expectedVersion: 0,
        value: { title: "Pi execution loop" },
      }),
    );
    const before = await readFile(join(artifactRoot, "catalog.json"), "utf8");
    const registry = new CakeOperationRegistry(
      createCakeArtifactOperations(
        {
          appendEntry: (type, data) => {
            manager.appendCustomEntry(type, data);
          },
        },
        {
          persistArtifact: async () => {
            throw new Error("Presentation must not publish");
          },
          resolveArtifact: (reference) =>
            runtime.runPromise(
              Effect.gen(function* () {
                const selected = yield* resolveEffectiveReference(
                  sessionId,
                  Schema.decodeUnknownSync(ArtifactStableRef)(reference),
                );
                const metadata = yield* (yield* ArtifactProjection).materialize({
                  sessionId,
                  revision: selected.revision,
                  latestRevision: selected.latestRevision,
                  linkMode: selected.link.selection.mode,
                });
                return { record: artifactRevisionToRecord(selected.revision), metadata };
              }),
            ),
        },
      ),
    );
    for (const [index, reference] of [
      "inline-visual",
      "inline-visual",
      "inline-visual@r2",
    ].entries()) {
      manager.appendMessage({
        role: "user",
        content: `Show existing artifact again ${index}`,
        timestamp: 10 + index,
      });
      const toolCallId = `present-${index}`;
      const entryId = manager.appendMessage({
        ...original,
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: "cake",
            arguments: { command: "artifacts.present", input: { reference } },
          },
        ],
        stopReason: "toolUse",
      });
      const result = await registry.invoke(
        { command: "artifacts.present", input: { reference } },
        {
          signal: new AbortController().signal,
          toolCallId,
          runtime: { sessionId, entryId, sessionFile: manager.getSessionFile() },
        },
      );
      manager.appendMessage({
        role: "toolResult",
        toolCallId,
        toolName: "cake",
        content: [{ type: "text", text: result.text }],
        details: result.details,
        isError: false,
        timestamp: 20 + index,
      });
      manager.appendMessage({
        ...original,
        content: [{ type: "text", text: `Existing artifact shown ${index}` }],
      });
    }
    expect(await readFile(join(artifactRoot, "catalog.json"), "utf8")).toBe(before);
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
      BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 6500),
    );
    const disclosures = page.locator('[data-slot="artifact-disclosure"]');
    await expect(disclosures).toHaveCount(5);
    // A prior publication plus the two new stable-reference calls mount r3.
    for (const index of [0, 2, 3]) {
      const frame = disclosures.nth(index).locator("iframe").contentFrame();
      await expect(frame.getByRole("heading", { name: "Source revision three" })).toBeVisible();
      await expect(frame.getByText("Pi execution loop", { exact: true })).toBeVisible();
      await expect(disclosures.nth(index).locator("iframe")).toHaveAttribute(
        "sandbox",
        "allow-scripts allow-downloads",
      );
    }
    // An exact historical source still hydrates the current lineage state.
    const historical = disclosures.nth(4).locator("iframe").contentFrame();
    await expect(historical.getByRole("heading", { name: "Source revision two" })).toBeVisible();
    await expect(historical.getByText("Pi execution loop", { exact: true })).toBeVisible();
    await expect(
      disclosures
        .nth(1)
        .locator("iframe")
        .contentFrame()
        .getByRole("heading", { name: "One artifact, two views" }),
    ).toBeVisible();
    expect(await readFile(join(artifactRoot, "catalog.json"), "utf8")).toBe(before);
  } finally {
    await app?.close();
    await runtime.dispose();
    await promisify(execFile)("chmod", ["-R", "u+w", root]);
    await rm(root, { recursive: true, force: true });
  }
});
