import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import * as artifactWorkflows from "../../../../src/domain/artifacts/artifactWorkflows";
import { ArtifactLineageId } from "../../../../src/contracts/artifacts/artifact-lineage";
import type { CakeArtifactV1 } from "../../../../src/contracts/artifacts/artifact-contract";
import type { CakeEvent } from "../../../../src/contracts/application/cake-rpc-contract";
import { ArtifactProjection } from "../../../../src/services/artifacts/ArtifactProjection";
import { CakeOperationRegistry } from "../../../../src/services/pi/runtime/cake-operation-registry";
import { createCakeArtifactOperations } from "../../../../src/domain/artifacts/cake-artifact-operations";
import { makeArtifactProjectionLive } from "../../../../src/services/artifacts/ArtifactProjectionLive";
import { ClientEvents } from "../../../../src/services/clients/ClientEvents";
import { PiModels } from "../../../../src/services/pi/PiModels";
import type { ProjectSessionRuntimeIntegrations } from "../../../../src/services/pi/ProjectSessionRuntimeHost";
import { ProjectSessionRuntimeHost } from "../../../../src/services/pi/ProjectSessionRuntimeHost";
import { makeProjectSessionRuntimeHostLive } from "../../../../src/layers/ProjectSessionRuntimeHostLive";
import { RendererRequestCoordinator } from "../../../../src/services/renderer-requests/RendererRequestCoordinator";
import { ArtifactStorage } from "../../../../src/services/storage/ArtifactStorage";
import { makeMessageBoardStorageLive } from "../../../../src/services/storage/MessageBoardStorageLive";
import { makeArtifactStorageLive } from "../../../../src/services/storage/ArtifactStorageLive";
import { makeSessionArchiveStorageLive } from "../../../../src/services/storage/SessionArchiveStorageLive";
import { ReviewStorage } from "../../../../src/services/storage/ReviewStorage";
import {
  makeSessionFamilyStorageLive,
  SessionFamilyStorage,
} from "../../../../src/services/storage/SessionFamilyStorage";
import { RenderedWidgetCapture } from "../../../../src/services/widgets/RenderedWidgetCapture";
import { WidgetPackages } from "../../../../src/services/widgets/WidgetPackages";
import { makeWidgetBrowserOutputsLive } from "../../../../src/services/widgets/WidgetBrowserOutputsLive";

const roots: string[] = [];
const disposals: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const markdown = (
  id: string,
  sessionId: string,
  revision: number,
  text: string,
): CakeArtifactV1 => ({
  protocol: "cake.artifact/v1",
  id,
  sessionId,
  revision,
  kind: "markdown",
  title: id,
  payload: { markdown: text },
  fallback: { markdown: text },
  interaction: { mode: "present" },
});

const provideArtifactServices = <A, E>(
  effect: Effect.Effect<A, E, ArtifactStorage | SessionFamilyStorage>,
  artifacts: ArtifactStorage["Service"],
  families: SessionFamilyStorage["Service"],
) =>
  effect.pipe(
    Effect.provideService(ArtifactStorage, artifacts),
    Effect.provideService(SessionFamilyStorage, families),
  );

const makeHarness = async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-session-runtime-artifact-events-"));
  roots.push(root);
  const events: CakeEvent[] = [];
  const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
  const dependencies = Layer.mergeAll(
    makeArtifactStorageLive(join(root, "artifacts")).pipe(Layer.provide(platform)),
    makeMessageBoardStorageLive(join(root, "artifacts")).pipe(Layer.provide(platform)),
    makeSessionArchiveStorageLive(join(root, "resolved-project-metadata"), {
      activeRoot: join(root, "sessions"),
      resolvedRoot: join(root, "resolved-sessions"),
    }).pipe(Layer.provide(platform)),
    makeSessionFamilyStorageLive(join(root, "session-families.json")).pipe(Layer.provide(platform)),
    makeArtifactProjectionLive(join(root, "projection-cache")).pipe(Layer.provide(platform)),
    Layer.mock(ClientEvents, {
      sendTo: () => false,
      broadcast: (event) => {
        events.push(event);
      },
    }),
    Layer.mock(RendererRequestCoordinator, {
      registerProjectSession: () => Effect.void,
      releaseSession: () => Effect.void,
      releaseWorkingDirectory: () => Effect.void,
    }),
    Layer.mock(PiModels, {}),
    Layer.mock(RenderedWidgetCapture, {}),
    Layer.mock(WidgetPackages, { directory: join(root, "widget-packages") }),
    makeWidgetBrowserOutputsLive(join(root, "artifacts", "browser-outputs")),
    Layer.mock(ReviewStorage, {
      agentSessionDirectory: (workingDirectory, sessionId, threadId) =>
        join(workingDirectory, ".cake", sessionId, threadId),
      reviewContextPath: (workingDirectory, sessionId) =>
        join(workingDirectory, ".cake", `${sessionId}.md`),
      discussionParentContextPath: (workingDirectory, sessionId, threadId) =>
        join(workingDirectory, ".cake", sessionId, `${threadId}.md`),
    }),
  );
  const runtime = ManagedRuntime.make(
    makeProjectSessionRuntimeHostLive({
      agentDirectory: join(root, "agent"),
      sessionDirectory: join(root, "sessions"),
      widgetSessionDirectory: join(root, "widget-sessions"),
    }).pipe(Layer.provideMerge(dependencies)),
  );
  disposals.push(() => runtime.dispose());
  const services = await runtime.runPromise(
    Effect.all({
      artifacts: ArtifactStorage,
      families: SessionFamilyStorage,
      host: ProjectSessionRuntimeHost,
    }),
  );
  return { ...services, events, root, runtime };
};

const requireArtifactOperations = (integration: ProjectSessionRuntimeIntegrations) => {
  const { linkArtifact, unlinkArtifact, persistArtifact } = integration;
  if (!linkArtifact || !unlinkArtifact || !persistArtifact)
    throw new Error("Expected project artifact runtime integrations");
  return { linkArtifact, unlinkArtifact, persistArtifact };
};

const effectiveLineageIds = (
  sessionId: string,
  artifacts: ArtifactStorage["Service"],
  families: SessionFamilyStorage["Service"],
) =>
  Effect.runPromise(
    provideArtifactServices(
      artifactWorkflows.listEffectiveSessionArtifacts(sessionId),
      artifacts,
      families,
    ).pipe(Effect.map((items) => items.map((item) => item.revision.lineageId))),
  );

describe("ProjectSessionRuntimeHostLive artifact events", () => {
  it("hands off an accepted image and retrieves the pinned revision in an independent session after replacement", async () => {
    const { host, root, runtime } = await makeHarness();
    const parent = await runtime.runPromise(host.runtimeIntegrations(root, "parent"));
    const independent = await runtime.runPromise(host.runtimeIntegrations(root, "independent"));
    const makeRegistry = (integration: ProjectSessionRuntimeIntegrations) =>
      new CakeOperationRegistry(
        createCakeArtifactOperations(
          { appendEntry: () => undefined },
          {
            ...integration,
            persistArtifact: requireArtifactOperations(integration).persistArtifact,
            generateInlineWidget: async () => ({
              language: "react",
              source: "export default function First(){return <main>Approved</main>}",
              generationSessionId: "private-generation",
              browser: { digest: "a".repeat(64) },
              preview: {
                mimeType: "image/png",
                data: Buffer.from("accepted-r1").toString("base64"),
              },
            }),
          },
        ),
      );
    const context = (sessionId: string) => ({
      signal: new AbortController().signal,
      toolCallId: "handoff",
      runtime: {
        sessionId: sessionId,
        sessionFile: "/sessions/parent.jsonl",
        entryId: "assistant",
      },
    });
    const published = await makeRegistry(parent).invoke(
      {
        command: "widgets.present",
        input: {
          widget: {
            id: "approved-design",
            title: "Approved",
            brief: "Intent only",
            fallback: { markdown: "Fallback" },
          },
        },
      },
      context("parent"),
    );
    expect(published.content[1]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: Buffer.from("accepted-r1").toString("base64"),
    });
    expect(published.details).toMatchObject({
      result: { exactRef: "cake://artifact/approved-design@r1" },
    });

    const resolved = await parent.resolveArtifact!("cake://artifact/approved-design@r1");
    if (resolved.record.artifact.kind !== "widget") throw new Error("Expected widget");
    await parent.persistArtifact!({
      ...resolved.record.artifact,
      revision: 2,
      payload: {
        ...resolved.record.artifact.payload,
        source: "export default function Second(){return <main>Different</main>}",
        preview: { mimeType: "image/png", data: Buffer.from("accepted-r2").toString("base64") },
      },
    });
    const registry = makeRegistry(independent);
    const request = {
      command: "artifacts.preview",
      input: { reference: "cake://artifact/approved-design@r1" },
    };
    await expect(registry.invoke(request, context("independent"))).rejects.toThrow();
    await independent.linkArtifact!(request.input.reference);
    const preview = await registry.invoke(request, context("independent"));
    expect(preview.content[1]).toEqual(published.content[1]);
    expect(preview.details).toMatchObject({
      result: {
        selectedRevision: 1,
        latestRevision: 2,
        linkMode: "pinned",
        exactRef: request.input.reference,
      },
    });
    expect(preview.text).not.toContain("private-generation");
    expect(preview.text).not.toContain("export default");
    const pinned = await independent.resolveArtifact!(request.input.reference);
    expect(await readFile(join(pinned.metadata.exactPath, "preview.png"), "utf8")).toBe(
      "accepted-r1",
    );
    expect(await readFile(join(pinned.metadata.exactPath, "source.tsx.txt"), "utf8")).toContain(
      "function First",
    );
    expect(pinned.record.digest).toBe(resolved.record.digest);
    // Disposable cache removal must not lose the stored capture or change revision selection.
    await runtime.runPromise(
      Effect.flatMap(ArtifactProjection, (projection) => projection.cleanupSession("independent")),
    );
    expect((await registry.invoke(request, context("independent"))).content[1]).toEqual(
      published.content[1],
    );
    const second = await parent.resolveArtifact!("cake://artifact/approved-design@r2");
    expect(await readFile(join(second.metadata.exactPath, "preview.png"), "utf8")).toBe(
      "accepted-r2",
    );
    await independent.unlinkArtifact!("approved-design");
    await parent.unlinkArtifact!("approved-design");
  });
  it("invalidates successful agent family links and unlinks but not failed mutations", async () => {
    const { artifacts, families, host, events, root, runtime } = await makeHarness();
    await runtime.runPromise(
      families.addChild({
        familyId: "family-1",
        parentSessionId: "parent",
        parentWorkingDirectory: root,
        childSessionId: "child",
        childWorkingDirectory: root,
        requestId: "request-1",
        projectPath: root,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const lineageId = Schema.decodeUnknownSync(ArtifactLineageId)("shared");
    await runtime.runPromise(
      artifacts.publish({
        lineageId,
        expectedLatestRevision: 0,
        snapshot: markdown("shared", "author", 1, "Shared"),
        workingDirectory: root,
      }),
    );
    const integration = requireArtifactOperations(
      await runtime.runPromise(host.runtimeIntegrations(root, "parent")),
    );

    await integration.linkArtifact("cake://artifact/shared");

    expect(events).toEqual([{ type: "artifact-catalog-invalidated", lineageId: "shared" }]);
    await expect(effectiveLineageIds("parent", artifacts, families)).resolves.toEqual(["shared"]);
    await expect(effectiveLineageIds("child", artifacts, families)).resolves.toEqual(["shared"]);
    await expect(effectiveLineageIds("unrelated", artifacts, families)).resolves.toEqual([]);

    events.length = 0;
    await expect(integration.linkArtifact("cake://artifact/missing")).rejects.toThrow();
    expect(events).toEqual([]);

    await integration.unlinkArtifact("shared");

    expect(events).toEqual([{ type: "artifact-catalog-invalidated", lineageId: "shared" }]);
    await expect(effectiveLineageIds("parent", artifacts, families)).resolves.toEqual([]);
    await expect(effectiveLineageIds("child", artifacts, families)).resolves.toEqual([]);
    await expect(effectiveLineageIds("unrelated", artifacts, families)).resolves.toEqual([]);

    events.length = 0;
    await expect(integration.unlinkArtifact("shared")).rejects.toThrow();
    expect(events).toEqual([]);
  });

  it("keeps create and update on their existing artifact-updated event path", async () => {
    const { host, events, root, runtime } = await makeHarness();
    const integration = requireArtifactOperations(
      await runtime.runPromise(host.runtimeIntegrations(root, "parent")),
    );

    await integration.persistArtifact(markdown("created", "parent", 1, "One"));
    await integration.persistArtifact(markdown("created", "parent", 2, "Two"));

    expect(events.map((event) => event.type)).toEqual(["artifact-updated", "artifact-updated"]);
    expect(
      events.map((event) =>
        event.type === "artifact-updated" ? event.record.artifact.revision : undefined,
      ),
    ).toEqual([1, 2]);
  });
});
