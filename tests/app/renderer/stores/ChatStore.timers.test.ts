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

  it("reports one elapsed duration across a combined spawn and wait protocol", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    let parts: UiPart[] = [toolPart("spawn", "running")];
    const store = createChatStore(() => parts);

    vi.advanceTimersByTime(1_000);
    parts = [toolPart("spawn", "success"), toolPart("wait", "running")];
    store["syncWorkLogTimers"]();
    vi.advanceTimersByTime(1_500);
    parts = [toolPart("spawn", "success"), toolPart("wait", "success")];
    store["syncWorkLogTimers"]();

    expect(store.workLogElapsedMsRange("spawn", "wait")).toBe(2_500);
    store[Symbol.dispose]();
  });

  it("prunes removed item overrides while retaining the surviving work-log group", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    let parts: UiPart[] = [toolPart("tool-1", "running"), toolPart("tool-2", "running")];
    const store = createChatStore(() => parts);
    store.setWorkLogItemOpen("tool-1", true);
    store.setWorkLogGroupOpen("activity-0", true);

    parts = [toolPart("tool-2", "success")];
    store["syncWorkLogTimers"]();

    expect(store.workLogElapsedMs("tool-1")).toBeUndefined();
    expect(store.workLogTimers.has("tool-1")).toBe(false);
    expect(store.workLogItemOverrides.has("tool-1")).toBe(false);
    expect(store.workLogGroupOverrides.get("activity-0")).toBe(true);
    expect(store.workLogElapsedMs("tool-2")).toBeGreaterThanOrEqual(0);
    expect(vi.getTimerCount()).toBe(0);

    parts = [];
    store["syncWorkLogTimers"]();
    expect(store.workLogGroupOverrides.has("activity-0")).toBe(false);
    store[Symbol.dispose]();
  });

  it("retains a group override when settled reasoning replaces its live part ID", () => {
    let parts: UiPart[] = [
      { id: "live-reasoning", kind: "reasoning", text: "Inspecting", status: "streaming" },
    ];
    const store = createChatStore(() => parts);
    store.setWorkLogGroupOpen("activity-0", true);

    parts = [
      {
        id: "entry-assistant-reasoning-0",
        kind: "reasoning",
        text: "Inspected",
        status: "complete",
      },
    ];
    store["syncWorkLogTimers"]();

    expect(store.workLogGroupOpen("activity-0", false)).toBe(true);
    store[Symbol.dispose]();
  });

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

  it("never reports elapsed time for tools that were already finished when observed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const store = createChatStore(() => [toolPart("done", "success")]);

    expect(store.workLogElapsedMs("done")).toBeUndefined();
    store[Symbol.dispose]();
  });
});
