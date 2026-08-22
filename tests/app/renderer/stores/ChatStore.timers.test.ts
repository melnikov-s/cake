import { createStore, mount } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiPart } from "../../../../src/ipc/session-contract";
import { ChatStore } from "../../../../src/renderer/stores/ChatStore";

type ToolState = Extract<UiPart, { kind: "tool" }>["state"];

function createChatStore(parts: () => UiPart[]) {
  return mount(
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
}

function toolPart(id: string, state: ToolState): UiPart {
  return { id, kind: "tool", name: "bash", input: "echo hi", state };
}

describe("ChatStore work log timers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a timer when a tool starts running and freezes it when the tool finishes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    let parts: UiPart[] = [toolPart("tool-1", "running")];
    const store = createChatStore(() => parts);

    expect(store.workLogElapsedMs("tool-1")).toBe(0);

    vi.advanceTimersByTime(1_500);
    // Drive the same sync the parts reaction drives; the closure variable itself is not observable.
    store["syncWorkLogTimers"]();
    const runningElapsed = store.workLogElapsedMs("tool-1");
    expect(runningElapsed).toBeGreaterThan(0);

    vi.advanceTimersByTime(1_000);
    parts = [toolPart("tool-1", "success")];
    store["syncWorkLogTimers"]();
    const frozen = store.workLogElapsedMs("tool-1");
    expect(frozen).toBeGreaterThanOrEqual(runningElapsed!);

    vi.advanceTimersByTime(5_000);
    store["syncWorkLogTimers"]();
    expect(store.workLogElapsedMs("tool-1")).toBe(frozen);
    store[Symbol.dispose]();
  });

  it("never reports elapsed time for tools that were already finished when observed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const store = createChatStore(() => [toolPart("done", "success")]);

    expect(store.workLogElapsedMs("done")).toBeUndefined();
    store[Symbol.dispose]();
  });
});
