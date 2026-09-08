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

describe("AnnotationDraftStore", () => {
  it("adds, updates, removes, and clears draft annotations", () => {
    const draft = mount(createStore(AnnotationDraftStore));

    expect(draft.add({ ...annotation(1), entryId: "entry-1", comment: "Original" })).toBe(true);
    const id = draft.annotations[0]!.id;
    draft.update(id, { comment: "Updated", entryId: undefined });

    expect(draft.annotations).toEqual([
      expect.objectContaining({ id, comment: "Updated", messageId: "message-1" }),
    ]);
    expect(draft.annotations[0]).not.toHaveProperty("entryId");

    draft.remove(id);
    expect(draft.annotations).toEqual([]);

    draft.append([{ id: "existing", ...annotation(2) }]);
    draft.clear();
    expect(draft.annotations).toEqual([]);
    draft[Symbol.dispose]();
  });

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
