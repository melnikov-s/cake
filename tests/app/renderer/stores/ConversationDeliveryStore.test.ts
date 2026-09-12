import { child, createStore, mount, observable, Store } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { UiPart } from "../../../../src/ipc/session-contract";
import type {
  ConversationDeliveryInput,
  ConversationDeliveryStoreProps,
} from "../../../../src/renderer/stores/ConversationDeliveryStore";
import { ConversationDeliveryStore } from "../../../../src/renderer/stores/ConversationDeliveryStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";

class HarnessStore extends Store<{
  deliver(input: ConversationDeliveryInput): Promise<boolean>;
  editMessage?: ConversationDeliveryStoreProps["editMessage"];
  restoreDraft(text: string, attachments: ConversationDeliveryInput["attachments"]): void;
}> {
  readonly canonicalParts: UiPart[] = observable([]);

  @child get operations() {
    return createStore(SessionOperationCoordinatorStore);
  }

  @child get delivery() {
    return createStore(ConversationDeliveryStore, {
      sessionId: () => "session-1",
      canonicalParts: () => this.canonicalParts,
      isStreaming: () => false,
      deliver: this.props.deliver,
      editMessage: this.props.editMessage ?? (async () => undefined),
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

  it("reconciles an unchanged edited message after Pi replaces its transcript entry", async () => {
    let completeEdit!: () => void;
    const editMessage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          completeEdit = resolve;
        }),
    );
    const root = mount(
      createStore(HarnessStore, {
        deliver: async () => true,
        editMessage,
        restoreDraft: () => undefined,
      }),
    );
    root.canonicalParts.push({
      id: "original-user",
      kind: "text",
      role: "user",
      entryId: "original-entry",
      text: "Same text",
      status: "complete",
    });

    const editing = root.delivery.sendEdit("original-entry", "Same text", [], false);
    expect(root.delivery.optimisticUserMessages.pending).toHaveLength(1);

    root.canonicalParts.splice(0);
    expect(root.delivery.optimisticUserMessages.pending).toHaveLength(1);
    root.canonicalParts.push({
      id: "replacement-user",
      kind: "text",
      role: "user",
      entryId: "replacement-entry",
      text: "Same text",
      status: "complete",
    });

    await vi.waitFor(() => expect(root.delivery.optimisticUserMessages.pending).toHaveLength(0));
    expect(root.delivery.parts).toHaveLength(1);
    completeEdit();
    await editing;
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
