import { Effect, Queue, Schema, Stream } from "effect";
import { createStore } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { EffectiveArtifactProjection } from "../../../../src/domain/artifacts/artifact-lineage";
import type { ArtifactRecord } from "../../../../src/ipc/artifact-contract";
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

const effective = () =>
  Schema.decodeUnknownSync(EffectiveArtifactProjection)({
    revision: {
      lineageId: "shared",
      metadata: {
        revision: 1,
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
        revision: 1,
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
    latestRevision: 1,
    stableRef: "cake://artifact/shared",
    exactRef: "cake://artifact/shared@r1",
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
  it("patches the loaded Session projection directly", async () => {
    const projection = RootProjection.create();
    const client = {
      events: {
        artifacts: () =>
          Stream.concat(
            Stream.make(
              { type: "artifact-updated" as const, record },
              { type: "artifact-catalog-invalidated" as const, lineageId: "shared" },
            ),
            Stream.never,
          ),
      },
    } as unknown as CakeIpcClientService;

    const refresh = vi.fn();
    const root = {
      sessionRegistry: { sessions: [{ sessionArtifactsStore: { receive: refresh } }] },
      artifactLibraryStore: { load: vi.fn(async () => undefined) },
      projectWorkbenchStore: { setError: vi.fn() },
    } as unknown as RootStore;
    const cancel = observeArtifactEvents(runtimeFor(client), projection, root);

    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(refresh).toHaveBeenNthCalledWith(1, "artifact");
    expect(refresh).toHaveBeenNthCalledWith(2, "shared");
    cancel();
    projection[Symbol.dispose]();
  });

  it("refreshes every loaded panel so family links appear and disappear without affecting unrelated sessions", async () => {
    const events = Effect.runSync(
      Queue.unbounded<{ type: "artifact-catalog-invalidated"; lineageId: string }>(),
    );
    let linked = false;
    const effectiveRequest = vi.fn(async (sessionId: string) =>
      linked && (sessionId === "parent" || sessionId === "child") ? [effective()] : [],
    );
    const client = {
      artifacts: { effective: effectiveRequest },
      events: { artifacts: () => Stream.fromQueue(events) },
    } as unknown as Client & CakeIpcClientService;
    const catalog = ArtifactCatalog.create();
    const parent = mountWithClient(
      createStore(SessionArtifactsStore, {
        sessionId: "parent",
        model: catalog,
        isActive: () => true,
      }),
      client,
    );
    const child = mountWithClient(
      createStore(SessionArtifactsStore, {
        sessionId: "child",
        model: catalog,
        isActive: () => false,
      }),
      client,
    );
    const unrelated = mountWithClient(
      createStore(SessionArtifactsStore, {
        sessionId: "unrelated",
        model: catalog,
        isActive: () => false,
      }),
      client,
    );
    await vi.waitFor(() => expect(effectiveRequest).toHaveBeenCalledTimes(3));

    const projection = RootProjection.create();
    const root = {
      sessionRegistry: {
        sessions: [
          { sessionArtifactsStore: parent.subject },
          { sessionArtifactsStore: child.subject },
          { sessionArtifactsStore: unrelated.subject },
        ],
      },
      artifactLibraryStore: { load: vi.fn(async () => undefined) },
      projectWorkbenchStore: { setError: vi.fn() },
    } as unknown as RootStore;
    const cancel = observeArtifactEvents(runtimeFor(client), projection, root);

    linked = true;
    Queue.offerUnsafe(events, { type: "artifact-catalog-invalidated", lineageId: "shared" });
    await vi.waitFor(() => {
      expect(parent.subject.records.map((value) => value.artifact.id)).toEqual(["shared"]);
      expect(child.subject.records.map((value) => value.artifact.id)).toEqual(["shared"]);
      expect(unrelated.subject.records).toEqual([]);
    });

    linked = false;
    Queue.offerUnsafe(events, { type: "artifact-catalog-invalidated", lineageId: "shared" });
    await vi.waitFor(() => {
      expect(parent.subject.records).toEqual([]);
      expect(child.subject.records).toEqual([]);
      expect(unrelated.subject.records).toEqual([]);
    });

    expect(effectiveRequest.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      "parent",
      "child",
      "unrelated",
      "parent",
      "child",
      "unrelated",
      "parent",
      "child",
      "unrelated",
    ]);
    cancel();
    projection[Symbol.dispose]();
    parent.root[Symbol.dispose]();
    child.root[Symbol.dispose]();
    unrelated.root[Symbol.dispose]();
  });
});
