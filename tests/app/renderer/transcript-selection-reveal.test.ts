import { expect, it, vi } from "vitest";
import type { LegendListRef } from "@legendapp/list/react";
import { revealTranscriptSelection } from "../../../src/renderer/lib/transcript-selection-reveal";

function fakeList(itemTop: number) {
  // SAFETY: the reveal only reads the item's anchor and requests one scroll.
  return {
    anchorVisibleContent: vi.fn(() => ({ key: "answer-12", offset: -itemTop })),
    scrollToIndex: vi.fn(async () => undefined),
    scrollIndexIntoView: vi.fn(async () => undefined),
  } as unknown as LegendListRef & {
    scrollToIndex: ReturnType<typeof vi.fn>;
    scrollIndexIntoView: ReturnType<typeof vi.fn>;
  };
}

it("aligns a long selected message's hidden start even when it already covers the viewport", () => {
  // Arrowing up from the composer selects the newest answer: 1282px tall, its
  // start 630px above a 775px viewport, its end inside it.
  const list = fakeList(-630);
  void revealTranscriptSelection(list, { index: 35, key: "answer-12", start: 16, end: 139 });
  expect(list.scrollToIndex).toHaveBeenCalledWith({
    index: 35,
    animated: false,
    viewOffset: 16,
    viewPosition: 0,
  });
  expect(list.scrollIndexIntoView).not.toHaveBeenCalled();
});

it("leaves a selected message whose start is visible to the list's minimal reveal", () => {
  const list = fakeList(240);
  void revealTranscriptSelection(list, { index: 3, key: "answer-2", start: 16, end: 139 });
  expect(list.scrollIndexIntoView).toHaveBeenCalledWith({
    index: 3,
    animated: false,
    viewportMargin: { start: 16, end: 139 },
  });
  expect(list.scrollToIndex).not.toHaveBeenCalled();
});
