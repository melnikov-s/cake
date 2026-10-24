/** @vitest-environment jsdom */
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  parseArtifactRef,
  decodeArtifactRevisionNumber,
  type ArtifactStableRef,
} from "../../../src/contracts/artifacts/artifact-lineage";
import { InlineArtifactPreview } from "../../../src/renderer/components/inline-artifact-preview";
import { artifactRevision, referenceMetadata } from "./artifact-reference-workflow-fixture";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);

it("identifies old widget revisions in collapsed and reopened headers and follows revision advances", async () => {
  let latest = 2;
  const metadata = (reference: string) => {
    const parsed = parseArtifactRef(reference);
    const current = decodeArtifactRevisionNumber(parsed.lineageId === "report" ? latest : 1);
    const value = referenceMetadata(reference);
    return {
      ...value,
      lineage: {
        ...value.lineage,
        latestRevision: current,
        latest: { ...value.lineage.latest, revision: current, kind: "widget" as const },
      },
      revision: {
        ...value.revision,
        revision: parsed.revision ?? current,
        kind: "widget" as const,
      },
      exactRef:
        `cake://artifact/${parsed.lineageId}@r${parsed.revision ?? current}` as ArtifactStableRef,
    };
  };
  const readExact = vi.fn(async (id, revision) => {
    const value = artifactRevision(id, revision);
    return {
      ...value,
      metadata: { ...value.metadata, kind: "widget" as const },
      snapshot: {
        ...value.snapshot,
        kind: "widget" as const,
        payload: {
          language: "html" as const,
          source: `<p>Widget r${revision}</p>`,
          brief: "Revision header fixture",
          generationSessionId: "private",
          browser: { digest: "b".repeat(64) },
        },
      },
    };
  });
  using fixture = createRendererStoreFixture({
    client: {
      artifacts: {
        referenceMetadata: async (reference) => metadata(reference),
        readExact,
        stateRead: async ({ lineageId }) => ({ lineageId, version: 0, value: null }),
      },
      inlineWidgets: {
        open: async () => ({
          token: "00000000-0000-4000-8000-000000000010",
          url: "cake-widget://document/00000000-0000-4000-8000-000000000010",
        }),
      },
    },
  });
  const references: ArtifactStableRef[] = [
    "cake://artifact/report@r1",
    "cake://artifact/report@r2",
    "cake://artifact/report",
    "cake://artifact/appendix@r1",
  ];
  for (const reference of references)
    fixture.models.artifacts.applyReferenceMetadata(metadata(reference));
  const view = render(
    <>
      {references.map((reference) => (
        <InlineArtifactPreview
          key={reference}
          reference={reference}
          store={fixture.root.inlineArtifactPreviewStore}
          inlineWidgets={fixture.root.inlineWidgetStore}
          stateSessionId="viewer"
        />
      ))}
    </>,
  );
  const headers = () =>
    Array.from(view.container.querySelectorAll<HTMLElement>('[data-slot="artifact-disclosure"]'));
  const header = (index: number) => within(headers()[index]!);
  const toggle = (index: number) => header(index).getByRole("button", { name: /Collapse|Expand/ });
  const user = userEvent.setup();
  await waitFor(() => expect(toggle(0).getAttribute("aria-expanded")).toBe("false"));
  expect(header(0).getByText("Old version")).toBeDefined();
  expect(header(1).queryByText("Old version")).toBeNull();
  expect(header(2).queryByText("Old version")).toBeNull();
  expect(header(3).queryByText("Old version")).toBeNull();
  // Collapse current and unrelated revisions too: expansion must not decide the label.
  await user.click(toggle(1));
  await user.click(toggle(3));
  expect(header(1).queryByText("Old version")).toBeNull();
  expect(header(3).queryByText("Old version")).toBeNull();
  await user.click(toggle(0));
  await waitFor(() => expect(headers()[0]!.querySelector("iframe")).not.toBeNull());
  expect(header(0).getByText("Old version")).toBeDefined();
  expect(readExact).toHaveBeenCalledWith("report", 1, expect.anything());
  // Authority advances while r2 is collapsed. The exact ref becomes old; the stable ref follows r3.
  await act(async () => {
    latest = 3;
    fixture.models.artifacts.applyReferenceMetadata(metadata("cake://artifact/report@r3"));
  });
  await waitFor(() => expect(header(1).getByText("Old version")).toBeDefined());
  expect(toggle(1).getAttribute("aria-expanded")).toBe("false");
  await waitFor(() =>
    expect(headers()[2]!.getAttribute("data-artifact-reference")).toBe("cake://artifact/report@r3"),
  );
  expect(header(2).queryByText("Old version")).toBeNull();
  expect(header(3).queryByText("Old version")).toBeNull();
  await user.click(toggle(1));
  await waitFor(() => expect(headers()[1]!.querySelector("iframe")).not.toBeNull());
  expect(header(1).getByText("Old version")).toBeDefined();
  view.unmount();
});
