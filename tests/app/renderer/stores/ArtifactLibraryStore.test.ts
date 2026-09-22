import { createStore } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type {
  ArtifactLineageDetail,
  ArtifactLineageId,
  ArtifactLineagePage,
  ArtifactRevision,
  ArtifactRevisionNumber,
  ArtifactRevisionPage,
  ArtifactTextComparison,
} from "../../../../src/domain/artifacts/artifact-lineage";
import type { Client } from "../../../../src/renderer/client/Client";
import { ArtifactCatalog } from "../../../../src/renderer/models/ArtifactCatalog";
import { ArtifactLibraryStore } from "../../../../src/renderer/stores/ArtifactLibraryStore";
import { mountWithClient } from "../mount-with-client";

const id = "report" as ArtifactLineageId;
const revisionNumber = (value: number) => value as ArtifactRevisionNumber;
const metadata = (revision: number) => ({
  revision: revisionNumber(revision),
  digest: "a".repeat(64) as never,
  kind: "markdown" as const,
  publishedAt: `2025-01-0${revision}T00:00:00.000Z`,
  publishedBySessionId: "session-1",
  workingDirectory: "/project",
});
const revision = (value: number): ArtifactRevision => ({
  lineageId: id,
  metadata: metadata(value),
  snapshot: {
    protocol: "cake.artifact/v1",
    id,
    sessionId: "session-1",
    revision: value,
    title: "Quarterly report",
    kind: "markdown",
    payload: { markdown: `revision ${value}` },
    fallback: { markdown: `revision ${value}` },
  },
});
const page: ArtifactLineagePage = {
  items: [
    {
      id,
      createdAt: "2025-01-01T00:00:00.000Z",
      latestRevision: revisionNumber(2),
      latest: metadata(2),
      title: "Quarterly report",
      stableRef: "cake://artifact/report" as never,
    },
  ],
  offset: 0,
  limit: 50,
  total: 1,
  hasMore: false,
};
const detail: ArtifactLineageDetail = {
  lineage: page.items[0]!,
  links: [
    {
      lineageId: id,
      target: { type: "family", familyId: "family-1" },
      selection: { mode: "follow-latest" },
      createdAt: "2025-01-01T00:00:00.000Z",
    },
  ],
  stableRef: "cake://artifact/report" as never,
};
const history: ArtifactRevisionPage = {
  items: [metadata(2), metadata(1)],
  offset: 0,
  limit: 50,
  total: 2,
  hasMore: false,
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("ArtifactLibraryStore and ArtifactDetailStore", () => {
  it("runs search → detail → historical read → restore through the typed client", async () => {
    let restored = false;
    const client = {
      artifacts: {
        catalog: vi.fn(async () => page),
        detail: vi.fn(async () =>
          restored
            ? {
                ...detail,
                lineage: {
                  ...detail.lineage,
                  latestRevision: revisionNumber(3),
                  latest: {
                    ...metadata(3),
                    restoredFromRevision: revisionNumber(1),
                  },
                },
              }
            : detail,
        ),
        history: vi.fn(async () =>
          restored
            ? {
                ...history,
                items: [
                  { ...metadata(3), restoredFromRevision: revisionNumber(1) },
                  ...history.items,
                ],
                total: 3,
              }
            : history,
        ),
        readExact: vi.fn(async (_lineageId, selected: ArtifactRevisionNumber) =>
          revision(selected),
        ),
        compareText: vi.fn(async (_lineageId, from, to) => ({
          lineageId: id,
          fromRevision: from,
          toRevision: to,
          fromText: `revision ${from}`,
          toText: `revision ${to}`,
        })),
        restore: vi.fn(async () => {
          restored = true;
          return {
            ...revision(3),
            metadata: { ...metadata(3), restoredFromRevision: revisionNumber(1) },
          };
        }),
      },
    } as unknown as Client;
    const changed = vi.fn();
    const { root, subject } = mountWithClient(
      createStore(ArtifactLibraryStore, {
        model: ArtifactCatalog.create(),
        artifactsChanged: changed,
      }),
      client,
    );
    await flush();

    subject.setSearch("quarterly");
    await subject.load();
    expect(client.artifacts.catalog).toHaveBeenLastCalledWith(
      { search: "quarterly", offset: 0, limit: 50 },
      expect.anything(),
    );

    await subject.detailStore.select(id);
    expect(
      subject.detailStore.selectedLineage?.revisions.map((item) => item.revision).toSorted(),
    ).toEqual([1, 2]);
    expect(subject.detailStore.selectedLineage?.revision(2)?.snapshot?.payload).toEqual({
      markdown: "revision 2",
    });

    await subject.detailStore.selectRevision(id, revisionNumber(1));
    expect(subject.detailStore.selectedLineage?.revision(1)?.snapshot?.payload).toEqual({
      markdown: "revision 1",
    });
    await subject.detailStore.compare(id, revisionNumber(1), revisionNumber(2));
    expect(subject.detailStore.comparison?.fromText).toBe("revision 1");

    await subject.detailStore.restore("session-1", id, revisionNumber(1), 2);
    expect(client.artifacts.restore).toHaveBeenCalledWith(
      { sessionId: "session-1", lineageId: id, sourceRevision: 1, expectedLatestRevision: 2 },
      expect.anything(),
    );
    expect(changed).toHaveBeenCalledWith(id);
    expect(subject.detailStore.selectedLineage?.latestRevision).toBe(3);
    root[Symbol.dispose]();
  });

  it("rejects a stale catalog result", async () => {
    const pending: Array<(value: ArtifactLineagePage) => void> = [];
    const client = {
      artifacts: {
        catalog: vi.fn(() => new Promise<ArtifactLineagePage>((resolve) => pending.push(resolve))),
      },
    } as unknown as Client;
    const { root, subject } = mountWithClient(
      createStore(ArtifactLibraryStore, {
        model: ArtifactCatalog.create(),
        artifactsChanged: vi.fn(),
      }),
      client,
    );
    await flush();
    const current = subject.load();
    pending[1]!({ ...page, total: 2 });
    await current;
    pending[0]!({ ...page, total: 1 });
    await flush();

    expect(subject.total).toBe(2);
    root[Symbol.dispose]();
  });

  it("loads more than 50 newest-first revisions with dedupe and retry", async () => {
    const latest = revisionNumber(52);
    const pagedDetail: ArtifactLineageDetail = {
      ...detail,
      lineage: {
        ...detail.lineage,
        latestRevision: latest,
        latest: metadata(52),
      },
    };
    let olderAttempts = 0;
    let restored = false;
    const client = {
      artifacts: {
        catalog: vi.fn(async () => ({ ...page, items: [pagedDetail.lineage] })),
        detail: vi.fn(async () =>
          restored
            ? {
                ...pagedDetail,
                lineage: {
                  ...pagedDetail.lineage,
                  latestRevision: revisionNumber(53),
                  latest: { ...metadata(53), restoredFromRevision: revisionNumber(1) },
                },
              }
            : pagedDetail,
        ),
        history: vi.fn(async ({ offset }: { offset: number }) => {
          if (offset === 0)
            return {
              items: Array.from({ length: 50 }, (_, index) =>
                metadata((restored ? 53 : 52) - index),
              ),
              offset: 0,
              limit: 50,
              total: restored ? 53 : 52,
              hasMore: true,
            };
          olderAttempts += 1;
          if (olderAttempts === 1) throw new Error("history unavailable");
          return {
            items: [metadata(3), metadata(2), metadata(1)],
            offset: 50,
            limit: 50,
            total: 52,
            hasMore: false,
          };
        }),
        readExact: vi.fn(async (_lineageId, selected: ArtifactRevisionNumber) =>
          revision(selected),
        ),
        compareText: vi.fn(async (_lineageId, from, to) => ({
          lineageId: id,
          fromRevision: from,
          toRevision: to,
          fromText: `revision ${from}`,
          toText: `revision ${to}`,
        })),
        restore: vi.fn(async () => {
          restored = true;
          return {
            ...revision(53),
            metadata: { ...metadata(53), restoredFromRevision: revisionNumber(1) },
          };
        }),
      },
    } as unknown as Client;
    const { root, subject } = mountWithClient(
      createStore(ArtifactLibraryStore, {
        model: ArtifactCatalog.create(),
        artifactsChanged: vi.fn(),
      }),
      client,
    );
    await flush();
    await subject.detailStore.select(id);

    expect(subject.detailStore.selectedLineage?.revisions).toHaveLength(50);
    expect(
      subject.detailStore.selectedLineage?.revisions
        .map((item) => item.revision)
        .toSorted((a, b) => b - a),
    ).toEqual(Array.from({ length: 50 }, (_, index) => 52 - index));
    expect(subject.detailStore.historyHasMore).toBe(true);

    await subject.detailStore.loadOlderHistory();
    expect(subject.detailStore.historyError).toBe("history unavailable");
    expect(subject.detailStore.historyOffset).toBe(50);
    expect(subject.detailStore.selectedLineage?.revisions).toHaveLength(50);

    await subject.detailStore.loadOlderHistory();
    expect(subject.detailStore.historyError).toBeUndefined();
    expect(subject.detailStore.historyHasMore).toBe(false);
    expect(subject.detailStore.selectedLineage?.revisions).toHaveLength(52);
    await subject.detailStore.selectRevision(id, revisionNumber(1));
    expect(subject.detailStore.selectedLineage?.revision(1)?.snapshot?.payload).toEqual({
      markdown: "revision 1",
    });
    await subject.detailStore.compare(id, revisionNumber(1), revisionNumber(52));
    expect(subject.detailStore.comparison?.fromText).toBe("revision 1");
    await subject.detailStore.restore("session-1", id, revisionNumber(1), 52);
    expect(subject.detailStore.selectedLineage?.latestRevision).toBe(53);
    expect(client.artifacts.restore).toHaveBeenCalledWith(
      { sessionId: "session-1", lineageId: id, sourceRevision: 1, expectedLatestRevision: 52 },
      expect.anything(),
    );
    root[Symbol.dispose]();
  });

  it("ignores comparisons from an old selection and older repeated requests", async () => {
    const secondId = "appendix" as ArtifactLineageId;
    const summary = (lineageId: ArtifactLineageId) => ({
      ...page.items[0]!,
      id: lineageId,
      stableRef: `cake://artifact/${lineageId}` as never,
    });
    const comparisonResolvers: Array<(value: ArtifactTextComparison) => void> = [];
    const client = {
      artifacts: {
        catalog: vi.fn(async () => ({
          ...page,
          items: [summary(id), summary(secondId)],
          total: 2,
        })),
        detail: vi.fn(async (lineageId: ArtifactLineageId) => ({
          ...detail,
          lineage: summary(lineageId),
          stableRef: `cake://artifact/${lineageId}`,
        })),
        history: vi.fn(async () => history),
        readExact: vi.fn(
          async (lineageId: ArtifactLineageId, selected: ArtifactRevisionNumber) => ({
            ...revision(selected),
            lineageId,
            snapshot: { ...revision(selected).snapshot, id: lineageId },
          }),
        ),
        compareText: vi.fn(
          (...args: [ArtifactLineageId, ArtifactRevisionNumber, ArtifactRevisionNumber]) => {
            void args;
            return new Promise<ArtifactTextComparison>((resolve) =>
              comparisonResolvers.push(resolve),
            );
          },
        ),
      },
    } as unknown as Client;
    const { root, subject } = mountWithClient(
      createStore(ArtifactLibraryStore, {
        model: ArtifactCatalog.create(),
        artifactsChanged: vi.fn(),
      }),
      client,
    );
    await flush();
    await subject.detailStore.select(id);
    await subject.detailStore.selectRevision(id, revisionNumber(1));
    const staleSelection = subject.detailStore.compare(id, revisionNumber(1), revisionNumber(2));
    await subject.detailStore.select(secondId);
    comparisonResolvers[0]!({
      lineageId: id,
      fromRevision: revisionNumber(1),
      toRevision: revisionNumber(2),
      fromText: "stale A",
      toText: "stale A latest",
    });
    await staleSelection;
    expect(subject.detailStore.comparison).toBeUndefined();

    await subject.detailStore.selectRevision(secondId, revisionNumber(1));
    const older = subject.detailStore.compare(secondId, revisionNumber(1), revisionNumber(2));
    const newer = subject.detailStore.compare(secondId, revisionNumber(1), revisionNumber(2));
    comparisonResolvers[2]!({
      lineageId: secondId,
      fromRevision: revisionNumber(1),
      toRevision: revisionNumber(2),
      fromText: "newer",
      toText: "newer latest",
    });
    await newer;
    comparisonResolvers[1]!({
      lineageId: secondId,
      fromRevision: revisionNumber(1),
      toRevision: revisionNumber(2),
      fromText: "older",
      toText: "older latest",
    });
    await older;
    expect(subject.detailStore.comparison?.fromText).toBe("newer");
    root[Symbol.dispose]();
  });

  it("does not replace a latest title when reading a historical revision", async () => {
    const model = ArtifactCatalog.create();
    model.upsertSummary({ ...page.items[0]!, title: "Latest r2 title" });
    model.upsertRevision({
      ...revision(1),
      snapshot: { ...revision(1).snapshot, title: "Historical r1 title" },
    });

    expect(model.find(id)?.title).toBe("Latest r2 title");
  });

  it("keeps current detail visible and surfaces a restore conflict", async () => {
    const client = {
      artifacts: {
        catalog: vi.fn(async () => page),
        detail: vi.fn(async () => detail),
        history: vi.fn(async () => history),
        readExact: vi.fn(async () => revision(2)),
        restore: vi.fn(async () => Promise.reject(new Error("latest revision changed"))),
      },
    } as unknown as Client;
    const { root, subject } = mountWithClient(
      createStore(ArtifactLibraryStore, {
        model: ArtifactCatalog.create(),
        artifactsChanged: vi.fn(),
      }),
      client,
    );
    await flush();
    await subject.detailStore.select(id);
    await subject.detailStore.restore("session-1", id, revisionNumber(1), 2);

    expect(subject.detailStore.operationError).toBe("latest revision changed");
    expect(subject.detailStore.selectedLineage?.latestRevision).toBe(2);
    root[Symbol.dispose]();
  });
});
