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
import type { CakeIpcClientService } from "../../../../src/ipc/client/CakeIpcClient";
import type { Client } from "../../../../src/renderer/client/Client";
import { observeArtifactEvents } from "../../../../src/renderer/observers/artifact-events";
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
    root.artifactMenuStore.open("child", id);
    root.inlineWidgetStore.bindArtifactState("widget", "child", id);
    await vi.waitFor(() => {
      expect(root.artifactMenuStore.detailStore.detailLoading).toBe(false);
      expect(root.inlineWidgetStore.artifactStates.widget?.current).toBeDefined();
      expect(root.artifactLibraryStore.loading).toBe(false);
      expect(root.artifactLibraryStore.detailStore.messageBoardStore.loading).toBe(false);
      expect(root.artifactMenuStore.detailStore.messageBoardStore.loading).toBe(false);
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
        expect(root.artifactMenuStore.detailStore.messageBoardStore.loading).toBe(false);
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
      expect(root.artifactMenuStore.detailStore.error).toBeUndefined();
    } finally {
      cancel();
      await runtime.dispose();
    }
  });
});
