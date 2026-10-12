/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArtifactDigest,
  decodeArtifactLineageId,
  decodeArtifactRevisionNumber,
  formatArtifactRef,
  type ArtifactLineageDetail,
  type ArtifactLineageId,
  type ArtifactLineagePage,
  type ArtifactLineageSummary,
  type ArtifactRevision,
  type ArtifactRevisionMetadata,
  type ArtifactTextComparison,
} from "../../../src/contracts/artifacts/artifact-lineage";
import type { Client } from "../../../src/renderer/client/Client";
import { ArtifactLibrary } from "../../../src/renderer/components/artifact-library";
import { sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const reportId = decodeArtifactLineageId("report");
const appendixId = decodeArtifactLineageId("appendix");
const revisionNumber = decodeArtifactRevisionNumber;
const metadata = (value: number): ArtifactRevisionMetadata => ({
  revision: revisionNumber(value),
  digest: Schema.decodeUnknownSync(ArtifactDigest)("a".repeat(64)),
  kind: "markdown",
  publishedAt: new Date(Date.UTC(2025, 0, value)).toISOString(),
  publishedBySessionId: "session-1",
  workingDirectory: "/project",
});
const summary = (lineageId = reportId, latest = 2): ArtifactLineageSummary => ({
  id: lineageId,
  title: lineageId === reportId ? "Quarterly report" : "Appendix",
  createdAt: metadata(1).publishedAt,
  latestRevision: revisionNumber(latest),
  latest: metadata(latest),
  stableRef: formatArtifactRef({ lineageId }),
});
const page = (items = [summary()]): ArtifactLineagePage => ({
  items,
  offset: 0,
  limit: 50,
  total: items.length,
  hasMore: false,
});
const detail = (lineageId = reportId, latest = 2): ArtifactLineageDetail => ({
  lineage: summary(lineageId, latest),
  links: [
    {
      lineageId,
      target: { type: "family", familyId: "family-1" },
      selection: { mode: "follow-latest" },
      createdAt: metadata(1).publishedAt,
    },
  ],
  stableRef: formatArtifactRef({ lineageId }),
});
const revision = (lineageId: ArtifactLineageId, value: number): ArtifactRevision => ({
  lineageId,
  metadata: metadata(value),
  snapshot: {
    protocol: "cake.artifact/v1",
    id: lineageId,
    sessionId: "session-1",
    revision: value,
    title: value === 1 ? "Original draft title" : summary(lineageId).title,
    kind: "markdown",
    payload: { markdown: `${lineageId} content r${value}` },
    fallback: { markdown: `${lineageId} content r${value}` },
  },
});

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function renderLibrary(artifacts: Partial<Client["artifacts"]> = {}) {
  const fixture = createRendererStoreFixture({
    sessions: [
      sessionSummary({ sessionId: "session-1", projectPath: "/project", familyId: "family-1" }),
    ],
    client: {
      artifacts: {
        catalog: async () => page(),
        detail: async (id) => detail(id),
        history: async () => ({
          items: [metadata(2), metadata(1)],
          offset: 0,
          limit: 50,
          total: 2,
          hasMore: false,
        }),
        readExact: async (id, selected) => revision(id, selected),
        compareText: async (id, from, to) => ({
          lineageId: id,
          fromRevision: from,
          toRevision: to,
          fromText: `${id} content r${from}`,
          toText: `${id} content r${to}`,
        }),
        ...artifacts,
      },
    },
  });
  fixture.root.artifactLibraryStore.open("session-1");
  const view = render(
    <ArtifactLibrary
      store={fixture.root.artifactLibraryStore}
      referencePreviews={fixture.root.artifactReferencePreviewStore}
      sessions={fixture.root.sessionCatalogStore}
      inlineWidgets={fixture.root.inlineWidgetStore}
    />,
  );
  return {
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

async function openReport(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /Quarterly report/ }));
  await screen.findByRole("combobox", { name: "Selected artifact revision" });
}

async function confirmRestore(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Restore as new latest" }));
  const dialog = screen.getByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Restore as new latest" }));
}

afterEach(cleanup);

describe("Artifact library workflow", () => {
  it("searches and filters the library, surfaces catalog failure, and retries from the search field", async () => {
    const table = { ...summary(appendixId), latest: { ...metadata(2), kind: "table" as const } };
    const catalog = vi
      .fn<Client["artifacts"]["catalog"]>()
      .mockResolvedValueOnce(page([summary(), table]))
      .mockRejectedValueOnce(new Error("Catalog temporarily unavailable"))
      .mockResolvedValueOnce(page());
    using fixture = renderLibrary({ catalog });
    await screen.findByRole("button", { name: /Quarterly report/ });
    expect(screen.getByRole("button", { name: /Appendix/ })).toBeDefined();
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Filter artifacts by kind" }),
      "markdown",
    );
    expect(screen.queryByRole("button", { name: /Appendix/ })).toBeNull();
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Filter artifacts by kind" }),
      "all",
    );
    expect(screen.getByRole("button", { name: /Appendix/ })).toBeDefined();

    const search = screen.getByRole("textbox", { name: "Search artifact library" });
    await fixture.user.type(search, "quarterly{Enter}");
    expect(await screen.findByText("Catalog temporarily unavailable")).toBeDefined();
    await fixture.user.type(search, "{Enter}");
    expect(await screen.findByRole("button", { name: /Quarterly report/ })).toBeDefined();
    expect(screen.queryByText("Catalog temporarily unavailable")).toBeNull();
    expect(screen.queryByRole("button", { name: /Appendix/ })).toBeNull();
    expect(catalog).toHaveBeenLastCalledWith(
      { search: "quarterly", offset: 0, limit: 50 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("keeps the latest search results when an earlier catalog response arrives late", async () => {
    const older = gate<ArtifactLineagePage>();
    const newer = gate<ArtifactLineagePage>();
    const catalog = vi
      .fn<Client["artifacts"]["catalog"]>()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    using fixture = renderLibrary({ catalog });
    await fixture.user.type(
      screen.getByRole("textbox", { name: "Search artifact library" }),
      "appendix{Enter}",
    );
    await act(async () => newer.resolve(page([summary(appendixId)])));
    expect(screen.getByRole("button", { name: /Appendix/ })).toBeDefined();
    await act(async () => older.resolve(page()));
    expect(screen.getByRole("button", { name: /Appendix/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: /Quarterly report/ })).toBeNull();
  });

  it("pages and retries revision history, compares historical content, then restores it as a new latest", async () => {
    let restored = false;
    let olderAttempts = 0;
    const history = vi.fn<Client["artifacts"]["history"]>(async ({ offset }) => {
      if (offset === 0)
        return {
          items: Array.from({ length: 50 }, (_, index) => metadata((restored ? 53 : 52) - index)),
          offset: 0,
          limit: 50,
          total: restored ? 53 : 52,
          hasMore: true,
        };
      if (++olderAttempts === 1) throw new Error("History temporarily unavailable");
      return {
        items: [metadata(3), metadata(2), metadata(1)],
        offset: 50,
        limit: 50,
        total: 52,
        hasMore: false,
      };
    });
    const restoredArtifact: ArtifactRevision = {
      lineageId: reportId,
      metadata: { ...metadata(53), restoredFromRevision: revisionNumber(1) },
      snapshot: { ...revision(reportId, 1).snapshot, revision: 53 },
    };
    const restore = vi.fn<Client["artifacts"]["restore"]>(async () => {
      restored = true;
      return restoredArtifact;
    });
    using fixture = renderLibrary({
      catalog: async () => page([summary(reportId, 52)]),
      detail: async () =>
        restored
          ? {
              ...detail(reportId, 53),
              lineage: {
                ...summary(reportId, 53),
                title: "Original draft title",
                latest: restoredArtifact.metadata,
              },
            }
          : detail(reportId, 52),
      readExact: async (id, selected) =>
        selected === 53 ? restoredArtifact : revision(id, selected),
      history,
      restore,
    });
    await openReport(fixture.user);
    expect(await screen.findByText("report content r52")).toBeDefined();
    expect(screen.getByText("Shared with workgroup")).toBeDefined();
    expect(screen.getByText("Revision 52 of 52 · Latest")).toBeDefined();
    expect(screen.getByText("Following latest")).toBeDefined();
    expect(screen.getByRole("button", { name: "Copy exact revision reference" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Copy readable path" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Pin r52" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Unlink" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Linked sessions" })).toBeDefined();
    expect(
      within(screen.getByRole("main").parentElement!).getByRole("complementary"),
    ).toBeDefined();
    const revisions = screen.getByRole("combobox", { name: "Selected artifact revision" });
    expect(within(revisions).getAllByRole("option")).toHaveLength(50);
    await fixture.user.click(screen.getByRole("button", { name: "Load older revisions" }));
    expect(await screen.findByText("History temporarily unavailable")).toBeDefined();
    expect(screen.getByText("report content r52")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Retry revision history" }));
    await waitFor(() => expect(within(revisions).getAllByRole("option")).toHaveLength(52));
    expect(
      within(revisions)
        .getAllByRole("option")
        .map((option) => option.getAttribute("value")),
    ).toEqual(Array.from({ length: 52 }, (_, index) => String(52 - index)));
    expect(screen.queryByText("History temporarily unavailable")).toBeNull();
    expect(history).toHaveBeenLastCalledWith(
      { lineageId: reportId, offset: 50, limit: 50 },
      expect.anything(),
    );
    await fixture.user.selectOptions(revisions, "1");
    expect(await screen.findByText("report content r1")).toBeDefined();
    expect(screen.getByRole("heading", { level: 1, name: "Quarterly report" })).toBeDefined();
    expect(screen.getByText("Revision 1 of 52 · Historical revision")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Compare with latest" }));
    const comparison = await screen.findByRole("region", { name: "Revision comparison" });
    expect(within(comparison).getByText("report content r1")).toBeDefined();
    expect(within(comparison).getByText("report content r52")).toBeDefined();
    await confirmRestore(fixture.user);
    expect(await screen.findByText("Revision 53 of 53 · Latest")).toBeDefined();
    expect(await screen.findByText("report content r1")).toBeDefined();
    expect(screen.getByRole("heading", { level: 1, name: "Original draft title" })).toBeDefined();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(restore).toHaveBeenCalledWith(
      {
        sessionId: "session-1",
        lineageId: reportId,
        sourceRevision: 1,
        expectedLatestRevision: 52,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("ignores comparisons from another selection and earlier repeated comparison requests", async () => {
    const oldSelection = gate<ArtifactTextComparison>();
    const older = gate<ArtifactTextComparison>();
    const newer = gate<ArtifactTextComparison>();
    const compareText = vi
      .fn<Client["artifacts"]["compareText"]>()
      .mockReturnValueOnce(oldSelection.promise)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    using fixture = renderLibrary({
      catalog: async () => page([summary(), summary(appendixId)]),
      compareText,
    });
    await openReport(fixture.user);
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Selected artifact revision" }),
      "1",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Compare with latest" }));
    await fixture.user.click(screen.getByRole("button", { name: /Appendix/ }));
    await screen.findByText("appendix content r2");
    await act(async () =>
      oldSelection.resolve({
        lineageId: reportId,
        fromRevision: revisionNumber(1),
        toRevision: revisionNumber(2),
        fromText: "Old report",
        toText: "Old report latest",
      }),
    );
    expect(screen.queryByRole("region", { name: "Revision comparison" })).toBeNull();

    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Selected artifact revision" }),
      "1",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Compare with latest" }));
    await fixture.user.click(screen.getByRole("button", { name: "Compare with latest" }));
    const result = {
      lineageId: appendixId,
      fromRevision: revisionNumber(1),
      toRevision: revisionNumber(2),
      fromText: "Current comparison",
      toText: "Current latest",
    };
    await act(async () => newer.resolve(result));
    expect(screen.getByText("Current comparison")).toBeDefined();
    await act(async () => older.resolve({ ...result, fromText: "Outdated comparison" }));
    expect(screen.getByText("Current comparison")).toBeDefined();
    expect(screen.queryByText("Outdated comparison")).toBeNull();
  });

  it("keeps historical content and latest metadata visible when a restore conflicts", async () => {
    const restore = vi.fn<Client["artifacts"]["restore"]>(async () => {
      throw new Error("Latest revision changed");
    });
    using fixture = renderLibrary({ restore });
    await openReport(fixture.user);
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Selected artifact revision" }),
      "1",
    );
    await screen.findByText("report content r1");
    await confirmRestore(fixture.user);
    await screen.findByText("Latest revision changed");
    await fixture.user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }),
    );
    expect(screen.getByText("report content r1")).toBeDefined();
    expect(screen.getByText("Revision 1 of 2 · Historical revision")).toBeDefined();
    expect(screen.getByText("Latest revision changed")).toBeDefined();
  });
});
