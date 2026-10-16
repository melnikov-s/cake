// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StoreProvider } from "r-state-tree/react";
import { createStore } from "r-state-tree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactReferenceMetadata } from "../../../src/contracts/artifacts/artifact-lineage";
import { ArtifactReferencePreview } from "../../../src/renderer/components/artifact-reference-preview";
import type { Client } from "../../../src/renderer/client/Client";
import { ArtifactCatalog } from "../../../src/renderer/models/ArtifactCatalog";
import { ArtifactDetailStore } from "../../../src/renderer/stores/ArtifactDetailStore";
import { ArtifactReferencePreviewStore } from "../../../src/renderer/stores/ArtifactReferencePreviewStore";
import { mountWithClient } from "./mount-with-client";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const metadata: ArtifactReferenceMetadata = {
  lineage: {
    id: "report" as never,
    createdAt: "2025-01-01T00:00:00.000Z",
    latestRevision: 2 as never,
    latest: {
      revision: 2 as never,
      digest: "a".repeat(64) as never,
      kind: "markdown",
      publishedAt: "2025-01-02T00:00:00.000Z",
      publishedBySessionId: "session-1",
      workingDirectory: "/project",
    },
    title: "Report",
    stableRef: "cake://artifact/report" as never,
  },
  revision: {
    revision: 2 as never,
    digest: "a".repeat(64) as never,
    kind: "markdown",
    publishedAt: "2025-01-02T00:00:00.000Z",
    publishedBySessionId: "session-1",
    workingDirectory: "/project",
  },
  links: [],
  stableRef: "cake://artifact/report" as never,
  exactRef: "cake://artifact/report@r2" as never,
};

describe("ArtifactReferencePreview", () => {
  let container: HTMLDivElement;
  let reactRoot: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    reactRoot = createRoot(container);
  });

  afterEach(() => {
    act(() => reactRoot.unmount());
    container.remove();
  });

  it("loads metadata for a bare reference label and opens its destination", async () => {
    const changed = vi.fn();
    const client = {
      artifacts: {
        referenceMetadata: vi.fn(async () => metadata),
        readExact: vi.fn(),
      },
    } as unknown as Client;
    const mounted = mountWithClient(
      createStore(ArtifactReferencePreviewStore, {
        model: ArtifactCatalog.create(),
        artifactsChanged: changed,
      }),
      client,
    );
    const onOpen = vi.fn();

    await act(async () => {
      reactRoot.render(
        <StoreProvider store={mounted.root}>
          <ArtifactReferencePreview
            reference={"cake://artifact/report@r2" as never}
            store={mounted.subject}
            onOpen={onOpen}
          />
        </StoreProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(client.artifacts.referenceMetadata).toHaveBeenCalledOnce();
    expect(client.artifacts.readExact).not.toHaveBeenCalled();
    const link = container.querySelector("a")!;
    expect(link.textContent).toBe("Report");
    expect(link.getAttribute("href")).toBe(metadata.exactRef);
    expect(link.getAttribute("aria-description")).toBe(metadata.exactRef);
    expect(link.classList.contains("text-inherit")).toBe(true);
    expect(link.classList.contains("font-semibold")).toBe(true);
    act(() => link.click());
    expect(onOpen).toHaveBeenCalledWith("report", 2);

    await act(async () => {
      reactRoot.render(
        <StoreProvider store={mounted.root}>
          <ArtifactReferencePreview
            reference={metadata.exactRef}
            store={mounted.subject}
            onOpen={onOpen}
          >
            Custom report label
          </ArtifactReferencePreview>
        </StoreProvider>,
      );
    });
    expect(container.querySelector("a")?.textContent).toBe("Custom report label");
    expect(container.querySelector("a")?.getAttribute("aria-description")).toBe(metadata.exactRef);
    mounted.root[Symbol.dispose]();
  });

  it("refreshes external reference titles and links, keeps exact destinations pinned, and rejects superseded metadata", async () => {
    const pending: Array<{ reference: string; resolve(value: ArtifactReferenceMetadata): void }> =
      [];
    const referenceMetadata = vi.fn<Client["artifacts"]["referenceMetadata"]>(
      (reference) => new Promise((resolve) => pending.push({ reference, resolve })),
    );
    using fixture = createRendererStoreFixture({ client: { artifacts: { referenceMetadata } } });
    const store = fixture.root.artifactReferencePreviewStore;
    const onOpen = vi.fn();
    await act(async () => {
      reactRoot.render(
        <StoreProvider store={fixture.root}>
          <ArtifactReferencePreview reference={metadata.stableRef} store={store} onOpen={onOpen} />
          <ArtifactReferencePreview reference={metadata.exactRef} store={store} onOpen={onOpen} />
        </StoreProvider>,
      );
    });
    expect(pending).toHaveLength(2);
    await act(async () => {
      for (const request of pending.splice(0)) request.resolve(metadata);
    });
    expect([...container.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
      "Report",
      "Report",
    ]);

    await act(async () => fixture.models.artifacts.invalidate());
    const superseded = pending.splice(0);
    expect(superseded).toHaveLength(2);
    await act(async () => fixture.models.artifacts.invalidate());
    expect(pending).toHaveLength(2);
    const link: ArtifactReferenceMetadata["links"][number] = {
      lineageId: metadata.lineage.id,
      target: { type: "family", familyId: "new-family" },
      selection: { mode: "pinned", revision: metadata.revision.revision },
      createdAt: metadata.lineage.createdAt,
    };
    const latest = { ...metadata.revision, revision: 3 as never, digest: "b".repeat(64) as never };
    await act(async () => {
      for (const request of pending.splice(0))
        request.resolve({
          ...metadata,
          lineage: {
            ...metadata.lineage,
            title: "External title",
            latestRevision: latest.revision,
            latest,
          },
          revision: request.reference === metadata.stableRef ? latest : metadata.revision,
          links: [link],
          exactRef:
            request.reference === metadata.stableRef
              ? "cake://artifact/report@r3"
              : metadata.exactRef,
        });
    });
    expect([...container.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
      "External title",
      "External title",
    ]);
    expect(store.previewStates[metadata.stableRef]?.metadata?.exactRef).toBe(
      "cake://artifact/report@r3",
    );
    expect(store.previewStates[metadata.exactRef]?.metadata?.exactRef).toBe(metadata.exactRef);
    expect(store.previewStates[metadata.exactRef]?.metadata?.links).toEqual([link]);

    await act(async () => {
      for (const request of superseded) request.resolve(metadata);
    });
    expect(container.querySelector("a")?.textContent).toBe("External title");
    act(() => container.querySelectorAll("a")[1]!.click());
    expect(onOpen).toHaveBeenCalledWith("report", 2);
    // Unlink and reconnect reconcile presentation even though the exact revision never changes.
    await act(async () => fixture.models.artifacts.invalidate());
    await act(async () => {
      for (const request of pending.splice(0))
        request.resolve({
          ...metadata,
          lineage: {
            ...metadata.lineage,
            title: "Reconnected title",
            latestRevision: latest.revision,
            latest,
          },
          revision: request.reference === metadata.stableRef ? latest : metadata.revision,
          exactRef:
            request.reference === metadata.stableRef
              ? "cake://artifact/report@r3"
              : metadata.exactRef,
        });
    });
    expect(store.previewStates[metadata.exactRef]?.metadata?.links).toEqual([]);
    expect(container.querySelector("a")?.textContent).toBe("Reconnected title");
    act(() => reactRoot.unmount());
    reactRoot = createRoot(container);
  });

  it("keeps unresolved references readable after metadata fails and retries on invalidation", async () => {
    let rejectMetadata: (error: Error) => void = () => undefined;
    const client = {
      artifacts: {
        referenceMetadata: vi.fn(
          () =>
            new Promise<ArtifactReferenceMetadata>((_resolve, reject) => {
              rejectMetadata = reject;
            }),
        ),
      },
    } as unknown as Client;
    const mounted = mountWithClient(
      createStore(ArtifactReferencePreviewStore, {
        model: ArtifactCatalog.create(),
        artifactsChanged: vi.fn(),
      }),
      client,
    );
    const onOpen = vi.fn();
    await act(async () => {
      reactRoot.render(
        <StoreProvider store={mounted.root}>
          <ArtifactReferencePreview
            reference={metadata.exactRef}
            store={mounted.subject}
            onOpen={onOpen}
          />
        </StoreProvider>,
      );
    });
    expect(container.querySelector("a")?.textContent).toBe("report");
    await act(async () => rejectMetadata(new Error("unavailable")));
    const link = container.querySelector("a")!;
    expect(link.textContent).toBe("report");
    expect(link.getAttribute("aria-description")).toBe(metadata.exactRef);
    act(() => link.click());
    expect(onOpen).toHaveBeenCalledWith("report", 2);
    vi.mocked(client.artifacts.referenceMetadata).mockResolvedValue(metadata);
    await act(async () => mounted.subject.props.model.invalidate());
    expect(link.textContent).toBe("Report");
    mounted.root[Symbol.dispose]();
  });

  it("scopes mutation failures and clears them through detail selection intents", async () => {
    const changed = vi.fn();
    const link = vi.fn(async () => Promise.reject(new Error("link unavailable")));
    const artifactRevision = (lineageId: string) => ({
      lineageId,
      metadata: metadata.revision,
      snapshot: {
        protocol: "cake.artifact/v1" as const,
        id: lineageId,
        sessionId: "session-1",
        revision: 2,
        title: "Report",
        kind: "markdown" as const,
        payload: { markdown: "report" },
        fallback: { markdown: "report" },
      },
    });
    const client = {
      artifacts: {
        link,
        detail: vi.fn(async (lineageId: string) => ({
          lineage: {
            ...metadata.lineage,
            id: lineageId,
            stableRef: `cake://artifact/${lineageId}`,
          },
          links: [],
          stableRef: `cake://artifact/${lineageId}`,
        })),
        history: vi.fn(async () => ({
          items: [metadata.revision],
          offset: 0,
          limit: 50,
          total: 1,
          hasMore: false,
        })),
        readExact: vi.fn(async (lineageId: string) => artifactRevision(lineageId)),
      },
    } as unknown as Client;
    const model = ArtifactCatalog.create();
    const previews = mountWithClient(
      createStore(ArtifactReferencePreviewStore, {
        model,
        artifactsChanged: changed,
      }),
      client,
    );
    const detail = mountWithClient(
      createStore(ArtifactDetailStore, {
        model,
        artifactsChanged: changed,
        clearReferenceOperationError: (lineageId) =>
          previews.subject.clearOperationError(lineageId),
      }),
      client,
    );
    const firstLineage = "report" as never;
    const secondLineage = "appendix" as never;

    await previews.subject.link("session-1", firstLineage, {
      type: "session",
      sessionId: "session-1",
    });
    expect(previews.subject.operationErrorFor(firstLineage)).toBe("link unavailable");
    expect(previews.subject.operationErrorFor(secondLineage)).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();

    await detail.subject.select(secondLineage);
    expect(previews.subject.operationErrorFor(firstLineage)).toBeUndefined();

    await previews.subject.link("session-1", secondLineage, {
      type: "session",
      sessionId: "session-1",
    });
    expect(previews.subject.operationErrorFor(secondLineage)).toBe("link unavailable");
    await detail.subject.selectRevision(secondLineage, 2 as never);
    expect(previews.subject.operationErrorFor(secondLineage)).toBeUndefined();

    let rejectLate: ((error: Error) => void) | undefined;
    link.mockImplementationOnce(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectLate = reject;
        }),
    );
    const pending = previews.subject.link("session-1", secondLineage, {
      type: "session",
      sessionId: "session-1",
    });
    await detail.subject.selectRevision(secondLineage, 2 as never);
    rejectLate!(new Error("late failure"));
    await pending;
    expect(previews.subject.operationErrorFor(secondLineage)).toBeUndefined();
    detail.root[Symbol.dispose]();
    previews.root[Symbol.dispose]();
  });

  it("bounds its window-wide metadata cache and ignores results after disposal", async () => {
    let resolveLast: ((value: ArtifactReferenceMetadata) => void) | undefined;
    const client = {
      artifacts: {
        referenceMetadata: vi.fn((reference: string) => {
          if (reference === "cake://artifact/disposed")
            return new Promise<ArtifactReferenceMetadata>((resolve) => {
              resolveLast = resolve;
            });
          return Promise.resolve({
            ...metadata,
            stableRef: reference,
            exactRef: reference,
          });
        }),
      },
    } as unknown as Client;
    const mounted = mountWithClient(
      createStore(ArtifactReferencePreviewStore, {
        model: ArtifactCatalog.create(),
        artifactsChanged: vi.fn(),
      }),
      client,
    );

    for (let index = 0; index < 101; index += 1)
      await mounted.subject.previewReference(`cake://artifact/report-${index}` as never);

    expect(Object.keys(mounted.subject.previewStates)).toHaveLength(100);
    expect(mounted.subject.previewStates["cake://artifact/report-0"]).toBeUndefined();

    const pending = mounted.subject.previewReference("cake://artifact/disposed" as never);
    mounted.root[Symbol.dispose]();
    resolveLast!(metadata);
    await pending;
    expect(mounted.subject.previewStates["cake://artifact/disposed"]?.metadata).toBeUndefined();
  });
});
