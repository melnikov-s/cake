import { createStore, mount, observable } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { UiPart } from "../../../../src/ipc/session-contract";
import { TranscriptInteractionStore } from "../../../../src/renderer/stores/TranscriptInteractionStore";

function createTranscriptStore(
  parts: () => UiPart[] = () => [],
  setMarkdown?: (entryId: string, renderAsMarkdown: boolean) => Promise<void>,
) {
  return mount(
    createStore(TranscriptInteractionStore, {
      parts,
      loading: () => false,
      userMessagePresentation: setMarkdown ? { setMarkdown } : undefined,
    }),
  );
}

describe("TranscriptInteractionStore", () => {
  it("owns scroll restoration, revised navigation, and changed-files disclosure", () => {
    const store = createTranscriptStore();
    store.setTranscriptScrollPosition({ kind: "message", messageId: "user-1", offset: -20 });
    store.navigateToMessage("assistant-1");
    store.navigateToMessage("assistant-1");
    expect(store.transcriptScrollPosition).toBeUndefined();
    expect(store.messageNavigationRequest).toEqual({ messageId: "assistant-1", revision: 2 });

    store.setChangedFilesOpen(true);
    store.syncChangedFilesOpen(true);
    expect(store.changedFilesOpen).toBe(false);
    store[Symbol.dispose]();
  });

  it("optimistically presents Markdown until the authoritative projection catches up", async () => {
    const part = observable({
      id: "user-part",
      kind: "text" as const,
      role: "user" as const,
      text: "# Heading",
      status: "complete" as const,
      entryId: "user-entry",
      renderAs: undefined as "markdown" | undefined,
    });
    const setMarkdown = vi.fn(async () => undefined);
    const store = createTranscriptStore(() => [part], setMarkdown);

    await store.setUserMessageMarkdown("user-entry", true);
    expect(store.userMessageRendersAsMarkdown("user-entry", false)).toBe(true);
    part.renderAs = "markdown";
    expect(store.userMessageRendersAsMarkdown("user-entry", true)).toBe(true);
    expect(setMarkdown).toHaveBeenCalledWith("user-entry", true);
    store[Symbol.dispose]();
  });
});
