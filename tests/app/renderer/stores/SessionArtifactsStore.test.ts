import { Schema } from "effect";
import { createStore } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { EffectiveArtifactProjection } from "../../../../src/domain/artifacts/artifact-lineage";
import type { Client } from "../../../../src/renderer/client/Client";
import { ArtifactCatalog } from "../../../../src/renderer/models/ArtifactCatalog";
import { SessionArtifactsStore } from "../../../../src/renderer/stores/SessionArtifactsStore";
import { mountWithClient } from "../mount-with-client";

const effective = (sessionId: string, revision: number, title: string) =>
  Schema.decodeUnknownSync(EffectiveArtifactProjection)({
    revision: {
      lineageId: "shared",
      metadata: {
        revision,
        digest: "a".repeat(64),
        kind: "markdown",
        publishedAt: `2025-01-0${revision}T00:00:00.000Z`,
        publishedBySessionId: sessionId,
        workingDirectory: "/project",
      },
      snapshot: {
        protocol: "cake.artifact/v1",
        id: "shared",
        sessionId,
        revision,
        title,
        kind: "markdown",
        payload: { markdown: title },
        fallback: { markdown: title },
      },
    },
    link: {
      lineageId: "shared",
      target: { type: "family", familyId: "family-1" },
      selection: { mode: "follow-latest" },
      createdAt: "2025-01-01T00:00:00.000Z",
    },
    latestRevision: revision,
    stableRef: "cake://artifact/shared",
    exactRef: `cake://artifact/shared@r${revision}`,
  });

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("SessionArtifactsStore", () => {
  it("keeps one canonical lineage identity across multiple session panels", async () => {
    const model = ArtifactCatalog.create();
    const pending: Array<(value: ReturnType<typeof effective>[]) => void> = [];
    const client = {
      artifacts: {
        effective: vi.fn(
          () => new Promise<ReturnType<typeof effective>[]>((resolve) => pending.push(resolve)),
        ),
      },
    } as unknown as Client;
    const first = mountWithClient(
      createStore(SessionArtifactsStore, { sessionId: "session-1", model, isActive: () => true }),
      client,
    );
    const second = mountWithClient(
      createStore(SessionArtifactsStore, { sessionId: "session-2", model, isActive: () => true }),
      client,
    );
    pending[0]!([effective("session-1", 1, "One")]);
    pending[1]!([effective("session-2", 1, "One")]);
    await flush();

    expect(model.lineages).toHaveLength(1);
    expect(first.subject.records[0]?.artifact.id).toBe("shared");
    expect(second.subject.records[0]?.artifact.id).toBe("shared");
    expect(model.find("shared")).toBe(model.lineages[0]);
    expect(first.subject.associations[0]?.lineage).toBe(second.subject.associations[0]?.lineage);
    expect(first.subject.associations[0]?.link).toBe(second.subject.associations[0]?.link);
    first.root[Symbol.dispose]();
    second.root[Symbol.dispose]();
  });

  it("surfaces authoritative load failures without replacing current data", async () => {
    const client = {
      artifacts: { effective: vi.fn(async () => Promise.reject(new Error("catalog unavailable"))) },
    } as unknown as Client;
    const { root, subject } = mountWithClient(
      createStore(SessionArtifactsStore, {
        sessionId: "session-1",
        model: ArtifactCatalog.create(),
        isActive: () => true,
      }),
      client,
    );
    await flush();

    expect(subject.loading).toBe(false);
    expect(subject.error).toBe("catalog unavailable");
    expect(subject.records).toEqual([]);
    root[Symbol.dispose]();
  });

  it("exposes stable/exact copy data, family provenance, pinning, and readable projection", async () => {
    let projection = effective("session-1", 2, "Two");
    const client = {
      artifacts: {
        effective: vi.fn(async () => [projection]),
        history: vi.fn(async () => ({
          items: [projection.revision.metadata],
          offset: 0,
          limit: 50,
          total: 1,
          hasMore: false,
        })),
        materialize: vi.fn(async () => ({ exactPath: "/cache/report/revision-2.md" })),
        setSelection: vi.fn(async (input) => {
          projection = {
            ...projection,
            link: { ...projection.link, selection: input.selection },
          };
          return projection.link;
        }),
      },
    } as unknown as Client;
    const { root, subject } = mountWithClient(
      createStore(SessionArtifactsStore, {
        sessionId: "session-1",
        model: ArtifactCatalog.create(),
        isActive: () => true,
      }),
      client,
    );
    await flush();
    subject.openArtifact("shared");
    await flush();

    expect(subject.selectedAssociation?.link?.target).toEqual({
      type: "family",
      familyId: "family-1",
    });
    expect(subject.selectedStableRef).toBe("cake://artifact/shared");
    expect(subject.selectedExactRef).toBe("cake://artifact/shared@r2");
    await expect(subject.readablePath("shared" as never, 2 as never)).resolves.toBe(
      "/cache/report/revision-2.md",
    );

    await subject.pin("shared" as never, 2 as never);
    expect(client.artifacts.setSelection).toHaveBeenCalledWith(
      expect.objectContaining({ selection: { mode: "pinned", revision: 2 } }),
      expect.anything(),
    );
    expect(subject.selectedAssociation?.link?.mode).toBe("pinned");
    root[Symbol.dispose]();
  });

  it("loads and reads revisions beyond the first 50 with dedupe and retry", async () => {
    const projection = effective("session-1", 52, "Latest r52 title");
    let olderAttempts = 0;
    const client = {
      artifacts: {
        effective: vi.fn(async () => [projection]),
        history: vi.fn(async ({ offset }: { offset: number }) => {
          if (offset === 0)
            return {
              items: Array.from(
                { length: 50 },
                (_, index) =>
                  effective("session-1", 52 - index, `Revision ${52 - index}`).revision.metadata,
              ),
              offset: 0,
              limit: 50,
              total: 52,
              hasMore: true,
            };
          olderAttempts += 1;
          if (olderAttempts === 1) throw new Error("history unavailable");
          return {
            items: [3, 2, 1].map(
              (value) => effective("session-1", value, `Revision ${value}`).revision.metadata,
            ),
            offset: 50,
            limit: 50,
            total: 52,
            hasMore: false,
          };
        }),
        readExact: vi.fn(
          async (_lineageId, revision: number) =>
            effective("session-1", revision, `Historical r${revision} title`).revision,
        ),
      },
    } as unknown as Client;
    const { root, subject } = mountWithClient(
      createStore(SessionArtifactsStore, {
        sessionId: "session-1",
        model: ArtifactCatalog.create(),
        isActive: () => true,
      }),
      client,
    );
    await flush();
    subject.openArtifact("shared");
    await vi.waitFor(() => expect(subject.historyOffset).toBe(50));
    expect(subject.selectedAssociation?.lineage?.revisions).toHaveLength(50);

    await subject.loadOlderHistory();
    expect(subject.historyError).toBe("history unavailable");
    expect(subject.historyOffset).toBe(50);

    await subject.loadOlderHistory();
    expect(subject.historyHasMore).toBe(false);
    expect(subject.selectedAssociation?.lineage?.revisions).toHaveLength(52);
    await subject.viewRevision("shared" as never, 1 as never);
    expect(subject.viewedRevision).toBe(1);
    expect(subject.selectedRecord?.artifact.title).toBe("Historical r1 title");
    expect(subject.selectedAssociation?.lineage?.title).toBe("Latest r52 title");
    root[Symbol.dispose]();
  });

  it("rejects a stale refresh result", async () => {
    const pending: Array<(value: ReturnType<typeof effective>[]) => void> = [];
    const client = {
      artifacts: {
        effective: vi.fn(
          () => new Promise<ReturnType<typeof effective>[]>((resolve) => pending.push(resolve)),
        ),
      },
    } as unknown as Client;
    const model = ArtifactCatalog.create();
    const { root, subject } = mountWithClient(
      createStore(SessionArtifactsStore, { sessionId: "session-1", model, isActive: () => true }),
      client,
    );
    await flush();
    const second = subject.refresh();
    pending[1]!([effective("session-1", 2, "New")]);
    await second;
    pending[0]!([effective("session-1", 1, "Old")]);
    await flush();

    expect(subject.records[0]?.artifact.title).toBe("New");
    expect(model.find("shared")?.latestRevision).toBe(2);
    root[Symbol.dispose]();
  });
});
