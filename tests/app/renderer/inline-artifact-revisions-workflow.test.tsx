/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import { renderArtifactReferences } from "./artifact-reference-workflow-fixture";

function presentation(id: string, revision: number, lineage = "report"): UiPart {
  return {
    id,
    kind: "tool",
    name: "cake",
    command: "artifacts.present",
    input: "",
    state: "success",
    artifactId: lineage,
    artifactReference: `cake://artifact/${lineage}@r${revision}`,
  };
}
function surface(id: string) {
  const element = document.querySelector(
    `[data-part-id="${id}"] [data-slot="artifact-disclosure"]`,
  );
  if (!(element instanceof HTMLElement)) throw new Error(`Missing surface ${id}`);
  return within(element).getByRole("button", { name: /(?:Collapse|Expand)$/ });
}
async function expectOpen(id: string, open: boolean) {
  await waitFor(() => expect(surface(id).getAttribute("aria-expanded")).toBe(String(open)));
}

beforeEach(() => {
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
});

describe("inline artifact revision disclosures", () => {
  it("collapses every older revision of the canonical lineage, not unrelated artifacts or equal revisions", async () => {
    const parts = [
      presentation("one", 1),
      presentation("two", 2),
      presentation("other", 1, "appendix"),
    ];
    using fixture = renderArtifactReferences("Conversation prose", {}, parts);
    await expectOpen("one", false);
    await expectOpen("two", true);
    await expectOpen("other", true);
    // Reopened old surfaces are only collapsed again by an actual revision advance.
    await fixture.user.click(surface("one"));
    const newer = [...parts, presentation("three", 3), presentation("three-copy", 3)];
    await fixture.receiveTranscript("Updated prose", newer);
    await expectOpen("one", false);
    await expectOpen("two", false);
    await expectOpen("three", true);
    await expectOpen("three-copy", true);
    await expectOpen("other", true);
    await fixture.user.click(surface("one"));
    await fixture.receiveTranscript("Rerender", [
      ...newer,
      presentation("duplicate", 3),
      presentation("late-old", 2),
    ]);
    await expectOpen("one", true);
    await expectOpen("late-old", false);
    await expectOpen("three", true);
    await expectOpen("duplicate", true);
    expect(screen.getByText("report content r1")).toBeDefined();
  });

  it("reconciles restored history independent of order and preserves reopened choices across row unmounts", async () => {
    // Newest first deliberately: last presentation is not latest revision.
    const restored = [
      presentation("latest", 10),
      presentation("old", 2),
      presentation("oldest", 1),
    ];
    using fixture = renderArtifactReferences("Restored history", {}, restored);
    await expectOpen("latest", true);
    await expectOpen("old", false);
    await expectOpen("oldest", false);
    await fixture.user.click(surface("old"));
    await fixture.receiveTranscript("Offscreen rows", [restored[0]!]);
    expect(document.querySelector('[data-part-id="old"]')).toBeNull();
    await fixture.receiveTranscript("Rows remounted", restored);
    await expectOpen("old", true);
    await expectOpen("oldest", false);
    await expectOpen("latest", true);
    await fixture.receiveTranscript("New revision while old row unmounted", [
      presentation("next", 11),
    ]);
    await fixture.receiveTranscript("Old row returns", [...restored, presentation("next", 11)]);
    await expectOpen("old", false);
    await expectOpen("latest", false);
    await expectOpen("next", true);
  });

  it("uses newer presentations outside the restored virtualized viewport without treating suppressed embeds as events", async () => {
    const oldest = presentation("old", 1);
    const filler: UiPart[] = Array.from({ length: 35 }, (_, index) => ({
      id: `message-${index}`,
      kind: "text",
      role: "assistant",
      status: "complete",
      text: `Message ${index}`,
    }));
    using fixture = renderArtifactReferences("![Suppressed](cake://artifact/report)", {}, [oldest]);
    // The catalog knows r2, but the stable Markdown duplicate is suppressed by the publication.
    await expectOpen("old", true);
    await fixture.receiveTranscript("Restored history", [
      oldest,
      ...filler,
      presentation("newest", 10),
    ]);
    await expectOpen("old", false);
  });

  it("uses the shared behavior in permanent Project Chat, with tool and Markdown surfaces in one conversation", async () => {
    using fixture = renderArtifactReferences(
      "![Latest](cake://artifact/report@r3)",
      {},
      [presentation("old", 1)],
      "project-chat",
    );
    await act(async () => fixture.ready);
    await expectOpen("old", false);
    await screen.findByText("report content r3");
    await fixture.user.click(surface("old"));
    await fixture.receiveTranscript(
      "![Latest](cake://artifact/report@r3)\n\nUpdated Project Chat prose",
    );
    await expectOpen("old", true);
  });

  it("applies the same rule to Markdown embeds while prose references alone do not collapse previews", async () => {
    using fixture = renderArtifactReferences("![First](cake://artifact/report@r1)");
    await screen.findByText("report content r1");
    await fixture.receiveTranscript(
      "![First](cake://artifact/report@r1)\n\n[Newer prose link](cake://artifact/report@r10)",
    );
    expect(
      screen.getByRole("button", { name: "First Collapse" }).getAttribute("aria-expanded"),
    ).toBe("true");
    await fixture.receiveTranscript(
      "![First](cake://artifact/report@r1)\n\n![Latest](cake://artifact/report@r10)",
    );
    await screen.findByText("report content r10");
    expect(screen.getByRole("button", { name: "First Expand" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    await fixture.user.click(screen.getByRole("button", { name: "First Expand" }));
    await fixture.receiveTranscript(
      "![First](cake://artifact/report@r1)\n\n![Latest](cake://artifact/report@r10)\n\nMore prose",
    );
    expect(
      screen.getByRole("button", { name: "First Collapse" }).getAttribute("aria-expanded"),
    ).toBe("true");
  });
});
