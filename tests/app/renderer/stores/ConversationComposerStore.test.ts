import { TurnId } from "../../../../src/domain/conversations/conversation-data";
import { child, createStore, mount, Store } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import { ClientContext } from "../../../../src/renderer/stores/context/ClientContext";
import { Message } from "../../../../src/renderer/models/Message";
import { Conversation } from "../../../../src/renderer/models/Conversation";
import { ConversationComposerStore } from "../../../../src/renderer/stores/ConversationComposerStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import { createTestClient } from "../test-client";

/**
 * Remaining migration backlog, not workflow coverage:
 * - canonical in-place reconciliation needs a working virtualized Chat transcript fixture;
 * - transcript annotations need the native text-selection interaction boundary;
 * - Markdown Draft activation remains until saved-draft workflow coverage owns it.
 * Composer/attachment/command workflows moved to ../composer-workflow.test.tsx;
 * streaming queues to ../prompt-queue-workflow.test.tsx; side-chat creation to
 * ../side-chat-workflow.test.tsx. Do not expand this legacy collaborator harness.
 */
class HarnessStore extends Store<{ client: Client; model: Conversation; existing?: boolean }> {
  submissionOrder: string[] = [];
  [ClientContext.provide]() {
    return this.props.client;
  }
  @child get operations() {
    return createStore(SessionOperationCoordinatorStore);
  }
  @child get composer() {
    return createStore(ConversationComposerStore, {
      projectPath: () => "/project",
      sessionId: () => "session-1",
      canonicalParts: () => this.props.model.uiParts,
      canSubmit: () => true,
      isStreaming: () => false,
      openCommandPane: async () => undefined,
      selectModel: async () => undefined,
      renameSession: async () => undefined,
      toolCompactSession: async () => false,
      deliver: async (input) => {
        if (this.props.existing) {
          await this.props.client.sessionChats.prompt(input);
          return;
        }
        this.submissionOrder.push("projected", "prepared");
        await this.props.client.projectSessions.start({ ...input, workingDirectory: "/project" });
        this.props.model.parts.push(
          Message.create({
            id: "canonical-user-1",
            partKey: "canonical-user-1",
            kind: "text",
            role: "user",
            text: "First message",
            status: "streaming",
          }),
        );
        this.props.model.parts[0]!.update({
          id: "canonical-user-1",
          kind: "text",
          role: "user",
          text: "First message",
          status: "complete",
        });
      },
      editMessage: async () => undefined,
      compact: async () => undefined,
      operations: this.operations,
      operationOwner: "composer:session-1",
    });
  }
}
class DraftHarnessStore extends Store<{ client: Client }> {
  private staged: { text: string; attachments: []; resolved: boolean } | undefined = {
    text: "# Draft heading",
    attachments: [],
    resolved: false,
  };
  [ClientContext.provide]() {
    return this.props.client;
  }
  @child get operations() {
    return createStore(SessionOperationCoordinatorStore);
  }
  @child get composer() {
    return createStore(ConversationComposerStore, {
      projectPath: () => "/project",
      sessionId: () => "draft-session",
      canonicalParts: () => [],
      canSubmit: () => true,
      isStreaming: () => false,
      openCommandPane: async () => undefined,
      selectModel: async () => undefined,
      renameSession: async () => undefined,
      toolCompactSession: async () => false,
      deliver: async (input) => {
        await this.props.client.sessionChats.prompt({
          sessionId: input.sessionId,
          text: input.text,
          attachments: input.attachments,
          renderUserMessageAsMarkdown: input.renderUserMessageAsMarkdown,
        });
      },
      editMessage: async () => undefined,
      compact: async () => undefined,
      draftSessionPrompt: () => this.staged,
      isDeferredSession: () => true,
      activateDraftSession: () => {
        const staged = this.staged;
        this.staged = undefined;
        return staged;
      },
      operations: this.operations,
      operationOwner: "composer:draft-session",
    });
  }
}

describe("ConversationComposerStore remaining migration regressions", () => {
  it("reconciles the first optimistic message when its canonical part completes in place", async () => {
    const model = Conversation.create({ sessionId: "session-1" });
    const start = vi.fn<Client["projectSessions"]["start"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    const client = createTestClient({ projectSessions: { start } });
    const root = mount(createStore(HarnessStore, { client, model }));
    root.composer.draftStore.setText("First message");
    await root.composer.submit();
    expect(start).toHaveBeenCalledOnce();
    expect(root.submissionOrder).toEqual(["projected", "prepared"]);
    expect(root.composer.deliveryStore.optimisticUserMessages.pending).toEqual([]);
    expect(root.composer.parts).toEqual([
      expect.objectContaining({
        id: "canonical-user-1",
        text: "First message",
        deliveryState: undefined,
      }),
    ]);
    root[Symbol.dispose]();
    model[Symbol.dispose]();
  });
  it("delivers annotations from its draft Store and clears them after submission", async () => {
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    const client = createTestClient({ sessionChats: { prompt } });
    const model = Conversation.create({ sessionId: "session-1" });
    const root = mount(createStore(HarnessStore, { client, model, existing: true }));
    root.composer.draftStore.setText("First message");
    root.composer.draftStore.annotationDraft.add({
      messageId: "assistant-1",
      selectedText: "important answer",
      startOffset: 3,
      endOffset: 19,
      contextBefore: "An ",
      contextAfter: " follows.",
      comment: "Go deeper",
    });
    await root.composer.submit();
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
    );
    expect(root.composer.draftStore.annotationDraft.annotations).toEqual([]);
    root[Symbol.dispose]();
    model[Symbol.dispose]();
  });
  it("renders and activates detected Markdown in a saved draft", async () => {
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    const client = createTestClient({ sessionChats: { prompt } });
    const root = mount(createStore(DraftHarnessStore, { client }));
    expect(root.composer.parts).toEqual([
      expect.objectContaining({ text: "# Draft heading", renderAs: "markdown", draft: true }),
    ]);
    await root.composer.activateDraftSession({ kind: "current" });
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: "# Draft heading", renderUserMessageAsMarkdown: true }),
    );
    root[Symbol.dispose]();
  });
});
