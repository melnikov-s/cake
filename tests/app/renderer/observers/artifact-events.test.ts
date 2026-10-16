import { Effect, Queue, Schema, Stream } from "effect";
import { createStore } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { EffectiveArtifactProjection } from "../../../../src/contracts/artifacts/artifact-lineage";
import type { ArtifactRecord } from "../../../../src/contracts/artifacts/artifact-contract";
import { CakeIpcClient, type CakeIpcClientService } from "../../../../src/ipc/client/CakeIpcClient";
import type { Client } from "../../../../src/renderer/client/Client";
import { ArtifactCatalog } from "../../../../src/renderer/models/ArtifactCatalog";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import { observeArtifactEvents, observeStream } from "../../../../src/renderer/observers";
import type { Runtime } from "../../../../src/renderer/runtime";
import type { RootStore } from "../../../../src/renderer/stores/RootStore";
import { SessionArtifactsStore } from "../../../../src/renderer/stores/SessionArtifactsStore";
import { mountWithClient } from "../mount-with-client";

const record: ArtifactRecord = {
  artifact: {
    protocol: "cake.artifact/v1",
    id: "artifact",
    sessionId: "session",
    revision: 1,
    kind: "markdown",
    payload: { markdown: "# Artifact" },
    fallback: { markdown: "Artifact" },
  },
  workspacePath: "/project",
  digest: "a".repeat(64),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const effective = (revision = 1, latestRevision = revision) =>
  Schema.decodeUnknownSync(EffectiveArtifactProjection)({
    revision: {
      lineageId: "shared",
      metadata: {
        revision,
        digest: "b".repeat(64),
        kind: "markdown",
        publishedAt: "2026-01-01T00:00:00.000Z",
        publishedBySessionId: "author",
        workingDirectory: "/project",
      },
      snapshot: {
        protocol: "cake.artifact/v1",
        id: "shared",
        sessionId: "author",
        revision,
        kind: "markdown",
        payload: { markdown: "Shared" },
        fallback: { markdown: "Shared" },
      },
    },
    link: {
      lineageId: "shared",
      target: { type: "family", familyId: "family-1" },
      selection: { mode: "follow-latest" },
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    latestRevision,
    stableRef: "cake://artifact/shared",
    exactRef: `cake://artifact/shared@r${revision}`,
  });

const runtimeFor = (client: CakeIpcClientService): Runtime => {
  const execute: Runtime["execute"] = (effect, signal) =>
    Effect.runPromise(
      Effect.provideService(effect, CakeIpcClient, client),
      signal ? { signal } : undefined,
    );
  return {
    execute,
    observe: (source, consume, options) => observeStream(execute, source, consume, options),
    dispose: async () => undefined,
  };
};

describe("observeArtifactEvents", () => {
  it("invalidates catalog demand while keeping board and live-state channels independent", async () => {
    const projection = RootProjection.create();
    const client = {
      events: {
        artifacts: () =>
          Stream.concat(
            Stream.make(
              { type: "artifact-state-invalidated" as const, lineageId: "shared" },
              { type: "artifact-updated" as const, record },
              { type: "artifact-catalog-invalidated" as const, lineageId: "shared" },
              { type: "message-board-invalidated" as const, lineageId: "shared" },
              { type: "renderer-events-ready" as const, channel: "artifacts" as const },
            ),
            Stream.never,
          ),
      },
    } as unknown as CakeIpcClientService;

    const root = {
      props: { projection },
      inlineWidgetStore: { refreshArtifactState: vi.fn() },
      artifactLibraryStore: { load: vi.fn(async () => undefined), receiveBoardChange: vi.fn() },
      artifactPaneStore: { receiveBoardChange: vi.fn() },
      projectWorkbenchStore: { setError: vi.fn() },
    } as unknown as RootStore;
    const cancel = observeArtifactEvents(runtimeFor(client), root);

    await vi.waitFor(() => expect(projection.artifacts.invalidationVersion).toBe(3));
    await vi.waitFor(() =>
      expect(root.artifactLibraryStore.receiveBoardChange).toHaveBeenCalledTimes(4),
    );
    expect(root.artifactLibraryStore.receiveBoardChange).toHaveBeenNthCalledWith(3, "shared");
    expect(root.artifactLibraryStore.receiveBoardChange).toHaveBeenNthCalledWith(4);
    expect(root.inlineWidgetStore.refreshArtifactState).toHaveBeenNthCalledWith(1, "shared");
    expect(root.inlineWidgetStore.refreshArtifactState).toHaveBeenNthCalledWith(2);
    expect(root.artifactPaneStore.receiveBoardChange).toHaveBeenCalledTimes(4);
    expect(root.artifactPaneStore.receiveBoardChange).toHaveBeenNthCalledWith(1, "artifact");
    expect(root.artifactPaneStore.receiveBoardChange).toHaveBeenNthCalledWith(2, "shared");
    expect(root.artifactPaneStore.receiveBoardChange).toHaveBeenNthCalledWith(3, "shared");
    expect(root.artifactPaneStore.receiveBoardChange).toHaveBeenNthCalledWith(4);
    cancel();
    projection[Symbol.dispose]();
  });

  it("recovers a failed mount and missed changes at subscription readiness/reconnect, rejecting older fetches and disposed results", async () => {
    type Ready = { type: "renderer-events-ready"; channel: "artifacts" };
    const events = Effect.runSync(Queue.unbounded<Ready>());
    const pending: Array<(values: EffectiveArtifactProjection[]) => void> = [];
    const query = vi.fn(async () => {
      if (query.mock.calls.length === 1) throw new Error("Initial fetch unavailable");
      return new Promise<EffectiveArtifactProjection[]>((resolve) => pending.push(resolve));
    });
    const client = {
      artifacts: { effective: query },
      events: { artifacts: () => Stream.fromQueue(events) },
    } as unknown as Client & CakeIpcClientService;
    const projection = RootProjection.create();
    const mounted = mountWithClient(
      createStore(SessionArtifactsStore, {
        sessionId: "child",
        model: projection.artifacts,
      }),
      client,
    );
    await vi.waitFor(() => expect(mounted.subject.error).toBe("Initial fetch unavailable"));
    const root = {
      props: { projection },
      inlineWidgetStore: { refreshArtifactState: vi.fn() },
      artifactLibraryStore: { receiveBoardChange: vi.fn() },
      artifactPaneStore: { receiveBoardChange: vi.fn() },
      projectWorkbenchStore: { setError: vi.fn() },
    } as unknown as RootStore;
    const stop = observeArtifactEvents(runtimeFor(client), root);
    Queue.offerUnsafe(events, { type: "renderer-events-ready", channel: "artifacts" });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending.shift()!([effective()]);
    await vi.waitFor(() => expect(mounted.subject.records).toHaveLength(1));
    // No change notification was delivered. Each fresh readiness must query current authority.
    Queue.offerUnsafe(events, { type: "renderer-events-ready", channel: "artifacts" });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const older = pending.shift()!;
    Queue.offerUnsafe(events, { type: "renderer-events-ready", channel: "artifacts" });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending.shift()!([]);
    await vi.waitFor(() => expect(mounted.subject.records).toEqual([]));
    older([effective()]);
    await Promise.resolve();
    expect(mounted.subject.records).toEqual([]);
    Queue.offerUnsafe(events, { type: "renderer-events-ready", channel: "artifacts" });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    stop();
    mounted.root[Symbol.dispose]();
    pending.shift()!([effective()]);
    await Promise.resolve();
    expect(projection.artifacts.associationsFor("child")).toEqual([]);
    projection[Symbol.dispose]();
  });

  it("refreshes every loaded panel so family links appear and disappear without affecting unrelated sessions", async () => {
    const events = Effect.runSync(
      Queue.unbounded<{ type: "artifact-catalog-invalidated"; lineageId: string }>(),
    );
    let linked = false;
    let direct = false;
    const effectiveRequest = vi.fn(async (sessionId: string) => {
      if (sessionId === "child" && direct) {
        const value = effective(1, 2);
        return [
          {
            ...value,
            link: {
              ...value.link,
              target: { type: "session" as const, sessionId },
              selection: { mode: "pinned" as const, revision: value.revision.metadata.revision },
            },
          },
        ];
      }
      return linked && (sessionId === "parent" || sessionId === "child") ? [effective(2)] : [];
    });
    const client = {
      artifacts: { effective: effectiveRequest },
      events: { artifacts: () => Stream.fromQueue(events) },
    } as unknown as Client & CakeIpcClientService;
    const catalog = ArtifactCatalog.create();
    const parent = mountWithClient(
      createStore(SessionArtifactsStore, {
        sessionId: "parent",
        model: catalog,
      }),
      client,
    );
    const child = mountWithClient(
      createStore(SessionArtifactsStore, {
        sessionId: "child",
        model: catalog,
      }),
      client,
    );
    const unrelated = mountWithClient(
      createStore(SessionArtifactsStore, {
        sessionId: "unrelated",
        model: catalog,
      }),
      client,
    );
    await vi.waitFor(() => expect(effectiveRequest).toHaveBeenCalledTimes(3));

    const projection = RootProjection.create();
    const root = {
      inlineWidgetStore: { refreshArtifactState: vi.fn() },
      props: { projection: { artifacts: catalog } },
      artifactLibraryStore: { load: vi.fn(async () => undefined), receiveBoardChange: vi.fn() },
      artifactPaneStore: { receiveBoardChange: vi.fn() },
      projectWorkbenchStore: { setError: vi.fn() },
    } as unknown as RootStore;
    const cancel = observeArtifactEvents(runtimeFor(client), root);

    linked = true;
    Queue.offerUnsafe(events, { type: "artifact-catalog-invalidated", lineageId: "shared" });
    await vi.waitFor(() => {
      expect(parent.subject.records.map((value) => value.artifact.id)).toEqual(["shared"]);
      expect(child.subject.records.map((value) => value.artifact.id)).toEqual(["shared"]);
      expect(unrelated.subject.records).toEqual([]);
    });

    const immutablePayload = catalog.find("shared")!.revision(2)!.snapshot;
    direct = true;
    Queue.offerUnsafe(events, { type: "artifact-catalog-invalidated", lineageId: "shared" });
    await vi.waitFor(() => {
      expect(parent.subject.records[0]?.artifact.revision).toBe(2);
      expect(child.subject.records[0]?.artifact.revision).toBe(1);
      expect(unrelated.subject.records).toEqual([]);
    });
    expect(catalog.find("shared")!.revision(2)!.snapshot).toBe(immutablePayload);
    direct = false;
    Queue.offerUnsafe(events, { type: "artifact-catalog-invalidated", lineageId: "shared" });
    await vi.waitFor(() => expect(child.subject.records[0]?.artifact.revision).toBe(2));
    expect(catalog.find("shared")!.revision(2)!.snapshot).toBe(immutablePayload);

    linked = false;
    Queue.offerUnsafe(events, { type: "artifact-catalog-invalidated", lineageId: "shared" });
    await vi.waitFor(() => {
      expect(parent.subject.records).toEqual([]);
      expect(child.subject.records).toEqual([]);
      expect(unrelated.subject.records).toEqual([]);
    });

    for (const sessionId of ["parent", "child", "unrelated"])
      expect(effectiveRequest.mock.calls.filter(([id]) => id === sessionId)).toHaveLength(5);
    cancel();
    projection[Symbol.dispose]();
    parent.root[Symbol.dispose]();
    child.root[Symbol.dispose]();
    unrelated.root[Symbol.dispose]();
  });
});
