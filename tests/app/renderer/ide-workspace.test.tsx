/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStore, mount } from "r-state-tree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ai-elements/conversation", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@/components/ai-elements/conversation",
  );
  const ReactModule = await import("react");
  return {
    ...actual,
    VirtualizedConversation: ReactModule.forwardRef(function TestVirtualizedConversation(
      {
        data,
        itemContent,
      }: {
        data: Array<{ id: string }>;
        itemContent(index: number, item: { id: string }): React.ReactNode;
      },
      ref,
    ) {
      ReactModule.useImperativeHandle(ref, () => ({ scrollToIndex: vi.fn() }));
      return (
        <div className="transcript">
          {data.map((item, index) => (
            <React.Fragment key={item.id}>{itemContent(index, item)}</React.Fragment>
          ))}
        </div>
      );
    }),
  };
});

import { IdeWorkspace } from "../../../src/renderer/components/ide-workspace";
import { SideChatsMenu } from "../../../src/renderer/components/side-chats-menu";
import { ReviewThread } from "../../../src/renderer/models/ReviewThread";
import type { ChatConfigurationStore } from "../../../src/renderer/stores/ChatConfigurationStore";
import { ChatStore } from "../../../src/renderer/stores/ChatStore";
import type { EmbeddedEditorStore } from "../../../src/renderer/stores/EmbeddedEditorStore";
import type { MessageCommentsStore } from "../../../src/renderer/stores/MessageCommentsStore";
import type { ProjectSessionStore } from "../../../src/renderer/stores/ProjectSessionStore";
import type { ReviewsStore } from "../../../src/renderer/stores/ReviewsStore";
import { SideChatStore } from "../../../src/renderer/stores/SideChatStore";

const configuration = {
  session: {
    model: { provider: "openai", id: '["openai","gpt"]', modelId: "gpt", name: "GPT" },
    thinkingLevel: "medium",
    availableThinkingLevels: ["off", "medium"],
  },
  connectedModelsByProvider: [
    {
      id: "openai",
      name: "OpenAI",
      models: [{ provider: "openai", id: "gpt", name: "GPT", authenticated: true }],
    },
  ],
  activeOperations: [],
  presets: [],
  selectModel: vi.fn(),
  selectThinkingLevel: vi.fn(),
} as unknown as ChatConfigurationStore;

function chatStoreWith(id: string, text: string, inputLabel: string) {
  return mount(
    createStore(ChatStore, {
      id: () => id,
      parts: () => [
        {
          id: `${id}-message`,
          kind: "text" as const,
          role: "assistant" as const,
          text,
          status: "complete" as const,
        },
      ],
      streaming: () => false,
      submitting: () => false,
      configuration: () => configuration,
      commands: () => [],
      placeholder: () => "Ask…",
      inputLabel: () => inputLabel,
      canSubmit: (draft) => Boolean(draft.trim()),
      submit: async () => true,
    }),
  );
}

const sideChatThread = ReviewThread.create({
  id: "thread-1",
  workingDirectory: "/project",
  parentSessionId: "session-1",
  anchor: {
    path: "session:session-1/message/project-message",
    view: "message",
    start: { diffLine: 0 },
    end: { diffLine: 0 },
    selectedText: "important",
    contextBefore: "",
    contextAfter: "",
    diff: "",
  },
  status: "open",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("IdeWorkspace", () => {
  let container: HTMLDivElement;
  let root: Root;
  let projectChat: ChatStore;
  let threadChat: ChatStore;
  let sideChat: SideChatStore;

  const editor = {
    chatSidebarVisible: true,
    chatSidebarWidth: 420,
    setChatSidebarWidth: vi.fn(),
    status: "ready",
    error: undefined,
    nativeViewReady: false,
    reportBounds: vi.fn(async () => undefined),
  } as unknown as EmbeddedEditorStore;
  const reviews = {
    draftAnchor: undefined,
    activeThreadId: undefined,
    threads: [],
    cancelDraft: vi.fn(),
    clearActiveThread: vi.fn(),
    chatStore: vi.fn(),
    draftChatStore: undefined,
  } as unknown as ReviewsStore;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    document.execCommand = vi.fn(() => false);
    // Selection markers measure the anchored text range; jsdom has no layout.
    const rangeRect = {
      top: 80,
      right: 220,
      bottom: 100,
      left: 120,
      width: 100,
      height: 20,
      x: 120,
      y: 80,
      toJSON: () => ({}),
    } as DOMRect;
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => rangeRect,
    });
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [rangeRect],
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    projectChat = chatStoreWith("project", "Alpha important detail.", "Message the project");
    threadChat = chatStoreWith("thread-1", "Because it carries the point.", "Reply to side chat");
    sideChat = mount(createStore(SideChatStore, {}));
  });

  afterEach(() => {
    act(() => root.unmount());
    sideChat[Symbol.dispose]();
    threadChat[Symbol.dispose]();
    projectChat[Symbol.dispose]();
    container.remove();
  });

  function renderWorkspace(headerActions?: React.ReactNode) {
    const comments = {
      threadsForMessage: () => [
        {
          id: sideChatThread.id,
          anchor: { selectedText: "important", startOffset: 6, endOffset: 15 },
          messages: [],
          status: "open",
          updatedAt: sideChatThread.updatedAt,
        },
      ],
      threadStreaming: () => false,
      chatStore: () => threadChat,
      replyThread: vi.fn(),
      resolveThread: vi.fn(),
    } as unknown as MessageCommentsStore;
    act(() =>
      root.render(
        <IdeWorkspace
          editor={editor}
          reviews={reviews}
          projectChat={projectChat}
          sideChat={sideChat}
          headerActions={headerActions}
          projectSidebar={<nav />}
          projectSidebarVisible={false}
          projectSidebarWidth={260}
          onProjectSidebarWidthChange={vi.fn()}
          sessionTitle="Ship the feature"
          transcriptBehavior={{ messageComments: comments }}
        />,
      ),
    );
  }

  const sidePanel = () =>
    container.querySelector<HTMLElement>('[data-slot="side-panel"][aria-label="Side chat"]');

  it("opens a side chat from a transcript marker inside the VS Code chat sidebar", () => {
    renderWorkspace();

    expect(container.textContent).toContain("Ship the feature");
    expect(container.querySelector('[data-slot="side-chat-layout"]')).not.toBeNull();
    expect(sidePanel()).toBeNull();

    const marker = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open selection chat 1"]',
    );
    expect(marker).not.toBeNull();
    act(() => marker!.click());

    expect(sideChat.target?.key).toBe("selection-thread:thread-1");
    const panel = sidePanel();
    expect(panel?.textContent).toContain("Because it carries the point.");
    expect(panel?.querySelector('[aria-label="Reply to side chat"]')).not.toBeNull();

    act(() => panel!.querySelector<HTMLButtonElement>('[aria-label="Close Side chat"]')!.click());
    expect(sideChat.target).toBeUndefined();
    expect(sidePanel()).toBeNull();
    expect(container.querySelector('[aria-label="Message the project"]')).not.toBeNull();
  });

  it("shows the session side chats menu in the chat sidebar header and opens the chosen chat", () => {
    const projectSession = {
      sideChatThreads: [sideChatThread],
      openSideChat: vi.fn((threadId: string) => {
        sideChat.open({
          key: `discussion:${threadId}`,
          title: "Side chat",
          eyebrow: () => "Selection",
          chatStore: threadChat,
        });
        return true;
      }),
    } as unknown as ProjectSessionStore;
    renderWorkspace(<SideChatsMenu store={projectSession} />);

    const header = container.querySelector<HTMLElement>("aside header")!;
    const trigger = header.querySelector<HTMLButtonElement>('[aria-label="Side chats, 1 open"]');
    expect(trigger).not.toBeNull();
    act(() => trigger!.click());

    const menu = document.body.querySelector<HTMLElement>('[aria-label="Open side chats"]')!;
    const threadButton = Array.from(menu.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("important"),
    )!;
    act(() => threadButton.click());

    expect(projectSession.openSideChat).toHaveBeenCalledWith("thread-1");
    expect(sidePanel()?.textContent).toContain("Because it carries the point.");
    expect(document.body.querySelector('[aria-label="Open side chats"]')).toBeNull();
  });
});
