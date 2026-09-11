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

  it("lets an explicit annotation supersede the implicit editor context at the same location", () => {
    const store = mount(createStore(ComposerDraftStore, {}));
    const location = { path: "src/app.ts", range: { start: { line: 3 }, end: { line: 4 } } };
    const context = { kind: "source" as const, name: "src/app.ts", location };
    const annotation = { ...context, selectedText: "return total;", comment: "Rounding?" };
    store.setEditorContextAttachment(context);
    store.addSourceAttachment(annotation);

    // The annotated copy is what the user sees and what gets sent, not the bare context.
    expect(store.visibleAttachments).toEqual([annotation]);
    expect(store.submissionAttachments).toEqual([annotation]);

    // Annotating the same range again replaces the note instead of being ignored.
    store.addSourceAttachment({ ...annotation, comment: "Off by one?" });
    expect(store.attachments).toEqual([{ ...annotation, comment: "Off by one?" }]);

    // Removing the visible chip removes the annotation and reveals the context again.
    store.removeAttachment(0);
    expect(store.attachments).toEqual([]);
    expect(store.visibleAttachments).toEqual([context]);
    store.removeAttachment(0);
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
