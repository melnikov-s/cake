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

function storeWith(parts: UiPart[]) {
  return { parts, projectName: "Cake", error: undefined, thinkingExpanded: false, isStreaming: false, toggleThinking: vi.fn() } as unknown as WindowStore;
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

  it("updates a selected session without remounting the virtualized transcript", () => {
    const first: UiPart = { id: "assistant-1", kind: "text", role: "assistant", text: "First session", status: "complete" };
    const second: UiPart = { id: "assistant-2", kind: "text", role: "assistant", text: "Second session", status: "complete" };

    act(() => root.render(<Transcript sessionId="session-1" store={storeWith([first])} />));
    scrollToIndex.mockClear();
    act(() => root.render(<Transcript sessionId="session-2" store={storeWith([second])} />));

    expect(virtualizedLifecycle.mock.calls).toEqual([["mounted"]]);
    expect(scrollToIndex).toHaveBeenCalledWith({ index: 0, align: "end", behavior: "auto" });
  });
});
