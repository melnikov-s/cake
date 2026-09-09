import { createStore, mount, observable } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiPart } from "../../../../src/ipc/session-contract";
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

  it("summarizes every file-changing tool, including added and removed files", () => {
    const parts: UiPart[] = [
      {
        id: "tool-write",
        kind: "tool",
        name: "write",
        input: JSON.stringify({ path: "src/added.ts", content: "one\ntwo\nthree" }),
        filePath: "src/added.ts",
        state: "success",
      },
      {
        id: "tool-remove",
        kind: "tool",
        name: "remove",
        input: JSON.stringify({ path: "src/removed.ts" }),
        filePath: "src/removed.ts",
        diff: "--- a/src/removed.ts\n+++ /dev/null\n@@ -1,4 +0,0 @@\n-one\n-two\n-three\n-four",
        state: "success",
      },
    ];
    const store = createChatStore(() => parts);

    expect(store.workLogPresentation.changeSummary(parts)).toEqual({
      editCount: 2,
      additions: 3,
      deletions: 4,
    });
    store[Symbol.dispose]();
  });

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

  it("starts a timer when a tool starts running and freezes it when the tool finishes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    let parts: UiPart[] = [toolPart("tool-1", "running")];
    const store = createChatStore(() => parts);

    expect(store.workLogPresentation.elapsedMs("tool-1")).toBe(0);

    vi.advanceTimersByTime(1_500);
    // Drive the same sync the parts reaction drives; the closure variable itself is not observable.
    store.workLogPresentation.syncTimers();
    const runningElapsed = store.workLogPresentation.elapsedMs("tool-1");
    expect(runningElapsed).toBeGreaterThan(0);

    vi.advanceTimersByTime(1_000);
    parts = [toolPart("tool-1", "success")];
    store.workLogPresentation.syncTimers();
    const frozen = store.workLogPresentation.elapsedMs("tool-1");
    expect(frozen).toBeGreaterThanOrEqual(runningElapsed!);

    vi.advanceTimersByTime(5_000);
    store.workLogPresentation.syncTimers();
    expect(store.workLogPresentation.elapsedMs("tool-1")).toBe(frozen);
    store[Symbol.dispose]();
  });

  it("reports one elapsed duration across a combined spawn and wait protocol", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    let parts: UiPart[] = [toolPart("spawn", "running")];
    const store = createChatStore(() => parts);

    vi.advanceTimersByTime(1_000);
    parts = [toolPart("spawn", "success"), toolPart("wait", "running")];
    store.workLogPresentation.syncTimers();
    vi.advanceTimersByTime(1_500);
    parts = [toolPart("spawn", "success"), toolPart("wait", "success")];
    store.workLogPresentation.syncTimers();

    expect(store.workLogPresentation.elapsedMsRange("spawn", "wait")).toBe(2_500);
    store[Symbol.dispose]();
  });

  it("prunes removed item overrides while retaining the surviving work-log group", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    let parts: UiPart[] = [toolPart("tool-1", "running"), toolPart("tool-2", "running")];
    const store = createChatStore(() => parts);
    store.workLogPresentation.setItemOpen("tool-1", true);
    store.workLogPresentation.setGroupOpen("activity-0", true);

    parts = [toolPart("tool-2", "success")];
    store.workLogPresentation.syncTimers();

    expect(store.workLogPresentation.elapsedMs("tool-1")).toBeUndefined();
    expect(store.workLogPresentation.timers.has("tool-1")).toBe(false);
    expect(store.workLogPresentation.itemOverrides.has("tool-1")).toBe(false);
    expect(store.workLogPresentation.groupOverrides.get("activity-0")).toBe(true);
    expect(store.workLogPresentation.elapsedMs("tool-2")).toBeGreaterThanOrEqual(0);
    expect(vi.getTimerCount()).toBe(0);

    parts = [];
    store.workLogPresentation.syncTimers();
    expect(store.workLogPresentation.groupOverrides.has("activity-0")).toBe(false);
    store[Symbol.dispose]();
  });

  it("retains a group override when settled reasoning replaces its live part ID", () => {
    let parts: UiPart[] = [
      { id: "live-reasoning", kind: "reasoning", text: "Inspecting", status: "streaming" },
    ];
    const store = createChatStore(() => parts);
    store.workLogPresentation.setGroupOpen("activity-0", true);

    parts = [
      {
        id: "entry-assistant-reasoning-0",
        kind: "reasoning",
        text: "Inspected",
        status: "complete",
      },
    ];
    store.workLogPresentation.syncTimers();

    expect(store.workLogPresentation.groupOpen("activity-0", false)).toBe(true);
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

    expect(store.workLogPresentation.elapsedMs("done")).toBeUndefined();
    store[Symbol.dispose]();
  });
});
