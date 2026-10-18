import { it } from "@effect/vitest";
import { Effect, Queue, Schema, Stream } from "effect";
import { describe, expect, vi } from "vitest";
import {
  EffectiveArtifactProjection,
  decodeArtifactLineageId,
  type ArtifactRevision,
  type ArtifactLineageSummary,
} from "../../../../src/contracts/artifacts/artifact-lineage";
import type { ArtifactRecord } from "../../../../src/contracts/artifacts/artifact-contract";
import type { CakeEvent } from "../../../../src/contracts/application/cake-rpc-contract";
import type { CakeIpcClientService } from "../../../../src/ipc/client/CakeIpcClient";
import type { Client } from "../../../../src/renderer/client/Client";
import { observeArtifactEvents } from "../../../../src/renderer/observers/artifact-events";
import { applyConversationUpdate } from "../../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "../fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "../renderer-store-fixture";
import { observerClient, observerRuntime } from "./observer-test-runtime";

const record: ArtifactRecord = {
  artifact: {
    protocol: "cake.artifact/v1",
    id: "shared",
    sessionId: "author",
    revision: 1,
    kind: "markdown",
    payload: { markdown: "Shared" },
    fallback: { markdown: "Shared" },
  },
  workspacePath: "/project",
  digest: "b".repeat(64),
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
        publishedAt: record.createdAt,
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
      createdAt: record.createdAt,
    },
    latestRevision,
    stableRef: "cake://artifact/shared",
    exactRef: `cake://artifact/shared@r${revision}`,
  });

type ArtifactInvalidation = Extract<
  CakeEvent,
  { type: "artifact-updated" | "artifact-catalog-invalidated" }
>;

// Native events are invalidations, not artifact authority. Integrate the real
// observer with the actual loaded Registry, per-session panels and shared Model.
describe("observeArtifactEvents", () => {
  it("invalidates catalog demand while keeping board and live-state channels independent", async () => {
    type ArtifactEvent = Stream.Success<ReturnType<CakeIpcClientService["events"]["artifacts"]>>;
    const events = Effect.runSync(Queue.unbounded<ArtifactEvent>());
    const value = effective();
    const id = value.revision.lineageId;
    const revision: ArtifactRevision = {
      ...value.revision,
      metadata: { ...value.revision.metadata, kind: "message-board" },
      snapshot: {
        ...value.revision.snapshot,
        kind: "message-board",
        payload: { familyId: "family-1" },
      },
    };
    const lineage: ArtifactLineageSummary = {
      id,
      createdAt: record.createdAt,
      latestRevision: revision.metadata.revision,
      latest: revision.metadata,
      stableRef: value.stableRef,
    };
    const catalog = vi.fn<Client["artifacts"]["catalog"]>(async () => ({
      items: [lineage],
      total: 1,
      offset: 0,
      limit: 50,
      hasMore: false,
    }));
    const boardEntries = vi.fn<Client["artifacts"]["boardEntries"]>(async () => ({
      boardId: id,
      entries: [],
      nextAfter: 0,
      hasMore: false,
    }));
    let stateVersion = 0;
    const stateRead = vi.fn<Client["artifacts"]["stateRead"]>(async () => ({
      lineageId: id,
      version: ++stateVersion,
      value: { ready: true },
    }));
    using fixture = createRendererStoreFixture({
      client: {
        artifacts: {
          catalog,
          boardEntries,
          stateRead,
          detail: async () => ({ lineage, links: [], stableRef: value.stableRef }),
          readExact: async () => revision,
          history: async () => ({
            items: [revision.metadata],
            total: 1,
            offset: 0,
            limit: 50,
            hasMore: false,
          }),
        },
      },
    });
    const { root } = fixture;
    await root.artifactLibraryStore.detailStore.select(id);
    root.artifactPaneStore.open("child", id);
    root.inlineWidgetStore.bindArtifactState("widget", "child", id);
    await vi.waitFor(() => {
      expect(root.artifactPaneStore.detailStore.detailLoading).toBe(false);
      expect(root.inlineWidgetStore.artifactStates.widget?.current).toBeDefined();
      expect(root.artifactLibraryStore.loading).toBe(false);
      expect(root.artifactLibraryStore.detailStore.messageBoardStore.loading).toBe(false);
      expect(root.artifactPaneStore.detailStore.messageBoardStore.loading).toBe(false);
      expect(boardEntries).toHaveBeenCalledTimes(3);
    });
    const runtime = observerRuntime(
      observerClient({ events: { artifacts: () => Stream.fromQueue(events) } }),
    );
    const cancel = observeArtifactEvents(runtime, root);
    const send = async (event: ArtifactEvent) => {
      Queue.offerUnsafe(events, event);
      await Effect.runPromise(Queue.take(runtime.consumed));
      await vi.waitFor(() => {
        expect(root.artifactLibraryStore.detailStore.messageBoardStore.loading).toBe(false);
        expect(root.artifactPaneStore.detailStore.messageBoardStore.loading).toBe(false);
        expect(root.inlineWidgetStore.artifactStates.widget?.loading).toBe(false);
        expect(root.artifactLibraryStore.loading).toBe(false);
      });
    };
    try {
      const version = fixture.models.artifacts.invalidationVersion;
      const catalogs = catalog.mock.calls.length;
      const boards = boardEntries.mock.calls.length;
      const states = stateRead.mock.calls.length;
      await send({ type: "artifact-state-invalidated", lineageId: id });
      expect(stateRead).toHaveBeenCalledTimes(states + 1);
      expect(fixture.models.artifacts.invalidationVersion).toBe(version);
      expect(catalog).toHaveBeenCalledTimes(catalogs);
      expect(boardEntries).toHaveBeenCalledTimes(boards);
      await send({
        type: "message-board-invalidated",
        lineageId: decodeArtifactLineageId("other"),
      });
      expect(boardEntries).toHaveBeenCalledTimes(boards);
      await send({ type: "message-board-invalidated", lineageId: id });
      // The library preview and both selected viewers catch up from the same boundary.
      expect(boardEntries).toHaveBeenCalledTimes(boards + 3);
      expect(stateRead).toHaveBeenCalledTimes(states + 1);
      expect(fixture.models.artifacts.invalidationVersion).toBe(version);
      for (const event of [
        { type: "artifact-updated" as const, record },
        { type: "artifact-catalog-invalidated" as const, lineageId: id },
        { type: "renderer-events-ready" as const, channel: "artifacts" as const },
      ])
        await send(event);
      expect(fixture.models.artifacts.invalidationVersion).toBe(version + 3);
      expect(catalog).toHaveBeenCalledTimes(catalogs + 3);
      expect(stateRead).toHaveBeenCalledTimes(states + 2);
      expect(root.artifactLibraryStore.error).toBeUndefined();
      expect(root.artifactPaneStore.detailStore.error).toBeUndefined();
    } finally {
      cancel();
      await runtime.dispose();
    }
  });

  it("recovers a failed mount and missed changes at subscription readiness/reconnect, rejecting older fetches and disposed results", async () => {
    type Ready = { type: "renderer-events-ready"; channel: "artifacts" };
    const events = Effect.runSync(Queue.unbounded<Ready>());
    const pending: Array<(values: EffectiveArtifactProjection[]) => void> = [];
    const query = vi.fn<Client["artifacts"]["effective"]>(async () => {
      if (query.mock.calls.length === 1) throw new Error("Initial fetch unavailable");
      return new Promise<EffectiveArtifactProjection[]>((resolve) => pending.push(resolve));
    });
    using fixture = createRendererStoreFixture({
      projects: [projectRecord({ path: "/project", name: "Project" })],
      sessions: [sessionSummary({ sessionId: "child", projectPath: "/project" })],
      client: {
        artifacts: {
          effective: query,
          catalog: async () => ({
            items: [],
            total: 0,
            offset: 0,
            limit: 50,
            hasMore: false,
          }),
        },
      },
    });
    const session = fixture.root.sessionRegistry.load("child", "/project");
    applyConversationUpdate(session.model, {
      _tag: "Snapshot",
      revision: 1,
      snapshot: {
        sessionId: "child",
        sessionFile: "/project/child.jsonl",
        parts: [],
        models: [],
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        streaming: false,
        diagnostics: [],
        commands: [],
        compatibility: { resources: [], diagnostics: [] },
        extensionUi: { statuses: [] },
        tree: [],
      },
    });
    const panel = session.sessionArtifactsStore;
    await vi.waitFor(() => expect(panel.error).toBe("Initial fetch unavailable"));
    const runtime = observerRuntime(
      observerClient({ events: { artifacts: () => Stream.fromQueue(events) } }),
    );
    const stop = observeArtifactEvents(runtime, fixture.root);
    try {
      Queue.offerUnsafe(events, { type: "renderer-events-ready", channel: "artifacts" });
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      pending.shift()!([effective()]);
      await vi.waitFor(() => expect(panel.records).toHaveLength(1));
      // No change notification was delivered. Each fresh readiness must query current authority.
      Queue.offerUnsafe(events, { type: "renderer-events-ready", channel: "artifacts" });
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      const older = pending.shift()!;
      Queue.offerUnsafe(events, { type: "renderer-events-ready", channel: "artifacts" });
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      pending.shift()!([]);
      await vi.waitFor(() => expect(panel.records).toEqual([]));
      older([effective()]);
      await Promise.resolve();
      expect(panel.records).toEqual([]);
      Queue.offerUnsafe(events, { type: "renderer-events-ready", channel: "artifacts" });
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      stop();
      fixture.root[Symbol.dispose]();
      pending.shift()!([effective()]);
      await Promise.resolve();
      expect(fixture.models.artifacts.associationsFor("child")).toEqual([]);
    } finally {
      stop();
      await runtime.dispose();
    }
  });

  it.effect(
    "refetches authority for both event kinds so family links appear and disappear without opening panels or changing unrelated sessions",
    () =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<ArtifactInvalidation>();
        let linked = false;
        let direct = false;
        const effectiveRequest = vi.fn<Client["artifacts"]["effective"]>(async (sessionId) => {
          if (sessionId === "child" && direct) {
            const value = effective(1, 2);
            return [
              {
                ...value,
                link: {
                  ...value.link,
                  target: { type: "session", sessionId },
                  selection: { mode: "pinned", revision: value.revision.metadata.revision },
                },
              },
            ];
          }
          return linked && (sessionId === "parent" || sessionId === "child") ? [effective(2)] : [];
        });
        const catalogRequest = vi.fn<Client["artifacts"]["catalog"]>(async () => ({
          items: [],
          total: 0,
          offset: 0,
          limit: 50,
          hasMore: false,
        }));
        using fixture = createRendererStoreFixture({
          projects: [projectRecord({ path: "/project", name: "Project" })],
          sessions: [
            sessionSummary({
              sessionId: "parent",
              projectPath: "/project",
              familyId: "family-1",
              familyChildSessionIds: ["child"],
              familyDepth: 0,
            }),
            sessionSummary({
              sessionId: "child",
              projectPath: "/project",
              familyId: "family-1",
              familyParentSessionId: "parent",
              familyChildOrder: 1,
              familyDepth: 1,
            }),
            sessionSummary({ sessionId: "unrelated", projectPath: "/project" }),
          ],
          client: { artifacts: { effective: effectiveRequest, catalog: catalogRequest } },
        });
        const panels = ["parent", "child", "unrelated"].map((id) => {
          const session = fixture.root.sessionRegistry.load(id, "/project");
          applyConversationUpdate(session.model, {
            _tag: "Snapshot",
            revision: 1,
            snapshot: {
              sessionId: id,
              sessionFile: `/project/${id}.jsonl`,
              parts: [],
              models: [],
              thinkingLevel: "off",
              availableThinkingLevels: ["off"],
              streaming: false,
              diagnostics: [],
              commands: [],
              compatibility: { resources: [], diagnostics: [] },
              extensionUi: { statuses: [] },
              tree: [],
            },
          });
          return session.sessionArtifactsStore;
        });
        // Real panel mount queries initial authority; do not replace panel receive()
        // with a spy or seed their shared Model independently of that authority.
        yield* Effect.promise(() =>
          vi.waitFor(() => {
            expect(effectiveRequest).toHaveBeenCalledTimes(3);
            expect(panels.every((panel) => !panel.loading)).toBe(true);
          }),
        );
        const runtime = observerRuntime(
          observerClient({
            events: { artifacts: () => Stream.fromQueue(events) },
          }),
        );
        const cancel = observeArtifactEvents(runtime, fixture.root);
        try {
          linked = true;
          yield* Queue.offer(events, { type: "artifact-updated", record });
          yield* Queue.take(runtime.consumed);
          yield* Effect.promise(() =>
            vi.waitFor(() => {
              expect(
                panels.map((panel) => panel.records.map((value) => value.artifact.id)),
              ).toEqual([["shared"], ["shared"], []]);
            }),
          );
          expect(panels.map((panel) => panel.error)).toEqual([undefined, undefined, undefined]);
          expect(fixture.models.artifacts.find("shared")).toBeDefined();
          const immutablePayload = fixture.models.artifacts.find("shared")!.revision(2)!.snapshot;
          direct = true;
          yield* Queue.offer(events, { type: "artifact-catalog-invalidated", lineageId: "shared" });
          yield* Queue.take(runtime.consumed);
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(panels[1]!.records[0]?.artifact.revision).toBe(1)),
          );
          expect(panels[0]!.records[0]?.artifact.revision).toBe(2);
          expect(fixture.models.artifacts.find("shared")!.revision(2)!.snapshot).toBe(
            immutablePayload,
          );
          direct = false;
          yield* Queue.offer(events, { type: "artifact-catalog-invalidated", lineageId: "shared" });
          yield* Queue.take(runtime.consumed);
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(panels[1]!.records[0]?.artifact.revision).toBe(2)),
          );
          expect(fixture.models.artifacts.find("shared")!.revision(2)!.snapshot).toBe(
            immutablePayload,
          );
          linked = false;
          yield* Queue.offer(events, { type: "artifact-catalog-invalidated", lineageId: "shared" });
          yield* Queue.take(runtime.consumed);
          yield* Effect.promise(() =>
            vi.waitFor(() => {
              expect(panels.map((panel) => panel.records)).toEqual([[], [], []]);
            }),
          );
          for (const id of ["parent", "child", "unrelated"]) {
            expect(
              effectiveRequest.mock.calls.filter(([sessionId]) => sessionId === id),
            ).toHaveLength(5);
          }
          expect(catalogRequest).toHaveBeenCalled();
          expect(fixture.root.artifactLibraryStore.error).toBeUndefined();
          cancel();
          yield* Effect.promise(() => runtime.dispose());
          const refreshes = effectiveRequest.mock.calls.length;
          linked = true;
          yield* Queue.offer(events, { type: "artifact-catalog-invalidated", lineageId: "shared" });
          expect(effectiveRequest).toHaveBeenCalledTimes(refreshes);
          expect(panels.map((panel) => panel.records)).toEqual([[], [], []]);
        } finally {
          cancel();
          yield* Effect.promise(() => runtime.dispose());
        }
      }),
  );
});
