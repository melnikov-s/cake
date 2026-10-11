/** @vitest-environment jsdom */
import { TurnId } from "../../../../src/ipc/conversation-data";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import { createComposerInputFixture } from "../composer-input-workflow-fixture";

// Retained annotation-delivery regression: native transcript selection and
// annotation initiation require Electron. Do not fabricate that interaction
// in React. This checks send/clear policy after capture using real Root/Stores.
// In-place prompt completion is covered by composer-input-workflow; Markdown
// saved-draft rendering/activation belongs to saved-draft-workflow (the former
// staged collaborator activation path is no longer production saved storage).
describe("ConversationComposerStore captured annotation regression", () => {
  it("delivers a captured annotation once and clears it after submission", async () => {
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    using fixture = createComposerInputFixture({ sessionChats: { prompt } }, [
      {
        id: "assistant-1",
        entryId: "assistant-entry",
        kind: "text",
        role: "assistant",
        text: "An important answer follows.",
        status: "complete",
      },
    ]);
    const composer = fixture.conversation.composerStore;
    composer.draftStore.setText("First message");
    composer.draftStore.annotationDraft.add({
      messageId: "assistant-1",
      selectedText: "important answer",
      startOffset: 3,
      endOffset: 19,
      contextBefore: "An ",
      contextAfter: " follows.",
      comment: "Go deeper",
    });
    await composer.submit();
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          {
            kind: "annotation",
            annotations: [
              expect.objectContaining({
                messageId: "assistant-1",
                selectedText: "important answer",
                comment: "Go deeper",
              }),
            ],
          },
        ],
      }),
      expect.any(Object),
    );
    expect(composer.draftStore.annotationDraft.annotations).toEqual([]);
    composer.draftStore.setText("Next message");
    await composer.submit();
    expect(prompt).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "Next message", attachments: [] }),
      expect.any(Object),
    );
  });
});
