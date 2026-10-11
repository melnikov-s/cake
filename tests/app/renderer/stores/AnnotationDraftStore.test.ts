import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { AnnotationDraftStore } from "../../../../src/renderer/stores/AnnotationDraftStore";

const annotation = (index: number) => ({
  messageId: `message-${index}`,
  selectedText: `selection-${index}`,
  startOffset: index,
  endOffset: index + 1,
  contextBefore: "before",
  contextAfter: "after",
});

// Retain only the admission cap: adding the 101st annotation requires native
// text-selection initiation, which has no honest jsdom workflow path. Do not
// fabricate selection callbacks or transcript geometry to exercise that action.
// annotation-comment-workflow.test.tsx owns visible removal, annotation-only
// submission/clearing and failure/retry; utils/annotations.test.ts covers the
// optional-field update codec. Native edit/selection behavior lives in Electron.
describe("AnnotationDraftStore selection-admission regression", () => {
  it("enforces the shared annotation limit", () => {
    const onLimitReached = vi.fn();
    const draft = mount(createStore(AnnotationDraftStore, { onLimitReached }));

    for (let index = 0; index < 100; index += 1) expect(draft.add(annotation(index))).toBe(true);

    expect(draft.add(annotation(100))).toBe(false);
    expect(draft.annotations).toHaveLength(100);
    expect(onLimitReached).toHaveBeenCalledOnce();
    draft[Symbol.dispose]();
  });
});
