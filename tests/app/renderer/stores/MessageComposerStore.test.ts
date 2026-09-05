import { child, createStore, mount, Store } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { RendererClient } from "../../../../src/renderer/client/RendererClient";
import { RendererClientContext } from "../../../../src/renderer/client/RendererClientContext";
import { Message } from "../../../../src/renderer/models/Message";
import { Session } from "../../../../src/renderer/models/Session";
import { MessageComposerStore } from "../../../../src/renderer/stores/MessageComposerStore";
import type { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";

class HarnessStore extends Store<{
  client: RendererClient;
  model: Session;
  existing?: boolean;
  streaming?: boolean;
}> {
  draft = "First message";
  submissionOrder: string[] = [];

  [RendererClientContext.provide]() {
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
    const registry = {
      findModel: () => {
        throw new Error("Optimistic transcript reconciliation must not query the registry");
      },
      projectNewSessionSubmission: vi.fn(() => this.submissionOrder.push("projected")),
      materializeNewSession,
      cancelNewSessionSubmission: vi.fn(),
    } as unknown as SessionRegistryStore;
    return createStore(MessageComposerStore, {
      sessionRegistry: registry,
      reviews: () => {
        throw new Error("ReviewsStore is not used by this test");
      },
      projectPath: () => "/project",
      sessionId: () => "session-1",
      canonicalParts: () => this.props.model.uiParts,
      draft: () => this.draft,
      setDraft: (value) => {
        this.draft = value;
      },
      canSubmit: () => true,
      isStreaming: () => this.props.streaming ?? false,
      openCommandPane: async () => undefined,
      selectModel: async () => undefined,
      renameSession: async () => undefined,
      handoffSession: async () => false,
      operations: this.operations,
      operationOwner: "composer:session-1",
      newSessionRequest: () => (this.props.existing ? undefined : { path: "/project" }),
      prepareNewSession: async () => {
        this.submissionOrder.push("prepared");
        return true;
      },
    });
  }
}

class DraftHarnessStore extends Store<{ client: RendererClient }> {
  draft = "";
  private staged: { text: string; attachments: []; resolved: boolean } | undefined = {
    text: "# Draft heading",
    attachments: [],
    resolved: false,
  };

  [RendererClientContext.provide]() {
    return this.props.client;
  }

  @child get operations() {
    return createStore(SessionOperationCoordinatorStore);
  }

  @child get composer() {
    const registry = {
      draftSessionPrompt: () => this.staged,
      activateDraftSession: () => {
        const staged = this.staged;
        this.staged = undefined;
        return staged;
      },
      projectNewSessionSubmission: vi.fn(),
      cancelNewSessionSubmission: vi.fn(),
    } as unknown as SessionRegistryStore;
    return createStore(MessageComposerStore, {
      sessionRegistry: registry,
      reviews: () => {
        throw new Error("ReviewsStore is not used by this test");
      },
      projectPath: () => "/project",
      sessionId: () => "draft-session",
      canonicalParts: () => [],
      draft: () => this.draft,
      setDraft: (value) => {
        this.draft = value;
      },
      canSubmit: () => true,
      isStreaming: () => false,
      openCommandPane: async () => undefined,
      selectModel: async () => undefined,
      renameSession: async () => undefined,
      handoffSession: async () => false,
      operations: this.operations,
      operationOwner: "composer:draft-session",
    });
  }
}

describe("MessageComposerStore", () => {
  it("restores all dequeued messages to the composer", () => {
    const model = Session.create({ sessionId: "session-1", workingDirectory: "/project" });
    const root = mount(
      createStore(HarnessStore, { client: {} as RendererClient, model, existing: true }),
    );

    root.composer.restoreDequeuedMessages(["External steering", "External follow-up"]);

    expect(root.draft).toBe("External steering\n\nExternal follow-up\n\nFirst message");

    root[Symbol.dispose]();
    model[Symbol.dispose]();
  });

  it("sends streaming input directly to Pi's follow-up queue without transcript optimism", async () => {
    const model = Session.create({ sessionId: "session-1", workingDirectory: "/project" });
    const followUp = vi.fn(async () => "turn-2");
    const client = { projectSessions: { followUp } } as unknown as RendererClient;
    const root = mount(
      createStore(HarnessStore, { client, model, existing: true, streaming: true }),
    );

    await root.composer.submit();

    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", text: "First message" }),
      expect.objectContaining({ signal: root.composer.signal }),
    );
    expect(root.composer.optimisticUserMessages.pending).toEqual([]);
    expect(root.composer.parts).toEqual([]);

    root[Symbol.dispose]();
    model[Symbol.dispose]();
  });

  it("reconciles the first optimistic message when its canonical part completes in place", async () => {
    const model = Session.create({ sessionId: "session-1", workingDirectory: "/project" });
    const start = vi.fn(async () => "turn-1");
    const client = { projectSessions: { start } } as unknown as RendererClient;
    const root = mount(createStore(HarnessStore, { client, model }));

    await root.composer.submit();

    expect(start).toHaveBeenCalledOnce();
    expect(root.submissionOrder).toEqual(["projected", "prepared"]);
    expect(root.composer.optimisticUserMessages.pending).toEqual([]);
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

  it("renders and activates detected Markdown in a saved draft", async () => {
    const prompt = vi.fn(async () => "turn-1");
    const client = { projectSessions: { prompt } } as unknown as RendererClient;
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
      expect.anything(),
    );
    root[Symbol.dispose]();
  });
});
