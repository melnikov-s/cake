/**
 * @vitest-environment jsdom
 */
import React, { act, forwardRef, useEffect, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiPart } from "../../../src/ipc/session-contract";
import type { WindowStore } from "../../../src/renderer/stores/window-store";

const { scrollToIndex, virtualizedLifecycle, virtualizedProps } = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  virtualizedLifecycle: vi.fn(),
  virtualizedProps: { current: undefined as undefined | Record<string, unknown> }
}));

vi.mock("@/components/ai-elements/conversation", () => ({
  Conversation: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  VirtualizedConversation: forwardRef(function MockVirtualizedConversation(
    props: {
      data: Array<{ id: string }>;
      itemContent: (index: number, item: { id: string }) => React.ReactNode;
    },
    ref
  ) {
    virtualizedProps.current = props as unknown as Record<string, unknown>;
    useImperativeHandle(ref, () => ({ scrollToIndex }));
    useEffect(() => {
      virtualizedLifecycle("mounted");
      return () => virtualizedLifecycle("unmounted");
    }, []);
    return <div>{props.data.map((item, index) => <React.Fragment key={item.id}>{props.itemContent(index, item)}</React.Fragment>)}</div>;
  })
}));

import { Transcript } from "../../../src/renderer/app";

function storeWith(parts: UiPart[], isStreaming = false) {
  return { parts, visibleParts: parts, projectName: "Cake", error: undefined, thinkingExpanded: false, isStreaming, toggleThinking: vi.fn(), forkAt: vi.fn() } as unknown as WindowStore;
}

describe("Transcript scrolling", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, {
      IS_REACT_ACT_ENVIRONMENT: true,
      requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
      cancelAnimationFrame: vi.fn()
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    scrollToIndex.mockClear();
    virtualizedLifecycle.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("starts a loaded session at the final transcript item", () => {
    const parts: UiPart[] = [
      { id: "assistant-1", kind: "text", role: "assistant", text: "First", status: "complete" },
      { id: "assistant-2", kind: "text", role: "assistant", text: "Latest", status: "complete" }
    ];

    act(() => root.render(<Transcript sessionId="session-1" store={storeWith(parts)} />));

    expect(virtualizedProps.current?.initialTopMostItemIndex).toEqual({ index: 1, align: "end" });
    const followOutput = virtualizedProps.current?.followOutput as (isAtBottom: boolean) => "auto" | false;
    expect(followOutput(true)).toBe("auto");
    expect(followOutput(false)).toBe(false);
  });

  it("scrolls to a newly rendered user message even when it was not following output", () => {
    const assistant: UiPart = { id: "assistant-1", kind: "text", role: "assistant", text: "First", status: "complete" };
    const user: UiPart = { id: "user-1", kind: "text", role: "user", text: "My message", status: "complete" };

    act(() => root.render(<Transcript sessionId="session-1" store={storeWith([assistant])} />));
    scrollToIndex.mockClear();
    act(() => root.render(<Transcript sessionId="session-1" store={storeWith([assistant, user])} />));

    expect(scrollToIndex).toHaveBeenCalledWith({ index: 1, align: "end", behavior: "auto" });
  });

  it("keeps the streaming work log scrolled to its latest entry", () => {
    const first: UiPart = { id: "reasoning-1", kind: "reasoning", text: "First thought", status: "streaming" };
    const second: UiPart = { id: "tool-1", kind: "tool", name: "read", input: "file", state: "running" };

    act(() => root.render(<Transcript sessionId="session-1" store={storeWith([first], true)} />));
    const log = container.querySelector<HTMLDivElement>(".activity-group > div")!;
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 480 });

    act(() => root.render(<Transcript sessionId="session-1" store={storeWith([first, second], true)} />));

    expect(log.scrollTop).toBe(480);
  });

  it("leaves work log expansion under user control as streaming changes", () => {
    const running: UiPart = { id: "tool-1", kind: "tool", name: "read", input: "file", state: "running" };

    act(() => root.render(<Transcript sessionId="session-1" store={storeWith([running], true)} />));
    const log = container.querySelector<HTMLDetailsElement>(".activity-group")!;
    const tool = container.querySelector<HTMLElement>(".tool-call")!;
    const toolToggle = tool.querySelector<HTMLButtonElement>(".tool-summary")!;
    expect(log.open).toBe(false);
    expect(toolToggle.getAttribute("aria-expanded")).toBe("false");

    act(() => container.querySelector<HTMLElement>(".activity-group > summary")!.click());
    act(() => toolToggle.click());
    expect(log.open).toBe(true);
    expect(toolToggle.getAttribute("aria-expanded")).toBe("true");
    expect(tool.classList.contains("tool-open")).toBe(true);
    expect(tool.querySelector(".tool-details")).not.toBeNull();

    act(() => root.render(<Transcript sessionId="session-1" store={storeWith([{ ...running, state: "success" }], false)} />));
    expect(log.open).toBe(true);
    expect(toolToggle.getAttribute("aria-expanded")).toBe("true");
    expect(log.querySelector(':scope > summary .tool-success[aria-label="success"]')).not.toBeNull();
  });

  it("shows empty reasoning as a non-expandable status", () => {
    const empty: UiPart = { id: "reasoning-1", kind: "reasoning", text: "", status: "complete" };

    act(() => root.render(<Transcript sessionId="session-1" store={storeWith([empty])} />));

    const status = container.querySelector<HTMLElement>(".activity-group-status")!;
    expect(status.textContent).toContain("Reasoning details not exposed");
    expect(status.querySelector('.tool-success[aria-label="success"]')).not.toBeNull();
    expect(container.querySelector(".activity-group > summary")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  it("shows an empty in-progress reasoning block as thinking", () => {
    const empty: UiPart = { id: "reasoning-1", kind: "reasoning", text: "", status: "streaming" };

    act(() => root.render(<Transcript sessionId="session-1" store={storeWith([empty], true)} />));

    expect(container.querySelector(".activity-group-status")?.textContent).toContain("Thinking…");
    expect(container.querySelector('.activity-group-status .tool-running[aria-label="running"]')).not.toBeNull();
    expect(container.querySelector(".assistant-loading")).toBeNull();
  });

  it("does not show assistant loading dots while the work log is active", () => {
    const user: UiPart = { id: "user-1", kind: "text", role: "user", text: "My message", status: "complete" };
    const reasoning: UiPart = { id: "reasoning-1", kind: "reasoning", text: "Working it out", status: "streaming" };
    const tool: UiPart = { id: "tool-1", kind: "tool", name: "read", input: "file", state: "running" };
    const assistant: UiPart = { id: "assistant-1", kind: "text", role: "assistant", text: "Writing the answer", status: "streaming" };

    act(() => root.render(<Transcript sessionId="session-1" store={storeWith([user, reasoning], true)} />));
    expect(container.querySelector(".assistant-loading")).toBeNull();

    act(() => root.render(<Transcript sessionId="session-1" store={storeWith([user, { ...reasoning, status: "complete" }, tool], true)} />));
    expect(container.querySelector(".assistant-loading")).toBeNull();

    act(() => root.render(<Transcript sessionId="session-1" store={storeWith([user, { ...reasoning, status: "complete" }, { ...tool, state: "success" }], true)} />));
    expect(container.querySelector(".assistant-loading")).toBeNull();

    act(() => root.render(<Transcript sessionId="session-1" store={storeWith([user, { ...reasoning, status: "complete" }, { ...tool, state: "success" }, assistant], true)} />));
    expect(container.querySelector(".assistant-loading")).not.toBeNull();
  });

  it("updates a selected session without remounting the virtualized transcript", () => {
    const first: UiPart = { id: "assistant-1", kind: "text", role: "assistant", text: "First session", status: "complete" };
    const second: UiPart = { id: "assistant-2", kind: "text", role: "assistant", text: "Second session", status: "complete" };

    act(() => root.render(<Transcript sessionId="session-1" store={storeWith([first])} />));
    scrollToIndex.mockClear();
    act(() => root.render(<Transcript sessionId="session-2" store={storeWith([second])} />));

    expect(virtualizedLifecycle.mock.calls).toEqual([["mounted"]]);
    expect(scrollToIndex).toHaveBeenCalledWith({ index: 0, align: "end", behavior: "auto" });
  });

  it("shows assistant loading dots only while assistant text is streaming", () => {
    const user: UiPart = { id: "user-1", kind: "text", role: "user", text: "My message", status: "complete" };
    const assistant: UiPart = { id: "assistant-1", kind: "text", role: "assistant", text: "Working", status: "streaming" };

    act(() => root.render(<Transcript sessionId="session-1" store={storeWith([user], true)} />));
    expect(container.querySelector(".assistant-loading")).toBeNull();

    act(() => root.render(<Transcript sessionId="session-1" store={storeWith([user, assistant], true)} />));
    expect(container.querySelector(".assistant-loading")).not.toBeNull();

    act(() => root.render(<Transcript sessionId="session-1" store={storeWith([{ ...assistant, status: "complete" }], false)} />));
    expect(container.querySelector(".assistant-loading")).toBeNull();
  });

  it("offers copy and fork actions on completed assistant messages only", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const parts: UiPart[] = [
      { id: "user-1", kind: "text", role: "user", entryId: "user-entry", text: "Question", status: "complete" },
      { id: "assistant-1", kind: "text", role: "assistant", entryId: "assistant-entry", text: "Answer", status: "complete" }
    ];
    const store = storeWith(parts);

    act(() => root.render(<Transcript sessionId="session-1" store={store} />));

    const message = container.querySelector<HTMLElement>(".assistant-message")!;
    const content = message.querySelector<HTMLElement>(".assistant-message-content")!;
    const actions = message.querySelector<HTMLElement>('[aria-label="Message actions"]')!;
    expect(actions).not.toBeNull();
    expect(content.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Copy response"]')!.click());
    expect(writeText).toHaveBeenCalledWith("Answer");
    expect(container.querySelector('[aria-label="Copied response"]')).not.toBeNull();

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Fork response into new chat"]')!.click());
    expect(store.forkAt).toHaveBeenCalledWith("assistant-entry");
  });
});
