// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StoreProvider } from "r-state-tree/react";
import { createStore } from "r-state-tree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactReferenceMetadata } from "../../../src/domain/artifacts/artifact-lineage";
import { ArtifactReferencePreview } from "../../../src/renderer/components/artifact-reference-preview";
import type { Client } from "../../../src/renderer/client/Client";
import { ArtifactCatalog } from "../../../src/renderer/models/ArtifactCatalog";
import { ArtifactReferencePreviewStore } from "../../../src/renderer/stores/ArtifactReferencePreviewStore";
import type { SessionCatalogStore } from "../../../src/renderer/stores/SessionCatalogStore";
import { mountWithClient } from "./mount-with-client";

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

  it("loads metadata only, then links and materializes the referenced revision", async () => {
    const changed = vi.fn();
    const linkedArtifact = {
      lineageId: metadata.lineage.id,
      target: { type: "family" as const, familyId: "family-1" },
      selection: { mode: "pinned" as const, revision: metadata.revision.revision },
      createdAt: "2025-01-01T00:00:00.000Z",
    };
    const client = {
      artifacts: {
        catalog: vi.fn(async () => ({ items: [], offset: 0, limit: 50, total: 0, hasMore: false })),
        referenceMetadata: vi.fn(async () => metadata),
        readExact: vi.fn(),
        link: vi.fn(async () => linkedArtifact),
        detail: vi.fn(async () => ({
          lineage: metadata.lineage,
          links: [linkedArtifact],
          stableRef: metadata.stableRef,
        })),
        materialize: vi.fn(async () => ({ exactPath: "/cache/report/revision-2.md" })),
      },
    } as unknown as Client;
    const mounted = mountWithClient(
      createStore(ArtifactReferencePreviewStore, {
        model: ArtifactCatalog.create(),
        artifactsChanged: changed,
      }),
      client,
    );
    const sessions = {
      find: () => ({ sessionId: "session-1", familyId: "family-1" }),
    } as unknown as SessionCatalogStore;

    await act(async () => {
      reactRoot.render(
        <StoreProvider store={mounted.root}>
          <ArtifactReferencePreview
            reference={"cake://artifact/report@r2" as never}
            store={mounted.subject}
            sessions={sessions}
            activeSessionId="session-1"
            onOpen={vi.fn()}
          />
        </StoreProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(client.artifacts.referenceMetadata).toHaveBeenCalledOnce();
    expect(client.artifacts.readExact).not.toHaveBeenCalled();
    const link = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Link to this family"),
    );
    expect(link).toBeDefined();
    await act(async () => {
      link!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(client.artifacts.link).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        target: { type: "family", familyId: "family-1" },
        selection: { mode: "pinned", revision: 2 },
      }),
      expect.anything(),
    );
    expect(client.artifacts.materialize).toHaveBeenCalledWith(
      "session-1",
      "report",
      2,
      expect.anything(),
    );
    expect(changed).toHaveBeenCalledWith("report");
    expect(mounted.subject.previewStates[metadata.exactRef]?.metadata?.links).toEqual([
      linkedArtifact,
    ]);
    mounted.root[Symbol.dispose]();
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
