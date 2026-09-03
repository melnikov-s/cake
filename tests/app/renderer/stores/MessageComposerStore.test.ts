import { child, createStore, mount, Store } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { RendererClient } from "../../../../src/renderer/client/RendererClient";
import { RendererClientContext } from "../../../../src/renderer/client/RendererClientContext";
import { Message } from "../../../../src/renderer/models/Message";
import { Session } from "../../../../src/renderer/models/Session";
import { MessageComposerStore } from "../../../../src/renderer/stores/MessageComposerStore";
import type { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";

class HarnessStore extends Store<{ client: RendererClient; model: Session }> {
  draft = "First message";

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
      projectNewSessionSubmission: vi.fn(),
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
      isStreaming: () => false,
      openCommandPane: async () => undefined,
      matchesPluginCommand: () => false,
      runPluginCommand: async () => false,
      selectModel: async () => undefined,
      renameSession: async () => undefined,
      handoffSession: async () => false,
      operations: this.operations,
      operationOwner: "composer:session-1",
      newSessionRequest: () => ({ path: "/project" }),
      prepareNewSession: async () => true,
    });
  }
}

describe("MessageComposerStore", () => {
  it("reconciles the first optimistic message when its canonical part completes in place", async () => {
    const model = Session.create({ sessionId: "session-1", workingDirectory: "/project" });
    const start = vi.fn(async () => "turn-1");
    const client = { projectSessions: { start } } as unknown as RendererClient;
    const root = mount(createStore(HarnessStore, { client, model }));

    await root.composer.submit();

    expect(start).toHaveBeenCalledOnce();
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
});
