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
    const tool = container.querySelector<HTMLDetailsElement>(".tool-call")!;
    expect(log.open).toBe(false);
    expect(tool.open).toBe(false);

    act(() => container.querySelector<HTMLElement>(".activity-group > summary")!.click());
    act(() => container.querySelector<HTMLElement>(".tool-call > summary")!.click());
    expect(log.open).toBe(true);
    expect(tool.open).toBe(true);

    act(() => root.render(<Transcript sessionId="session-1" store={storeWith([{ ...running, state: "success" }], false)} />));
    expect(log.open).toBe(true);
    expect(tool.open).toBe(true);
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

  it("keeps the assistant loading indicator visible until streaming stops", () => {
    const user: UiPart = { id: "user-1", kind: "text", role: "user", text: "My message", status: "complete" };
    const assistant: UiPart = { id: "assistant-1", kind: "text", role: "assistant", text: "Working", status: "streaming" };

    act(() => root.render(<Transcript sessionId="session-1" store={storeWith([user], true)} />));
    expect(container.querySelector(".assistant-loading")).not.toBeNull();

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

    expect(container.querySelectorAll('[aria-label="Message actions"]')).toHaveLength(1);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Copy response"]')!.click());
    expect(writeText).toHaveBeenCalledWith("Answer");
    expect(container.querySelector('[aria-label="Copied response"]')).not.toBeNull();

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Fork from response"]')!.click());
    expect(store.forkAt).toHaveBeenCalledWith("assistant-entry");
  });
});
