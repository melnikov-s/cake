import { child, createStore, mount, Store } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { QueuedPrompt } from "../../../../src/renderer/stores/PromptQueueStore";
import { PromptQueueStore } from "../../../../src/renderer/stores/PromptQueueStore";

class HarnessStore extends Store<{
  deliver(entry: QueuedPrompt, delivery: "prompt" | "steer"): Promise<boolean>;
  restore(entry: QueuedPrompt): void;
}> {
  streaming = true;

  @child get queue() {
    return createStore(PromptQueueStore, {
      isStreaming: () => this.streaming,
      deliver: this.props.deliver,
      restoreForEditing: this.props.restore,
    });
  }
}

describe("PromptQueueStore", () => {
  it("owns edit and remove behavior", () => {
    const restore = vi.fn();
    const root = mount(createStore(HarnessStore, { deliver: async () => true, restore }));
    root.queue.enqueue("First", [], false);
    root.queue.enqueue("Second", [], true);

    expect(root.queue.edit(root.queue.prompts[1]!.id)).toBe(true);
    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ text: "Second" }));
    root.queue.remove(root.queue.prompts[0]!.id);
    expect(root.queue.prompts).toEqual([]);
    root[Symbol.dispose]();
  });

  it("drains in order when streaming settles and restores a failed head", async () => {
    const deliver = vi.fn<(entry: QueuedPrompt) => Promise<boolean>>();
    deliver.mockResolvedValueOnce(false).mockResolvedValue(true);
    const root = mount(createStore(HarnessStore, { deliver, restore: () => undefined }));
    root.queue.enqueue("First", [], false);
    root.queue.enqueue("Second", [], false);

    root.streaming = false;
    await vi.waitFor(() => {
      expect(deliver).toHaveBeenCalledOnce();
      expect(root.queue.prompts.map((entry) => entry.text)).toEqual(["First", "Second"]);
    });
    await Promise.resolve();

    root.streaming = true;
    root.streaming = false;
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(root.queue.prompts.map((entry) => entry.text)).toEqual(["Second"]);
    await Promise.resolve();

    root.streaming = true;
    root.streaming = false;
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(3));
    expect(deliver.mock.calls.map(([entry]) => entry.text)).toEqual(["First", "First", "Second"]);
    expect(root.queue.prompts).toEqual([]);
    root[Symbol.dispose]();
  });
});
