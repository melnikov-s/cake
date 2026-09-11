import { child, createStore, mount, Store } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import { ClientContext } from "../../../../src/renderer/stores/context/ClientContext";
import { Message } from "../../../../src/renderer/models/Message";
import { Session } from "../../../../src/renderer/models/Session";
import { ConversationComposerStore } from "../../../../src/renderer/stores/ConversationComposerStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";

class HarnessStore extends Store<{
  client: Client;
  model: Session;
  existing?: boolean;
  streaming?: boolean;
  canHandoff?: boolean;
  createSideChat?: (prompt: string) => Promise<boolean>;
  handoffSession?: (entryId: string, prompt?: string, resolveSource?: boolean) => Promise<boolean>;
}> {
  draft = "First message";
  submissionOrder: string[] = [];

  [ClientContext.provide]() {
    return this.props.client;
  }

  @child get operations() {
    return createStore(SessionOperationCoordinatorStore);
  }

  @child get composer() {
    const materializeNewSession = vi.fn(() => {
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
    });
    return createStore(ConversationComposerStore, {
      projectPath: () => "/project",
      sessionId: () => "session-1",
      canonicalParts: () => this.props.model.uiParts,
      canSubmit: () => true,
      isStreaming: () => this.props.streaming ?? false,
      queueWhileStreaming: () => true,
      openCommandPane: async () => undefined,
      createSideChat: this.props.createSideChat,
      selectModel: async () => undefined,
      renameSession: async () => undefined,
      canHandoff: () => this.props.canHandoff ?? true,
      handoffSession: this.props.handoffSession ?? (async () => false),
      deliver: async (input) => {
        if (this.props.existing) {
          const command =
            input.delivery === "steer"
              ? this.props.client.projectSessions.steer
              : this.props.client.projectSessions.prompt;
          await command(input);
          return;
        }
        this.submissionOrder.push("projected", "prepared");
        await this.props.client.projectSessions.start({ ...input, workingDirectory: "/project" });
        materializeNewSession();
      },
      editMessage: async () => undefined,
      compact: async () => undefined,
      clearQueue: async () => {
        await this.props.client.projectSessions.clearQueue({ sessionId: "session-1" });
      },
      cancelSteering: async () => {
        await this.props.client.projectSessions.cancelSteering({ sessionId: "session-1" });
      },
      operations: this.operations,
      operationOwner: "composer:session-1",
    });
  }
}

class DraftHarnessStore extends Store<{ client: Client }> {
  draft = "";
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
      handoffSession: async () => false,
      deliver: async (input) => {
        await this.props.client.projectSessions.prompt({
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

describe("ConversationComposerStore", () => {
  it("allows handoff-and-resolve while VS Code contributes automatic source context", async () => {
    const model = Session.create({
      sessionId: "session-1",
      workingDirectory: "/project",
      parts: [
        {
          id: "assistant-part",
          kind: "text",
          role: "assistant",
          text: "Completed response",
          status: "complete",
          piId: "assistant-entry",
          partKey: "assistant-part",
        },
      ],
    });
    const handoffSession = vi.fn(async () => true);
    const client = { projectSessions: {} } as unknown as Client;
    const root = mount(
      createStore(HarnessStore, { client, model, existing: true, handoffSession }),
    );
    root.composer.draftStore.setText("/handoffandresolve Continue cleanly");
    root.composer.draftStore.setEditorContextAttachment({
      kind: "source",
      name: "active.ts",
      location: {
        path: "/project/active.ts",
        range: { start: { line: 1 }, end: { line: 2 } },
      },
    });

    await root.composer.submit();

    expect(handoffSession).toHaveBeenCalledWith("assistant-entry", "Continue cleanly", true);
    expect(root.composer.draftStore.text).toBe("");
    root[Symbol.dispose]();
    model[Symbol.dispose]();
  });

  it("rejects a typed handoff command when the session belongs to a family", async () => {
    const model = Session.create({
      sessionId: "session-1",
      workingDirectory: "/project",
      parts: [
        {
          id: "assistant-part",
          kind: "text",
          role: "assistant",
          text: "Completed response",
          status: "complete",
          piId: "assistant-entry",
          partKey: "assistant-part",
        },
      ],
    });
    const handoffSession = vi.fn(async () => true);
    const client = { projectSessions: {} } as unknown as Client;
    const root = mount(
      createStore(HarnessStore, {
        client,
        model,
        existing: true,
        canHandoff: false,
        handoffSession,
      }),
    );
    root.composer.draftStore.setText("/handoff Continue cleanly");

    await expect(root.composer.submit()).resolves.toBe(false);

    expect(handoffSession).not.toHaveBeenCalled();
    expect(root.composer.error).toBe("Session Family members cannot be handed off");
    root[Symbol.dispose]();
    model[Symbol.dispose]();
  });

  it("creates a side chat from /sidechat without sending to the parent session", async () => {
    const createSideChat = vi.fn(async () => true);
    const client = { projectSessions: {} } as unknown as Client;
    const model = Session.create({ sessionId: "session-1", workingDirectory: "/project" });
    const root = mount(
      createStore(HarnessStore, { client, model, existing: true, createSideChat }),
    );
    root.composer.draftStore.setText("/sidechat Compare the two approaches");

    await expect(root.composer.submit()).resolves.toBe(true);

    expect(createSideChat).toHaveBeenCalledWith("Compare the two approaches");
    expect(root.composer.draftStore.text).toBe("");
    root[Symbol.dispose]();
    model[Symbol.dispose]();
  });

  it("reports usage when /sidechat has no prompt", async () => {
    const createSideChat = vi.fn(async () => true);
    const client = { projectSessions: {} } as unknown as Client;
    const model = Session.create({ sessionId: "session-1", workingDirectory: "/project" });
    const root = mount(
      createStore(HarnessStore, { client, model, existing: true, createSideChat }),
    );
    root.composer.draftStore.setText("/sidechat");

    await expect(root.composer.submit()).resolves.toBe(false);

    expect(createSideChat).not.toHaveBeenCalled();
    expect(root.composer.error).toBe("Usage: /sidechat <prompt>");
    root[Symbol.dispose]();
    model[Symbol.dispose]();
  });

  it("preserves the next message's context when an in-flight send fails", async () => {
    let rejectPrompt!: (error: Error) => void;
    const prompt = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPrompt = reject;
        }),
    );
    const client = { projectSessions: { prompt } } as unknown as Client;
    const model = Session.create({ sessionId: "session-1", workingDirectory: "/project" });
    const root = mount(createStore(HarnessStore, { client, model, existing: true }));
    root.composer.draftStore.setText("First message");
    const sentImage = {
      kind: "image" as const,
      name: "sent.png",
      mimeType: "image/png",
      data: "sent",
    };
    const nextImage = { ...sentImage, name: "next.png", data: "next" };
    const nextContext = {
      kind: "source" as const,
      name: "next.ts",
      location: { path: "/project/next.ts", range: { start: { line: 1 }, end: { line: 2 } } },
    };
    root.composer.draftStore.attachments.push(sentImage);
    const submission = root.composer.submit();
    root.composer.draftStore.setText("Next message");
    root.composer.draftStore.attachments.push(nextImage);
    root.composer.draftStore.editorContextAttachment = nextContext;
    rejectPrompt(new Error("Send failed"));
    await submission;

    expect(root.composer.draftStore.text).toBe("Next message");
    expect(root.composer.draftStore.attachments).toEqual([nextImage, sentImage]);
    expect(root.composer.draftStore.editorContextAttachment).toEqual(nextContext);
    expect(root.composer.deliveryStore.optimisticUserMessages.pending).toEqual([]);
    expect(root.composer.deliveryStore.activeOperations).toEqual([]);
    root[Symbol.dispose]();
    model[Symbol.dispose]();
  });

  it("keeps streaming project input in the local editable queue when configured", async () => {
    const model = Session.create({ sessionId: "session-1", workingDirectory: "/project" });
    const followUp = vi.fn(async () => "turn-2");
    const client = { projectSessions: { followUp } } as unknown as Client;
    const root = mount(
      createStore(HarnessStore, { client, model, existing: true, streaming: true }),
    );
    root.composer.draftStore.setText("First message");

    await root.composer.submit();

    expect(followUp).not.toHaveBeenCalled();
    expect(root.composer.promptQueueStore.prompts).toEqual([
      expect.objectContaining({ text: "First message" }),
    ]);
    expect(root.composer.deliveryStore.optimisticUserMessages.pending).toEqual([]);

    root[Symbol.dispose]();
    model[Symbol.dispose]();
  });

  it("returns a cancelled local steer to its queue position", async () => {
    const model = Session.create({ sessionId: "session-1", workingDirectory: "/project" });
    const steer = vi.fn(async () => "turn-2");
    const clearQueue = vi.fn(async () => ({ steering: ["First message"], followUp: [] }));
    const client = { projectSessions: { steer, clearQueue } } as unknown as Client;
    const root = mount(
      createStore(HarnessStore, { client, model, existing: true, streaming: true }),
    );
    root.composer.promptQueueStore.enqueue("Before", [], false);
    root.composer.promptQueueStore.enqueue("First message", [], false);
    root.composer.promptQueueStore.enqueue("After", [], false);
    const steered = root.composer.promptQueueStore.prompts[1]!;

    root.composer.promptQueueStore.steer(steered.id);

    expect(steer).toHaveBeenCalledOnce();
    expect(root.composer.promptQueueStore.prompts.map((entry) => entry.text)).toEqual([
      "Before",
      "After",
    ]);
    expect(root.composer.parts).toEqual([
      expect.objectContaining({ text: "First message", deliveryState: "steering" }),
    ]);

    await root.composer.promptQueueStore.cancelSteering();

    expect(clearQueue).toHaveBeenCalledOnce();
    expect(root.composer.promptQueueStore.prompts.map((entry) => entry.text)).toEqual([
      "Before",
      "First message",
      "After",
    ]);
    expect(root.composer.parts).toEqual([]);

    root[Symbol.dispose]();
    model[Symbol.dispose]();
  });

  it("reconciles the first optimistic message when its canonical part completes in place", async () => {
    const model = Session.create({ sessionId: "session-1", workingDirectory: "/project" });
    const start = vi.fn(async () => "turn-1");
    const client = { projectSessions: { start } } as unknown as Client;
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
    const prompt = vi.fn(async () => "turn-1");
    const client = { projectSessions: { prompt } } as unknown as Client;
    const model = Session.create({ sessionId: "session-1", workingDirectory: "/project" });
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
    expect(root.composer.draftStore.focusRequestRevision).toBe(1);
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
    const prompt = vi.fn(async () => "turn-1");
    const client = { projectSessions: { prompt } } as unknown as Client;
    const root = mount(createStore(DraftHarnessStore, { client }));

    expect(root.composer.parts).toEqual([
      expect.objectContaining({
        text: "# Draft heading",
        renderAs: "markdown",
        draft: true,
      }),
    ]);

    await root.composer.activateDraftSession({ kind: "current" });

    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "# Draft heading",
        renderUserMessageAsMarkdown: true,
      }),
    );
    root[Symbol.dispose]();
  });
});
