import { createStore, mount, toSnapshot } from "r-state-tree";
import { describe, expect, it } from "vitest";
import { ComposerDraftStore } from "../../../../src/renderer/stores/ComposerDraftStore";

describe("ComposerDraftStore", () => {
  it("owns text, attachments, annotations, editor context, focus, and coherent clearing", () => {
    const store = mount(createStore(ComposerDraftStore, {}));
    const context = {
      kind: "source" as const,
      name: "active.ts",
      location: { path: "/project/active.ts", range: { start: { line: 1 }, end: { line: 2 } } },
    };
    store.setText("Explain this");
    store.setEditorContextAttachment(context);
    store.addSourceAttachment({ ...context });
    store.annotationDraft.add({
      messageId: "assistant-1",
      selectedText: "answer",
      startOffset: 0,
      endOffset: 6,
      contextBefore: "",
      contextAfter: "",
      comment: "Expand",
    });

    expect(store.visibleAttachments).toEqual([context]);
    expect(store.focusRequestRevision).toBe(2);
    expect(store.submissionAttachments).toEqual([
      context,
      expect.objectContaining({ kind: "annotation" }),
    ]);
    expect(toSnapshot(store).state).toMatchObject({
      text: "Explain this",
      editorContextAttachment: context,
      attachments: [context],
      annotations: [expect.objectContaining({ comment: "Expand" })],
    });

    store.clearForSubmit();
    expect(store.text).toBe("");
    expect(store.attachments).toEqual([]);
    expect(store.annotationDraft.annotations).toEqual([]);
    expect(store.editorContextAttachment).toEqual(context);

    store.clear();
    expect(store.editorContextAttachment).toBeUndefined();
    store[Symbol.dispose]();
  });

  it("restores a failed submission without replacing the next draft", () => {
    const store = mount(createStore(ComposerDraftStore, {}));
    store.setText("Next message");
    store.attachments.push({ kind: "image", name: "next.png", mimeType: "image/png", data: "2" });
    store.restoreAfterFailure("Failed message", [
      { kind: "image", name: "failed.png", mimeType: "image/png", data: "1" },
    ]);

    expect(store.text).toBe("Next message");
    expect(store.attachments.map((item) => item.kind === "image" && item.name)).toEqual([
      "next.png",
      "failed.png",
    ]);
    store[Symbol.dispose]();
  });
});
