import { child, createStore, mount, Store } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { ConversationDeliveryInput } from "../../../../src/renderer/stores/ConversationDeliveryStore";
import { ConversationDeliveryStore } from "../../../../src/renderer/stores/ConversationDeliveryStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";

class HarnessStore extends Store<{
  deliver(input: ConversationDeliveryInput): Promise<boolean>;
  restoreDraft(text: string, attachments: ConversationDeliveryInput["attachments"]): void;
}> {
  readonly canonicalParts = [];

  @child get operations() {
    return createStore(SessionOperationCoordinatorStore);
  }

  @child get delivery() {
    return createStore(ConversationDeliveryStore, {
      sessionId: () => "session-1",
      canonicalParts: () => this.canonicalParts,
      isStreaming: () => false,
      deliver: this.props.deliver,
      editMessage: async () => undefined,
      compact: async () => undefined,
      operations: this.operations,
      operationOwner: "composer:session-1",
      restoreDraft: this.props.restoreDraft,
      replaceDraft: () => undefined,
      requestFocus: () => undefined,
    });
  }
}

describe("ConversationDeliveryStore", () => {
  it("correlates an optimistic prompt with its operation", async () => {
    let accept!: () => void;
    const deliver = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          accept = () => resolve(true);
        }),
    );
    const root = mount(createStore(HarnessStore, { deliver, restoreDraft: () => undefined }));

    const sending = root.delivery.send("Hello", [], "prompt", true, false);
    expect(root.delivery.activeOperations).toHaveLength(1);
    expect(root.delivery.parts).toEqual([
      expect.objectContaining({ text: "Hello", deliveryState: "sending" }),
    ]);
    accept();
    await sending;
    expect(root.delivery.activeOperations).toEqual([]);
    root[Symbol.dispose]();
  });

  it("removes optimistic state and restores the submission after failure", async () => {
    const restoreDraft = vi.fn();
    const deliver = vi.fn(async () => {
      throw new Error("Send failed");
    });
    const root = mount(createStore(HarnessStore, { deliver, restoreDraft }));

    expect(await root.delivery.send("Retry me", [], "prompt", true, false)).toBe(false);
    expect(root.delivery.optimisticUserMessages.pending).toEqual([]);
    expect(restoreDraft).toHaveBeenCalledWith("Retry me", []);
    expect(root.delivery.error).toBe("Send failed");
    root[Symbol.dispose]();
  });
});
