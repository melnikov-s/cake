/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactReferenceMetadata } from "../../../src/contracts/artifacts/artifact-lineage";
import type { Client } from "../../../src/renderer/client/Client";
import {
  artifactRevision,
  referenceMetadata,
  renderArtifactReferences,
  reportRef,
} from "./artifact-reference-workflow-fixture";

function gate<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
    media: query,
    matches: query === "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }));
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.unstubAllGlobals();
});

// Supersedes artifact-reference-preview.test.tsx's isolated Store/client casts. These journeys
// run Markdown -> reference preview -> real navigation/library/detail Models and Stores. Restore
// conflicts are already covered by artifact-library-workflow.test.tsx and are not duplicated here.
// jsdom proves service payloads/rendered results, not native links, focus or portal behavior.
describe("Artifact reference workflow", () => {
  it("shares metadata for bare/custom labels and opens the exact historical revision through real navigation", async () => {
    const pending = gate<ArtifactReferenceMetadata>();
    const metadata = vi.fn<Client["artifacts"]["referenceMetadata"]>(() => pending.promise);
    const readExact = vi.fn<Client["artifacts"]["readExact"]>(async (id, revision) =>
      artifactRevision(id, revision),
    );
    using fixture = renderArtifactReferences(
      `${reportRef}\n\n[Custom report label](${reportRef})`,
      {
        referenceMetadata: metadata,
        readExact,
      },
    );
    await screen.findByRole("link", { name: "report" });
    expect(screen.getByRole("link", { name: "Custom report label" })).toBeDefined();
    expect(metadata).toHaveBeenCalledOnce();
    expect(readExact).not.toHaveBeenCalled();
    await act(async () => pending.resolve(referenceMetadata(reportRef)));
    const bare = await screen.findByRole("link", { name: "Quarterly report" });
    expect(bare.getAttribute("href")).toBe(reportRef);
    expect(bare.getAttribute("aria-description")).toBe(reportRef);
    expect(screen.getByRole("link", { name: "Custom report label" }).getAttribute("href")).toBe(
      reportRef,
    );
    await fixture.user.click(screen.getByRole("link", { name: "Custom report label" }));
    expect(await screen.findByText("report content r1")).toBeDefined();
    expect(screen.getByText("Revision 1 of 2 · Historical revision")).toBeDefined();
    expect(readExact).toHaveBeenLastCalledWith(
      "report",
      1,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Selected artifact revision" }),
      "2",
    );
    expect(await screen.findByText("report content r2")).toBeDefined();
    expect(screen.getByText("Revision 2 of 2 · Latest")).toBeDefined();
  });

  it("keeps a reference readable and able to open its exact destination after metadata fails", async () => {
    const pending = gate<ArtifactReferenceMetadata>();
    const metadata = vi.fn<Client["artifacts"]["referenceMetadata"]>(() => pending.promise);
    using fixture = renderArtifactReferences(reportRef, { referenceMetadata: metadata });
    const link = await screen.findByRole("link", { name: "report" });
    expect(link.getAttribute("aria-description")).toBe(reportRef);
    await act(async () => pending.reject(new Error("Metadata unavailable")));
    expect(screen.getByRole("link", { name: "report" }).getAttribute("href")).toBe(reportRef);
    metadata.mockResolvedValue(referenceMetadata(reportRef));
    await fixture.publishArtifactsChanged();
    await fixture.user.click(await screen.findByRole("link", { name: "Quarterly report" }));
    expect(await screen.findByText("report content r1")).toBeDefined();
    expect(screen.getByText("Revision 1 of 2 · Historical revision")).toBeDefined();
  });

  it("refreshes external titles, keeps exact destinations pinned and rejects superseded metadata", async () => {
    const pending: Array<{ reference: string; resolve(value: ArtifactReferenceMetadata): void }> =
      [];
    const metadata = vi.fn<Client["artifacts"]["referenceMetadata"]>(
      (reference) => new Promise((resolve) => pending.push({ reference, resolve })),
    );
    const stable = "cake://artifact/report";
    const readExact = vi.fn<Client["artifacts"]["readExact"]>(async (id, revision) =>
      artifactRevision(id, revision),
    );
    using fixture = renderArtifactReferences(`${stable}\n\n${reportRef}`, {
      referenceMetadata: metadata,
      readExact,
    });
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => {
      for (const request of pending.splice(0))
        request.resolve(referenceMetadata(request.reference));
    });
    expect(screen.getAllByRole("link", { name: "Quarterly report" })).toHaveLength(2);
    await fixture.publishArtifactsChanged();
    const superseded = pending.splice(0);
    expect(superseded).toHaveLength(2);
    await fixture.publishArtifactsChanged();
    expect(pending).toHaveLength(2);
    const latest = referenceMetadata("cake://artifact/report@r3").revision;
    const respond = (title: string, linked: boolean) => {
      for (const request of pending.splice(0)) {
        const original = referenceMetadata(request.reference);
        request.resolve({
          ...original,
          lineage: { ...original.lineage, title, latestRevision: latest.revision, latest },
          revision: request.reference === stable ? latest : original.revision,
          exactRef: request.reference === stable ? "cake://artifact/report@r3" : original.exactRef,
          links: linked
            ? [
                {
                  lineageId: original.lineage.id,
                  target: { type: "family", familyId: "new-family" },
                  selection: { mode: "pinned", revision: original.revision.revision },
                  createdAt: original.lineage.createdAt,
                },
              ]
            : [],
        });
      }
    };
    await act(async () => respond("External title", true));
    expect(screen.getAllByRole("link", { name: "External title" })).toHaveLength(2);
    await act(async () => {
      for (const request of superseded) request.resolve(referenceMetadata(request.reference));
    });
    expect(screen.getAllByRole("link", { name: "External title" })).toHaveLength(2);
    await fixture.publishArtifactsChanged();
    await act(async () => respond("Reconnected title", false));
    const links = screen.getAllByRole("link", { name: "Reconnected title" });
    expect(links.map((link) => link.getAttribute("href"))).toEqual([stable, reportRef]);
    await fixture.user.click(links[1]!);
    expect(await screen.findByText("report content r1")).toBeDefined();
    expect(readExact).toHaveBeenLastCalledWith("report", 1, expect.anything());
  });

  it("scopes link failures to their detail and clears them on selection/revision changes, including late failures", async () => {
    const late = gate<Awaited<ReturnType<Client["artifacts"]["link"]>>>();
    const link = vi
      .fn<Client["artifacts"]["link"]>()
      .mockRejectedValueOnce(new Error("Report link unavailable"))
      .mockRejectedValueOnce(new Error("Appendix link unavailable"))
      .mockReturnValueOnce(late.promise);
    using fixture = renderArtifactReferences(reportRef, { link });
    await fixture.user.click(await screen.findByRole("link", { name: "Quarterly report" }));
    await fixture.user.click(await screen.findByRole("button", { name: "Link to this session" }));
    expect(await screen.findByText("Report link unavailable")).toBeDefined();
    expect(link).toHaveBeenLastCalledWith(
      {
        sessionId: "session-1",
        lineageId: "report",
        target: { type: "session", sessionId: "session-1" },
        selection: { mode: "follow-latest" },
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await fixture.user.click(screen.getByRole("button", { name: /Appendix/ }));
    await screen.findByText("appendix content r2");
    expect(screen.queryByText("Report link unavailable")).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Link to this session" }));
    expect(await screen.findByText("Appendix link unavailable")).toBeDefined();
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Selected artifact revision" }),
      "1",
    );
    await screen.findByText("appendix content r1");
    expect(screen.queryByText("Appendix link unavailable")).toBeNull();

    await fixture.user.click(screen.getByRole("button", { name: "Link to this session" }));
    expect(link).toHaveBeenCalledTimes(3);
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "Selected artifact revision" }),
      "2",
    );
    await screen.findByText("appendix content r2");
    await act(async () => late.reject(new Error("Late link failure")));
    expect(screen.queryByText("Late link failure")).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: /Quarterly report/ }));
    await screen.findByText("report content r2");
    expect(screen.queryByText("Report link unavailable")).toBeNull();
  });

  it("reuses recent metadata and refetches an evicted reference after more than 100 distinct previews", async () => {
    const metadata = vi.fn<Client["artifacts"]["referenceMetadata"]>(async (reference) =>
      referenceMetadata(reference),
    );
    using fixture = renderArtifactReferences(
      Array.from({ length: 100 }, (_, index) => `cake://artifact/report-${index}`).join("\n\n"),
      { referenceMetadata: metadata },
    );
    await screen.findByRole("link", { name: "Artifact report-99" });
    expect(metadata).toHaveBeenCalledTimes(100);
    await fixture.receiveTranscript("cake://artifact/extra");
    await screen.findByRole("link", { name: "Artifact extra" });
    expect(metadata).toHaveBeenCalledTimes(101);
    await fixture.receiveTranscript("cake://artifact/report-99");
    await screen.findByRole("link", { name: "Artifact report-99" });
    expect(metadata).toHaveBeenCalledTimes(101);
    await fixture.receiveTranscript("cake://artifact/report-0");
    await screen.findByRole("link", { name: "Artifact report-0" });
    expect(metadata).toHaveBeenCalledTimes(102);
    expect(metadata).toHaveBeenLastCalledWith("cake://artifact/report-0", expect.anything());
  });

  it("aborts pending metadata on window disposal and keeps the next window independent of late results", async () => {
    const pending = gate<ArtifactReferenceMetadata>();
    const metadata = vi.fn<Client["artifacts"]["referenceMetadata"]>(() => pending.promise);
    using closed = renderArtifactReferences(reportRef, { referenceMetadata: metadata });
    await screen.findByRole("link", { name: "report" });
    const signal = metadata.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    closed[Symbol.dispose]();
    expect(signal?.aborted).toBe(true);

    using reopened = renderArtifactReferences(reportRef);
    await screen.findByRole("link", { name: "Quarterly report" });
    await act(async () =>
      pending.resolve({
        ...referenceMetadata(reportRef),
        lineage: { ...referenceMetadata(reportRef).lineage, title: "Stale closed-window title" },
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Quarterly report" })).toBeDefined(),
    );
    expect(screen.queryByRole("link", { name: "Stale closed-window title" })).toBeNull();
    await reopened.user.click(screen.getByRole("link", { name: "Quarterly report" }));
    expect(await screen.findByText("report content r1")).toBeDefined();
  });
});
