import { child, createStore, mount, Store, toSnapshot } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import { ComposerDraftStore } from "../../../../src/renderer/stores/ComposerDraftStore";
import { ClientContext } from "../../../../src/renderer/stores/context/ClientContext";

class AttachmentHarnessStore extends Store<{ client: Client }> {
  [ClientContext.provide]() {
    return this.props.client;
  }

  @child get draft() {
    return createStore(ComposerDraftStore, {});
  }
}

describe("ComposerDraftStore", () => {
  it("keeps two chosen local files with the same basename as removable attachments", async () => {
    const first = { kind: "file" as const, name: "notes.txt", path: "/one/notes.txt" };
    const second = { kind: "file" as const, name: "notes.txt", path: "/two/notes.txt" };
    const chooseAttachments = vi
      .fn()
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([second]);
    const harness = mount(
      createStore(AttachmentHarnessStore, {
        client: { filesystem: { chooseAttachments } } as unknown as Client,
      }),
    );
    harness.draft.setText("Compare these");
    await harness.draft.addAttachments();
    await harness.draft.addAttachments();
    expect(harness.draft.text).toBe("Compare these");
    expect(harness.draft.submissionAttachments).toEqual([first, second]);
    harness.draft.removeAttachment(0);
    expect(harness.draft.submissionAttachments).toEqual([second]);
    harness[Symbol.dispose]();
  });

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
    expect(store.editorContextAttachment).toBeUndefined();
    expect(store.visibleAttachments).toEqual([]);

    store.clear();
    expect(store.editorContextAttachment).toBeUndefined();
    store[Symbol.dispose]();
  });

  it("restores consumed source context on a failed submission", () => {
    const store = mount(createStore(ComposerDraftStore, {}));
    const context = {
      kind: "source" as const,
      name: "active.ts",
      location: { path: "src/active.ts", range: { start: { line: 1 }, end: { line: 2 } } },
    };
    store.setEditorContextAttachment(context);
    const submitted = store.submissionAttachments;
    store.clearForSubmit();
    expect(store.visibleAttachments).toEqual([]);
    store.restoreAfterFailure("Explain this", submitted);
    expect(store.visibleAttachments).toEqual([context]);
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
