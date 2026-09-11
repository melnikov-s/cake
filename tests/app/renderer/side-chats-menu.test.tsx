/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SideChatsMenu } from "../../../src/renderer/components/side-chats-menu";
import { ReviewThread } from "../../../src/renderer/models/ReviewThread";
import type { ProjectSessionStore } from "../../../src/renderer/stores/ProjectSessionStore";

let root: Root | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

describe("SideChatsMenu", () => {
  it("stays hidden when there are no open chats", () => {
    const store = { sideChatThreads: [] } as unknown as ProjectSessionStore;
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    act(() => root!.render(<SideChatsMenu store={store} onOpen={vi.fn()} />));

    expect(container.childElementCount).toBe(0);
  });

  it("lists open chats and opens the selected thread", () => {
    const thread = ReviewThread.create({
      id: "thread-1",
      workingDirectory: "/project",
      parentSessionId: "session-1",
      anchor: {
        path: "session:session-1/message/assistant-1",
        view: "message",
        start: { diffLine: 0 },
        end: { diffLine: 0 },
        selectedText: "The important selection",
        contextBefore: "",
        contextAfter: "",
        diff: "",
      },
      status: "open",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const openSideChat = vi.fn(() => true);
    const store = { sideChatThreads: [thread], openSideChat } as unknown as ProjectSessionStore;
    const onOpen = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    act(() => root!.render(<SideChatsMenu store={store} onOpen={onOpen} />));
    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="Side chats, 1 open"]',
    )!;
    act(() => trigger.click());

    const popover = document.body.querySelector<HTMLElement>('[aria-label="Open side chats"]')!;
    expect(popover.textContent).toContain("The important selection");
    const threadButton = Array.from(popover.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("The important selection"),
    )!;
    act(() => threadButton.click());

    expect(onOpen).toHaveBeenCalled();
    expect(openSideChat).toHaveBeenCalledWith("thread-1");
    expect(document.body.querySelector('[aria-label="Open side chats"]')).toBeNull();
    act(() => thread[Symbol.dispose]());
  });
});
