import { createStore } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type {
  ArtifactLineageDetail,
  ArtifactLineageId,
  ArtifactLineagePage,
  ArtifactRevision,
  ArtifactRevisionNumber,
  ArtifactRevisionPage,
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

describe("ArtifactLibraryStore", () => {
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

    await subject.select(id);
    expect(subject.selectedLineage?.revisions.map((item) => item.revision).toSorted()).toEqual([
      1, 2,
    ]);
    expect(subject.selectedLineage?.revision(2)?.snapshot?.payload).toEqual({
      markdown: "revision 2",
    });

    await subject.selectRevision(id, revisionNumber(1));
    expect(subject.selectedLineage?.revision(1)?.snapshot?.payload).toEqual({
      markdown: "revision 1",
    });

    await subject.restore("session-1", id, revisionNumber(1), 2);
    expect(client.artifacts.restore).toHaveBeenCalledWith(
      { sessionId: "session-1", lineageId: id, sourceRevision: 1, expectedLatestRevision: 2 },
      expect.anything(),
    );
    expect(changed).toHaveBeenCalledWith(id);
    expect(subject.selectedLineage?.latestRevision).toBe(3);
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
    await subject.select(id);
    await subject.restore("session-1", id, revisionNumber(1), 2);

    expect(subject.operationError).toBe("latest revision changed");
    expect(subject.selectedLineage?.latestRevision).toBe(2);
    root[Symbol.dispose]();
  });
});
