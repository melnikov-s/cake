import { createStore, mount, observable } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiPart } from "../../../../src/contracts/conversations/session-contract";
import { ChatStore } from "../../../../src/renderer/stores/ChatStore";

type ToolState = Extract<UiPart, { kind: "tool" }>["state"];

function createChatStore(parts: () => UiPart[]) {
  const store = mount(
    createStore(ChatStore, {
      id: () => "chat",
      parts,
      streaming: () => false,
      submitting: () => false,
      configuration: () => undefined,
      commands: () => [],
      placeholder: () => "Message Cake",
      inputLabel: () => "Message",
      canSubmit: () => true,
      submit: () => Promise.resolve(true),
    }),
  );
  void store.workLogPresentation;
  return store;
}

function toolPart(id: string, state: ToolState): UiPart {
  return { id, kind: "tool", name: "bash", input: "echo hi", state };
}

describe("WorkLogPresentationStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Retained performance regression: identical visible UI cannot establish that
  // assistant token updates avoid resynchronizing every tool timer.
  it("does not resynchronize tool timers for assistant text tokens", () => {
    const assistant: Extract<UiPart, { kind: "text" }> = {
      id: "assistant-1",
      kind: "text",
      role: "assistant",
      text: "First",
      status: "streaming",
    };
    const parts: UiPart[] = observable([assistant]);
    const store = createChatStore(() => parts);
    const sync = vi.spyOn(store.workLogPresentation, "syncTimers");

    parts[0] = { ...assistant, text: "Second" };

    expect(sync).not.toHaveBeenCalled();
    store[Symbol.dispose]();
  });

  // Retained resource regression: rendering a vanished tool cannot prove its
  // timer/override entries were released or the idle interval was stopped.
  // Visible group retention/reset is covered by work-log-presentation-workflow.
  it("prunes removed timer and item-override resources and stops the idle clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    let parts: UiPart[] = [toolPart("tool-1", "running"), toolPart("tool-2", "running")];
    const store = createChatStore(() => parts);
    store.workLogPresentation.setItemOpen("tool-1", true);

    parts = [toolPart("tool-2", "success")];
    store.workLogPresentation.syncTimers();

    expect(store.workLogPresentation.elapsedMs("tool-1")).toBeUndefined();
    expect(store.workLogPresentation.timers.has("tool-1")).toBe(false);
    expect(store.workLogPresentation.itemOverrides.has("tool-1")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    store[Symbol.dispose]();
  });

  // Retained lifecycle regression: no user-facing control exposes per-instance
  // interval ownership or disposal; a frozen label alone does not prove cleanup.
  it("owns one timer per Chat instance and clears each timer on disposal", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const first = createChatStore(() => [toolPart("first", "running")]);
    const second = createChatStore(() => [toolPart("second", "running")]);

    expect(vi.getTimerCount()).toBe(2);
    first[Symbol.dispose]();
    expect(vi.getTimerCount()).toBe(1);
    second[Symbol.dispose]();
    expect(vi.getTimerCount()).toBe(0);
  });
});
