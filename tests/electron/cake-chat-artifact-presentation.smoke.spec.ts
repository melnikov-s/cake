import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  ToolResultEntry,
  Harness,
  createRegistry,
} from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-durable-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Effect, Layer, ManagedRuntime } from "effect";
import { _electron as electron, expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";
import { createHash } from "node:crypto";
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-identity";
import * as access from "../../src/domain/artifacts/agentArtifactAccess";
import * as workflows from "../../src/domain/artifacts/artifactWorkflows";
import { createCakeArtifactOperations } from "../../src/domain/artifacts/cake-artifact-operations";
import { decodeArtifactLineageId } from "../../src/contracts/artifacts/artifact-lineage";
import { ArtifactStorage } from "../../src/services/storage/ArtifactStorage";
import { makeArtifactStorageLive } from "../../src/services/storage/ArtifactStorageLive";
import { makeArtifactProjectionLive } from "../../src/services/artifacts/ArtifactProjectionLive";
import { makeSessionFamilyStorageLive } from "../../src/services/storage/SessionFamilyStorage";
import { ClientEvents } from "../../src/services/clients/ClientEvents";
import { WidgetBrowserOutputs } from "../../src/services/widgets/WidgetBrowserOutputs";
import { makeWidgetBrowserOutputsLive } from "../../src/services/widgets/WidgetBrowserOutputsLive";
import { compileInlineWidget } from "../../src/services/widgets/inline-widget-service";
import { CakeOperationRegistry } from "../../src/services/pi/runtime/cake-operation-registry";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("non-owner Project Chat and global Cake Chat hydrate persisted inline prototypes and share live state after reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-chat-presentation-"));
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
      Layer.mock(ClientEvents, { broadcast: () => undefined }),
    ).pipe(Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
  );
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const storage = await runtime.runPromise(ArtifactStorage);
    const id = decodeArtifactLineageId("inline-visual");
    const first = await runtime.runPromise(storage.read(id));
    if (first?.snapshot.kind !== "widget") throw new Error("Missing fixture widget");
    for (const revision of [2, 3]) {
      const source = `import React from "react";
import { useArtifactState } from "@cake/artifact-sdk";
export default function Prototype() {
  const { value, hydrated, save } = useArtifactState({ selected: "stale seed" });
  return <main><h2>Prototype source ${revision}</h2><p>{hydrated ? value.selected : "Hydrating"}</p><button disabled={!hydrated} onClick={() => save({ selected: "Selected option C" })}>Choose C</button></main>;
}`;
      const compiled = await compileInlineWidget("react", source, "artifact");
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
            payload: { ...first.snapshot.payload, source, browser },
          },
        }),
      );
    }
    await runtime.runPromise(
      storage.replaceState({
        lineageId: id,
        expectedVersion: 0,
        value: { selected: "Selected option B" },
      }),
    );
    await runtime.runPromise(
      workflows.create({
        sessionId: first.snapshot.sessionId,
        lineageId: decodeArtifactLineageId("existing-document"),
        workingDirectory: paths.project,
        snapshot: {
          protocol: "cake.artifact/v1",
          id: "existing-document",
          revision: 1,
          sessionId: first.snapshot.sessionId,
          kind: "markdown",
          title: "Existing document",
          payload: { markdown: "## Existing document\n\nPresented without copying or revising." },
          fallback: { markdown: "Existing document" },
        },
      }),
    );
    const globalLocation = {
      workingDirectory: paths.project,
      sessionDirectory: join(paths.cakeHome, "pi", "global-chat"),
    };
    const projectHash = createHash("sha256").update(paths.project).digest("hex");
    const projectId = `project-chat:${projectHash}`;
    for (const sessionId of [CAKE_CHAT_SESSION_ID, projectId]) {
      const directory =
        sessionId === CAKE_CHAT_SESSION_ID
          ? globalLocation.sessionDirectory
          : join(paths.cakeHome, "pi", "project-chats", projectHash);
      await mkdir(directory, { recursive: true });
      const durableStorage = await openNodeSqliteStorage(join(directory, "coordinator.sqlite"));
      const harness = await Harness.open(
        durableStorage,
        { models: createModels(), registry: createRegistry() },
        BACKGROUND_CONTEXT,
      );
      try {
        const conversation = await harness.root(BACKGROUND_CONTEXT);
        const operations = new CakeOperationRegistry(
          createCakeArtifactOperations(undefined, {
            persistArtifact: async () => {
              throw new Error("Presentation must not publish");
            },
            resolveArtifactForPresentation: (reference) =>
              runtime.runPromise(access.resolveForPresentation(sessionId, reference)),
          }),
        );
        for (const [index, reference] of [
          "inline-visual@r2",
          "inline-visual",
          "inline-visual@r2",
          "existing-document@r1",
        ].entries()) {
          const toolCallId = `present-${index}`;
          const result = await operations.invoke(
            { command: "artifacts.present", input: { reference } },
            { runtime: { sessionId }, toolCallId, signal: new AbortController().signal },
          );
          await conversation.commit(async (tx) => {
            await tx.appendEntry(AssistantEntry, conversation.id, {
              model: [
                {
                  role: "assistant",
                  content: [
                    {
                      type: "toolCall",
                      id: toolCallId,
                      name: "cake",
                      arguments: { command: "artifacts.present", input: { reference } },
                    },
                  ],
                  timestamp: index,
                  api: "anthropic-messages",
                  provider: "anthropic",
                  model: "visual-fixture",
                  stopReason: "toolUse",
                  usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                  },
                },
              ],
            });
            await tx.appendEntry(ToolResultEntry, conversation.id, {
              model: [
                {
                  role: "toolResult",
                  toolName: "cake",
                  toolCallId,
                  content: result.content,
                  details: result.details,
                  isError: false,
                  timestamp: index,
                },
              ],
            });
          }, BACKGROUND_CONTEXT);
        }
      } finally {
        await harness.close(BACKGROUND_CONTEXT);
        await durableStorage.close(BACKGROUND_CONTEXT);
      }
    }
    const before = await readFile(join(artifactRoot, "catalog.json"), "utf8");
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
      BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 2400),
    );
    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    const surfaces = page.locator('[data-slot="artifact-disclosure"]');
    const verify = async (selected: string) => {
      await expect(surfaces).toHaveCount(4);
      await expect(
        surfaces.nth(3).getByRole("heading", { name: "Existing document", exact: true }),
      ).toBeVisible();
      for (const [index, revision] of [2, 3, 2].entries()) {
        const frame = surfaces.nth(index).locator("iframe").contentFrame();
        await expect(
          frame.getByRole("heading", { name: `Prototype source ${revision}` }),
        ).toBeVisible();
        await expect(frame.getByText(selected, { exact: true })).toBeVisible();
      }
    };
    await verify("Selected option B");
    await page.reload();
    await verify("Selected option B");
    expect(await readFile(join(artifactRoot, "catalog.json"), "utf8")).toBe(before);
    await surfaces
      .nth(0)
      .locator("iframe")
      .contentFrame()
      .getByRole("button", { name: "Choose C" })
      .click();
    await verify("Selected option C");
    await page
      .locator(
        `[data-slot="project-header"][data-session-id="${projectId}"] [data-slot="project-label"]`,
      )
      .click();
    await verify("Selected option C");
    await page.reload();
    await verify("Selected option C");
    await mkdir(join(repositoryRoot, ".visual-captures"), { recursive: true });
    await page.screenshot({
      path: join(repositoryRoot, ".visual-captures", "cake-chat-inline-artifact.png"),
      clip: { x: 0, y: 0, width: 1280, height: 900 },
    });
  } finally {
    await app?.close();
    await runtime.dispose();
    await promisify(execFile)("chmod", ["-R", "u+w", root]);
    await rm(root, { recursive: true, force: true });
  }
});
