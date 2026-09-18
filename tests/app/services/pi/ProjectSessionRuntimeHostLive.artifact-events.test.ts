import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import * as artifactWorkflows from "../../../../src/domain/artifacts/artifactWorkflows";
import { ArtifactLineageId } from "../../../../src/domain/artifacts/artifact-lineage";
import type { CakeArtifactV1 } from "../../../../src/ipc/artifact-contract";
import type { CakeEvent } from "../../../../src/ipc/cake-rpc-contract";
import { makeArtifactProjectionLive } from "../../../../src/services/artifacts/ArtifactProjectionLive";
import { Electron } from "../../../../src/services/electron/Electron";
import { PiModels } from "../../../../src/services/pi/PiModels";
import type { ProjectSessionRuntimeIntegrations } from "../../../../src/services/pi/ProjectSessionIntegrationHost";
import { ProjectSessionRuntimeHost } from "../../../../src/services/pi/ProjectSessionRuntimeHost";
import { makeProjectSessionRuntimeHostLive } from "../../../../src/services/pi/ProjectSessionRuntimeHostLive";
import { RendererRequestCoordinator } from "../../../../src/services/renderer-requests/RendererRequestCoordinator";
import { ArtifactStorage } from "../../../../src/services/storage/ArtifactStorage";
import { makeArtifactStorageLive } from "../../../../src/services/storage/ArtifactStorageLive";
import { ReviewStorage } from "../../../../src/services/storage/ReviewStorage";
import {
  makeSessionFamilyStorageLive,
  SessionFamilyStorage,
} from "../../../../src/services/storage/SessionFamilyStorage";
import { RenderedWidgetCapture } from "../../../../src/services/widgets/RenderedWidgetCapture";

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
  const root = await mkdtemp(join(tmpdir(), "cake-runtime-artifact-events-"));
  roots.push(root);
  const events: CakeEvent[] = [];
  const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
  const dependencies = Layer.mergeAll(
    makeArtifactStorageLive(join(root, "artifacts")).pipe(Layer.provide(platform)),
    makeSessionFamilyStorageLive(join(root, "session-families.json")).pipe(Layer.provide(platform)),
    makeArtifactProjectionLive(join(root, "projection-cache")).pipe(Layer.provide(platform)),
    Layer.mock(Electron, {
      broadcast: (event) => {
        events.push(event);
      },
      sendTo: () => undefined,
      requireRendererConnection: () => {
        throw new Error("No renderer connection in this test");
      },
      workspaceForConnection: () => undefined,
      associateWorkspace: () => undefined,
      forgetWorkspace: () => undefined,
      windowsForWorkspace: () => [],
      centerTrafficLights: () => undefined,
    }),
    Layer.mock(RendererRequestCoordinator, {
      registerProjectSession: () => Effect.void,
      releaseSession: () => Effect.void,
      releaseWorkingDirectory: () => Effect.void,
    }),
    Layer.mock(PiModels, {}),
    Layer.mock(RenderedWidgetCapture, {}),
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
