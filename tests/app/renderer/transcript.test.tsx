/**
 * @vitest-environment jsdom
 */
import React, { act, forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, mount, observable } from "r-state-tree";
import type { UiPart } from "../../../src/ipc/session-contract";

const { scrollToIndex, virtualizedLifecycle, virtualizedProps } = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  virtualizedLifecycle: vi.fn(),
  virtualizedProps: { current: undefined as undefined | Record<string, unknown> },
}));

vi.mock("@/components/ai-elements/conversation", () => ({
  Conversation: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  VirtualizedConversation: forwardRef(function MockVirtualizedConversation(
    props: {
      className?: string;
      data: Array<{ id: string }>;
      itemContent: (index: number, item: { id: string }) => React.ReactNode;
    },
    ref,
  ) {
    virtualizedProps.current = props as unknown as Record<string, unknown>;
    useImperativeHandle(ref, () => ({ scrollToIndex }));
    useEffect(() => {
      virtualizedLifecycle("mounted");
      return () => virtualizedLifecycle("unmounted");
    }, []);
    return (
      <div className={props.className}>
        {props.data.map((item, index) => (
          <React.Fragment key={item.id}>{props.itemContent(index, item)}</React.Fragment>
        ))}
      </div>
    );
  }),
}));

import { Chat } from "../../../src/renderer/components/chat";
import {
  captureMessageSelection,
  chatWorkIsActive,
  ChatTranscript,
  MESSAGE_COMMENT_SELECTION_SETTLE_MS,
  type ChatTranscriptBehavior,
} from "../../../src/renderer/components/chat-transcript";
import { MessageCommentsStore } from "../../../src/renderer/stores/MessageCommentsStore";
import type { ChatConfigurationStore } from "../../../src/renderer/stores/ChatConfigurationStore";
import { ChatStore } from "../../../src/renderer/stores/ChatStore";

interface TranscriptHarness {
  visibleParts: UiPart[];
  isStreaming: boolean;
  error?: string;
  errorDetails?: string;
  forkAt(entryId: string): void | Promise<void>;
}

function storeWith(
  parts: UiPart[],
  isStreaming = false,
  error?: string,
  errorDetails?: string,
): TranscriptHarness {
  return { visibleParts: parts, error, errorDetails, isStreaming, forkAt: vi.fn() };
}

function Transcript({
  parts,
  sessionId,
  isStreaming,
  isSubmitting = false,
  hideThinking = false,
  behavior,
  empty,
  footer,
  error,
  errorDetails,
  errorTitle,
}: {
  parts: UiPart[];
  sessionId: string;
  isStreaming: boolean;
  isSubmitting?: boolean;
  hideThinking?: boolean;
  behavior: ChatTranscriptBehavior & {
    workLogDiff?: boolean;
    onToggleWorkLogDiff?(): void;
  };
  empty?: React.ReactNode;
  footer?: React.ReactNode;
  error?: string;
  errorDetails?: string;
  errorTitle?: string;
}) {
  const {
    workLogDiff = false,
    onToggleWorkLogDiff = () => undefined,
    ...transcriptBehavior
  } = behavior;
  // Expansion state must survive prop-only re-renders, like a real ChatStore.
  const workLogStateRef = useRef<
    { expansion: { value: string }; items: Map<string, boolean> } | undefined
  >(undefined);
  if (!workLogStateRef.current)
    workLogStateRef.current = {
      expansion: observable({ value: "collapsed" }),
      items: observable(new Map()),
    };
  const workLogState = workLogStateRef.current;
  const store = {
    id: sessionId,
    parts,
    streaming: isStreaming,
    submitting: isSubmitting,
    hideThinking,
    workLogDiff,
    toggleWorkLogDiff: onToggleWorkLogDiff,
    workLogElapsedMs: () => undefined,
    get workLogsExpansion() {
      return workLogState.expansion.value;
    },
    get workLogItemOverrides() {
      return workLogState.items;
    },
    setWorkLogsExpansion(expansion: string) {
      workLogState.expansion.value = expansion;
      workLogState.items.clear();
    },
    cycleWorkLogsExpansion() {
      workLogState.expansion.value =
        workLogState.expansion.value === "collapsed"
          ? "expanded"
          : workLogState.expansion.value === "expanded"
            ? "fully-expanded"
            : "collapsed";
      workLogState.items.clear();
    },
    workLogItemOpen(partId: string) {
      return workLogState.items.get(partId) ?? workLogState.expansion.value === "fully-expanded";
    },
    setWorkLogItemOpen(partId: string, open: boolean) {
      workLogState.items.set(partId, open);
    },
    error: undefined,
  } as unknown as ChatStore;
  return (
    <ChatTranscript
      store={store}
      behavior={transcriptBehavior}
      empty={empty}
      footer={footer}
      error={error ? { message: error, details: errorDetails, title: errorTitle } : undefined}
      renderChat={(nestedStore) => <Chat store={nestedStore} embedded compact />}
    />
  );
}

/** Retries an assertion across async flushes; signals-driven commits may land on a later task. */
async function waitFor(assertion: () => void, attempts = 20): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw lastError;
}

function TestTranscript({ store, sessionId }: { store: TranscriptHarness; sessionId: string }) {
  return (
    <Transcript
      parts={store.visibleParts}
      sessionId={sessionId}
      isStreaming={store.isStreaming}
      behavior={{
        onFork: (entryId) => {
          void store.forkAt(entryId);
        },
      }}
      empty={<div />}
      error={store.error}
      errorDetails={store.errorDetails}
    />
  );
}

describe("Transcript scrolling", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, {
      IS_REACT_ACT_ENVIRONMENT: true,
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
      cancelAnimationFrame: vi.fn(),
    });
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
      { id: "assistant-2", kind: "text", role: "assistant", text: "Latest", status: "complete" },
    ];

    act(() => root.render(<TestTranscript sessionId="session-1" store={storeWith(parts)} />));

    expect(virtualizedProps.current?.initialTopMostItemIndex).toEqual({ index: 1, align: "end" });
    const followOutput = virtualizedProps.current?.followOutput as (
      isAtBottom: boolean,
    ) => "auto" | false;
    expect(followOutput(true)).toBe("auto");
    expect(followOutput(false)).toBe(false);
  });

  it("renders a review notification at its persisted transcript position", () => {
    const parts: UiPart[] = [
      { id: "user-1", kind: "text", role: "user", text: "Please fix this", status: "complete" },
      {
        id: "review-run-1",
        kind: "review-run",
        operationId: "00000000-0000-4000-8000-000000000001",
        threadIds: ["review-1"],
        commentCount: 1,
        status: "complete",
      },
      { id: "assistant-1", kind: "text", role: "assistant", text: "Done", status: "complete" },
    ];

    act(() => root.render(<TestTranscript sessionId="session-1" store={storeWith(parts)} />));

    const transcriptItems = Array.from(container.querySelectorAll(".transcript-item"));
    expect(transcriptItems.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Please fix this"),
      expect.stringContaining("1 comment replied"),
      expect.stringContaining("Done"),
    ]);
  });

  it("adds separation when an error notice immediately follows a user message", () => {
    const parts: UiPart[] = [
      { id: "user-1", kind: "text", role: "user", text: "Hello?", status: "complete" },
      {
        id: "error-1",
        kind: "notice",
        tone: "error",
        title: "Model request failed",
        detail: "No credits remain.",
      },
    ];

    act(() => root.render(<TestTranscript sessionId="session-1" store={storeWith(parts)} />));

    const transcriptItems = Array.from(container.querySelectorAll(".transcript-item"));
    expect(transcriptItems[0]?.classList.contains("transcript-item-error-after-user")).toBe(false);
    expect(transcriptItems[1]?.classList.contains("transcript-item-error-after-user")).toBe(true);
  });

  it("copies preserved stack details from an operation error", async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const details = "Error: Identity collision\n    at Session.applySnapshot (session.ts:50:7)";

    await act(async () =>
      root.render(
        <TestTranscript
          sessionId="session-1"
          store={storeWith([], false, "Identity collision", details)}
        />,
      ),
    );
    const copy = container.querySelector<HTMLButtonElement>(".copy-error-details");
    await act(async () => copy?.click());

    expect(writeText).toHaveBeenCalledWith(details);
    expect(copy?.textContent).toBe("Copied full error details");
  });

  it("scrolls to a newly rendered user message even when it was not following output", () => {
    const assistant: UiPart = {
      id: "assistant-1",
      kind: "text",
      role: "assistant",
      text: "First",
      status: "complete",
    };
    const user: UiPart = {
      id: "user-1",
      kind: "text",
      role: "user",
      text: "My message",
      status: "complete",
    };

    act(() => root.render(<TestTranscript sessionId="session-1" store={storeWith([assistant])} />));
    scrollToIndex.mockClear();
    act(() =>
      root.render(<TestTranscript sessionId="session-1" store={storeWith([assistant, user])} />),
    );

    expect(scrollToIndex).toHaveBeenCalledWith({ index: 1, align: "end", behavior: "auto" });
  });

  it("shows loading in the user message until the first model response arrives", () => {
    const user: UiPart = {
      id: "user-1",
      kind: "text",
      role: "user",
      text: "My message",
      status: "complete",
    };
    const reasoning: UiPart = {
      id: "reasoning-1",
      kind: "reasoning",
      text: "Working it out",
      status: "streaming",
    };

    act(() =>
      root.render(
        <Transcript
          parts={[user]}
          sessionId="session-1"
          isStreaming={false}
          isSubmitting
          behavior={{}}
          empty={<div />}
        />,
      ),
    );
    expect(
      container.querySelector('[role="status"][aria-label="Churning in progress"]'),
    ).not.toBeNull();

    act(() =>
      root.render(
        <TestTranscript sessionId="session-1" store={storeWith([user, reasoning], true)} />,
      ),
    );
    expect(container.querySelector(".loading-state")).not.toBeNull();
    expect(container.querySelector(".activity-group")).not.toBeNull();
  });

  it("does not show assistant loading while the turn is waiting for user input", () => {
    const user: UiPart = {
      id: "user-1",
      kind: "text",
      role: "user",
      text: "Quiz me",
      status: "complete",
    };

    expect(chatWorkIsActive([user], true, true, true)).toBe(false);
    act(() =>
      root.render(
        <Transcript
          parts={[user]}
          sessionId="session-1"
          isStreaming
          behavior={{
            waitingForUser: true,
          }}
          empty={<div />}
        />,
      ),
    );

    expect(container.querySelector(".loading-state")).toBeNull();
  });

  it("keeps the streaming work log scrolled to its latest entry", () => {
    const first: UiPart = {
      id: "reasoning-1",
      kind: "reasoning",
      text: "First thought",
      status: "streaming",
    };
    const second: UiPart = {
      id: "tool-1",
      kind: "tool",
      name: "read",
      input: "file",
      state: "running",
    };

    act(() =>
      root.render(<TestTranscript sessionId="session-1" store={storeWith([first], true)} />),
    );
    act(() => container.querySelector<HTMLElement>(".activity-group > summary")!.click());
    const log = container.querySelector<HTMLDivElement>(".activity-group > div")!;
    Object.defineProperties(log, {
      clientHeight: { configurable: true, value: 120 },
      scrollHeight: { configurable: true, value: 480 },
    });
    log.scrollTop = 360;
    act(() => log.dispatchEvent(new Event("scroll", { bubbles: true })));
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 600 });

    act(() =>
      root.render(
        <TestTranscript sessionId="session-1" store={storeWith([first, second], true)} />,
      ),
    );

    expect(log.scrollTop).toBe(600);
  });

  it("does not move a streaming work log after the user scrolls away from the bottom", () => {
    const first: UiPart = {
      id: "reasoning-1",
      kind: "reasoning",
      text: "First thought",
      status: "streaming",
    };
    const second: UiPart = {
      id: "tool-1",
      kind: "tool",
      name: "read",
      input: "file",
      state: "running",
    };

    act(() =>
      root.render(<TestTranscript sessionId="session-1" store={storeWith([first], true)} />),
    );
    act(() => container.querySelector<HTMLElement>(".activity-group > summary")!.click());
    const log = container.querySelector<HTMLDivElement>(".activity-group > div")!;
    Object.defineProperties(log, {
      clientHeight: { configurable: true, value: 120 },
      scrollHeight: { configurable: true, value: 480 },
    });
    log.scrollTop = 100;
    act(() => log.dispatchEvent(new Event("scroll", { bubbles: true })));

    act(() =>
      root.render(
        <TestTranscript sessionId="session-1" store={storeWith([first, second], true)} />,
      ),
    );

    expect(log.scrollTop).toBe(100);
  });

  it("leaves work log expansion under user control as streaming changes", async () => {
    const running: UiPart = {
      id: "tool-1",
      kind: "tool",
      name: "read",
      input: "file",
      state: "running",
    };
    const render = (parts: UiPart[], isStreaming = false) =>
      root.render(<TestTranscript sessionId="session-1" store={storeWith(parts, isStreaming)} />);

    act(() => render([running], true));
    const log = container.querySelector<HTMLDetailsElement>(".activity-group")!;
    expect(log.open).toBe(false);
    expect(container.querySelector(".tool-call")).toBeNull();

    act(() => container.querySelector<HTMLElement>(".activity-group > summary")!.click());
    const tool = container.querySelector<HTMLElement>(".tool-call")!;
    const toolToggle = tool.querySelector<HTMLButtonElement>(".tool-summary")!;
    expect(toolToggle.getAttribute("aria-expanded")).toBe("false");
    toolToggle.click();
    // Signal-driven commits can be dropped in reused vitest workers, so re-render
    // explicitly and retry until the DOM reflects the store's item override.
    await waitFor(() => {
      act(() => render([running], true));
      expect(toolToggle.getAttribute("aria-expanded")).toBe("true");
      expect(tool.classList.contains("tool-open")).toBe(true);
    });
    expect(log.open).toBe(true);
    expect(tool.querySelector(".tool-details")).not.toBeNull();

    act(() => render([{ ...running, state: "success" }]));
    expect(log.open).toBe(true);
    expect(toolToggle.getAttribute("aria-expanded")).toBe("true");
    expect(
      log.querySelector(':scope > summary .work-log-state[aria-label="complete"]'),
    ).not.toBeNull();
  });

  it("switches an expanded work log between its activity and streaming diff views", () => {
    const running: UiPart = {
      id: "tool-edit",
      kind: "tool",
      name: "edit",
      input: JSON.stringify({
        path: "src/app.ts",
        edits: [{ oldText: "old", newText: "fresh" }],
      }),
      filePath: "src/app.ts",
      state: "running",
    };
    const onToggleWorkLogDiff = vi.fn();
    const render = (workLogDiff: boolean, part: UiPart = running) =>
      root.render(
        <Transcript
          parts={[part]}
          sessionId="session-1"
          isStreaming
          behavior={{
            workLogDiff,
            onToggleWorkLogDiff,
          }}
          empty={<div />}
        />,
      );

    act(() => render(false));
    act(() => container.querySelector<HTMLElement>(".activity-group > summary")!.click());
    const viewToggle = container.querySelector<HTMLElement>(".work-log-view-toggle")!;
    const diffToggle = viewToggle.querySelector<HTMLButtonElement>('[aria-label="Show diff"]')!;
    const logToggle = viewToggle.querySelector<HTMLButtonElement>('[aria-label="Show work log"]')!;
    expect(diffToggle.getAttribute("aria-pressed")).toBe("false");
    expect(logToggle.getAttribute("aria-pressed")).toBe("true");
    act(() => diffToggle.click());
    expect(onToggleWorkLogDiff).toHaveBeenCalledOnce();
    expect(container.querySelector(".activity-group")?.matches("[open]")).toBe(true);

    act(() => render(true));
    expect(container.querySelector(".work-log-diff")).not.toBeNull();
    expect(container.querySelector(".tool-call")).toBeNull();
    expect(container.querySelector(".work-log-diff")?.textContent).toContain("fresh");
    expect(
      container
        .querySelector<HTMLButtonElement>('[aria-label="Show diff"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      container
        .querySelector<HTMLButtonElement>('[aria-label="Show work log"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");

    act(() => render(true, { ...running, diff: "-4 old\n+4 updated" }));
    expect(container.querySelector(".work-log-diff")?.textContent).toContain("updated");

    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Show work log"]')!.click());
    expect(onToggleWorkLogDiff).toHaveBeenCalledTimes(2);
    act(() => render(false));
    expect(container.querySelector(".tool-call")).not.toBeNull();
  });

  it("shows empty reasoning as a non-expandable status", () => {
    const empty: UiPart = { id: "reasoning-1", kind: "reasoning", text: "", status: "complete" };

    act(() => root.render(<TestTranscript sessionId="session-1" store={storeWith([empty])} />));

    const status = container.querySelector<HTMLElement>(".activity-group-status")!;
    expect(status.textContent).toContain("Reasoning details not exposed");
    expect(status.querySelector('.work-log-state[aria-label="complete"]')).not.toBeNull();
    expect(container.querySelector(".activity-group > summary")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  it("shows an empty in-progress reasoning block as thinking", () => {
    const empty: UiPart = { id: "reasoning-1", kind: "reasoning", text: "", status: "streaming" };

    act(() =>
      root.render(<TestTranscript sessionId="session-1" store={storeWith([empty], true)} />),
    );

    expect(container.querySelector(".activity-group-status")?.textContent).toContain("Thinking…");
    expect(
      container.querySelector('.activity-group-status .work-log-running[aria-label="working"]'),
    ).not.toBeNull();
    expect(container.querySelector(".loading-state")).not.toBeNull();
  });

  it("keeps the completed work log neutral when an individual call failed", () => {
    const failed: UiPart = {
      id: "tool-1",
      kind: "tool",
      name: "bash",
      input: "exit 1",
      state: "error",
    };

    act(() => root.render(<TestTranscript sessionId="session-1" store={storeWith([failed])} />));

    const log = container.querySelector<HTMLElement>(".activity-group")!;
    expect(
      log.querySelector(':scope > summary .work-log-state[aria-label="complete"]'),
    ).not.toBeNull();
    expect(log.querySelector(":scope > summary .tool-error")).toBeNull();
    expect(log.querySelector(".tool-call")).toBeNull();
    act(() => container.querySelector<HTMLElement>(".activity-group > summary")!.click());
    expect(log.querySelector('.tool-call .tool-error[aria-label="error"]')).not.toBeNull();
  });

  it("keeps the elapsed loading state visible throughout reasoning, tools, and assistant output", () => {
    const user: UiPart = {
      id: "user-1",
      kind: "text",
      role: "user",
      text: "My message",
      status: "complete",
    };
    const reasoning: UiPart = {
      id: "reasoning-1",
      kind: "reasoning",
      text: "Working it out",
      status: "streaming",
    };
    const tool: UiPart = {
      id: "tool-1",
      kind: "tool",
      name: "read",
      input: "file",
      state: "running",
    };
    const assistant: UiPart = {
      id: "assistant-1",
      kind: "text",
      role: "assistant",
      text: "Writing the answer",
      status: "streaming",
    };

    act(() =>
      root.render(
        <TestTranscript sessionId="session-1" store={storeWith([user, reasoning], true)} />,
      ),
    );
    const loadingState = container.querySelector(".loading-state");
    expect(loadingState).not.toBeNull();

    act(() =>
      root.render(
        <TestTranscript
          sessionId="session-1"
          store={storeWith([user, { ...reasoning, status: "complete" }, tool], true)}
        />,
      ),
    );
    expect(container.querySelector(".loading-state")).toBe(loadingState);

    act(() =>
      root.render(
        <TestTranscript
          sessionId="session-1"
          store={storeWith(
            [user, { ...reasoning, status: "complete" }, { ...tool, state: "success" }],
            true,
          )}
        />,
      ),
    );
    expect(container.querySelector(".loading-state")).toBe(loadingState);

    act(() =>
      root.render(
        <TestTranscript
          sessionId="session-1"
          store={storeWith(
            [user, { ...reasoning, status: "complete" }, { ...tool, state: "success" }, assistant],
            true,
          )}
        />,
      ),
    );
    expect(container.querySelector(".loading-state")).toBe(loadingState);
  });

  it("updates a selected session without remounting the virtualized transcript", () => {
    const first: UiPart = {
      id: "assistant-1",
      kind: "text",
      role: "assistant",
      text: "First session",
      status: "complete",
    };
    const second: UiPart = {
      id: "assistant-2",
      kind: "text",
      role: "assistant",
      text: "Second session",
      status: "complete",
    };

    act(() => root.render(<TestTranscript sessionId="session-1" store={storeWith([first])} />));
    scrollToIndex.mockClear();
    act(() => root.render(<TestTranscript sessionId="session-2" store={storeWith([second])} />));

    expect(virtualizedLifecycle.mock.calls).toEqual([["mounted"]]);
    expect(scrollToIndex).toHaveBeenCalledWith({ index: 0, align: "end", behavior: "auto" });
  });

  it("shows loading for the whole conversation turn and removes it at end-turn", () => {
    const user: UiPart = {
      id: "user-1",
      kind: "text",
      role: "user",
      text: "My message",
      status: "complete",
    };
    const assistant: UiPart = {
      id: "assistant-1",
      kind: "text",
      role: "assistant",
      text: "Working",
      status: "streaming",
    };

    act(() =>
      root.render(<TestTranscript sessionId="session-1" store={storeWith([user], true)} />),
    );
    expect(container.querySelector(".loading-state")).not.toBeNull();

    act(() =>
      root.render(
        <TestTranscript sessionId="session-1" store={storeWith([user, assistant], true)} />,
      ),
    );
    expect(container.querySelector(".loading-state")).not.toBeNull();

    act(() =>
      root.render(
        <Transcript
          parts={[user, { ...assistant, status: "complete" }]}
          sessionId="session-1"
          isStreaming={false}
          isSubmitting
          behavior={{}}
          empty={<div />}
        />,
      ),
    );
    expect(container.querySelector(".loading-state")).toBeNull();
  });

  it("offers copy and fork actions on completed assistant messages only", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const parts: UiPart[] = [
      {
        id: "user-1",
        kind: "text",
        role: "user",
        entryId: "user-entry",
        text: "Question",
        status: "complete",
      },
      {
        id: "assistant-1",
        kind: "text",
        role: "assistant",
        entryId: "assistant-entry",
        text: "Answer",
        status: "complete",
      },
    ];
    const store = storeWith(parts);

    act(() => root.render(<TestTranscript sessionId="session-1" store={store} />));

    const message = container.querySelector<HTMLElement>(".assistant-message")!;
    const content = message.querySelector<HTMLElement>(".assistant-message-content")!;
    const actions = message.querySelector<HTMLElement>('[aria-label="Message actions"]')!;
    expect(actions).not.toBeNull();
    expect(content.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Copy response"]')!.click(),
    );
    expect(writeText).toHaveBeenCalledWith("Answer");
    expect(container.querySelector('[aria-label="Copied response"]')).not.toBeNull();

    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Fork response into new chat"]')!
        .click(),
    );
    expect(store.forkAt).toHaveBeenCalledWith("assistant-entry");
  });

  it("captures a rendered Markdown selection as a stable message anchor", () => {
    const content = document.createElement("div");
    content.innerHTML = "<p>Alpha <strong>important</strong> detail.</p>";
    document.body.appendChild(content);
    const selectedNode = content.querySelector("strong")!.firstChild!;
    const range = document.createRange();
    range.setStart(selectedNode, 0);
    range.setEnd(selectedNode, "important".length);
    const browserSelection = window.getSelection()!;
    browserSelection.removeAllRanges();
    browserSelection.addRange(range);

    expect(captureMessageSelection(content, "assistant-1", "entry-1")).toMatchObject({
      messageId: "assistant-1",
      entryId: "entry-1",
      selectedText: "important",
      startOffset: 6,
      endOffset: 15,
      contextBefore: "Alpha ",
      contextAfter: " detail.",
    });
    content.remove();
    browserSelection.removeAllRanges();
  });

  it("offers a chat immediately when text selection finishes", () => {
    vi.useFakeTimers();
    const comments: MessageCommentsStore = mount(
      createStore(MessageCommentsStore, {
        client: { createReviewThread: vi.fn() } as never,
        sessionRegistry: { findModel: () => undefined } as never,
        reviews: () => ({ configuration: undefined }) as never,
        draftChatStore: (): ChatStore => popupChat,
        context: () => ({ workspacePath: "/project", sessionId: "session-1" }),
      }),
    );
    const popupChat: ChatStore = mount(comments.draftChatStoreElement);
    act(() =>
      root.render(
        <Transcript
          parts={[
            {
              id: "assistant-1",
              kind: "text",
              role: "assistant",
              entryId: "entry-1",
              text: "Alpha important detail.",
              status: "complete",
            },
          ]}
          sessionId="session-1"
          isStreaming={false}
          behavior={{
            messageComments: comments,
          }}
          empty={<div />}
        />,
      ),
    );

    const walker = document.createTreeWalker(
      container.querySelector<HTMLElement>(".assistant-message-content")!,
      NodeFilter.SHOW_TEXT,
    );
    let important: Node | null = walker.nextNode();
    while (important && !important.textContent?.includes("Alpha important detail"))
      important = walker.nextNode();
    expect(important).not.toBeNull();
    const range = document.createRange();
    range.setStart(important!, 6);
    range.setEnd(important!, 15);
    const browserSelection = window.getSelection()!;
    browserSelection.removeAllRanges();
    browserSelection.addRange(range);
    act(() => document.dispatchEvent(new Event("selectionchange")));
    act(() => vi.advanceTimersByTime(MESSAGE_COMMENT_SELECTION_SETTLE_MS));
    expect(
      document.body.querySelector<HTMLButtonElement>(".message-selection-action")?.textContent,
    ).toBe("Chat about this");

    act(() => document.body.querySelector<HTMLButtonElement>(".message-selection-action")!.click());
    const dialog = document.body.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Chat about this"]',
    )!;
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector(".transcript .user-message")?.textContent).toBe("important");
    expect(dialog.querySelector(".transcript article > div:first-child")?.textContent).toBe("You");
    expect(dialog.querySelector(".chat-layout-compact")).not.toBeNull();
    const input = dialog.querySelector<HTMLTextAreaElement>(
      '[aria-label="Message about selected text"]',
    )!;
    expect(input).toBe(document.activeElement);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        input,
        "Why is this important?",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(comments.draftChatStore.draft).toBe("Why is this important?");
    expect(input.value).toBe("Why is this important?");
    expect(input).toBe(document.activeElement);
    browserSelection.removeAllRanges();
    comments[Symbol.dispose]();
    popupChat[Symbol.dispose]();
    vi.useRealTimers();
  });

  it("hides the selection chat offer when focus moves into an input", () => {
    vi.useFakeTimers();
    const draftChat = mount(
      createStore(ChatStore, {
        id: () => "selection-input-focus",
        parts: () => [],
        streaming: () => false,
        submitting: () => false,
        configuration: () => undefined,
        commands: () => [],
        placeholder: () => "Ask Cake about this selection…",
        inputLabel: () => "Message about selected text",
        canSubmit: (draft) => Boolean(draft.trim()),
        submit: async () => true,
      }),
    );
    const comments = {
      threadsForMessage: () => [],
      prepareDraft: vi.fn(),
      draftChatStore: draftChat,
    } as unknown as MessageCommentsStore;
    act(() =>
      root.render(
        <Transcript
          parts={[
            {
              id: "assistant-1",
              kind: "text",
              role: "assistant",
              entryId: "entry-1",
              text: "Alpha important detail.",
              status: "complete",
            },
          ]}
          sessionId="session-1"
          isStreaming={false}
          behavior={{
            messageComments: comments,
          }}
          empty={<div />}
        />,
      ),
    );

    const content = container.querySelector<HTMLElement>(".assistant-message-content")!;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    let detail: Node | null = walker.nextNode();
    while (detail && !detail.textContent?.includes("important")) detail = walker.nextNode();
    expect(detail).not.toBeNull();
    const range = document.createRange();
    const start = detail!.textContent!.indexOf("important");
    range.setStart(detail!, start);
    range.setEnd(detail!, start + "important".length);
    const browserSelection = window.getSelection()!;
    browserSelection.removeAllRanges();
    browserSelection.addRange(range);
    act(() => document.dispatchEvent(new Event("selectionchange")));
    act(() => vi.advanceTimersByTime(MESSAGE_COMMENT_SELECTION_SETTLE_MS));
    expect(document.body.querySelector(".message-selection-action")).not.toBeNull();

    const composerInput = document.createElement("textarea");
    document.body.append(composerInput);
    composerInput.focus();
    act(() => {
      browserSelection.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(document.body.querySelector(".message-selection-action")).toBeNull();

    composerInput.remove();
    draftChat[Symbol.dispose]();
    vi.useRealTimers();
  });

  it("captures selections from fenced code at the assistant message boundary", () => {
    vi.useFakeTimers();
    const draftChat = mount(
      createStore(ChatStore, {
        id: () => "code-message-comment-draft",
        parts: () => [],
        streaming: () => false,
        submitting: () => false,
        configuration: () => undefined,
        commands: () => [],
        placeholder: () => "Ask Cake about this passage…",
        inputLabel: () => "Message about selected code",
        canSubmit: (draft) => Boolean(draft.trim()),
        submit: async () => true,
      }),
    );
    const comments = {
      threadsForMessage: () => [],
      prepareDraft: vi.fn(),
      draftChatStore: draftChat,
    } as unknown as MessageCommentsStore;
    act(() =>
      root.render(
        <Transcript
          parts={[
            {
              id: "assistant-code",
              kind: "text",
              role: "assistant",
              entryId: "entry-code",
              text: "```tsx\nconst value = 42;\n```",
              status: "complete",
            },
          ]}
          sessionId="session-1"
          isStreaming={false}
          behavior={{
            messageComments: comments,
          }}
          empty={<div />}
        />,
      ),
    );

    const content = container.querySelector<HTMLElement>(".assistant-message-content")!;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    let codeText: Node | null = walker.nextNode();
    while (codeText && !codeText.textContent?.includes("const value = 42"))
      codeText = walker.nextNode();
    expect(codeText).not.toBeNull();
    const start = codeText!.textContent!.indexOf("value");
    const range = document.createRange();
    range.setStart(codeText!, start);
    range.setEnd(codeText!, start + "value".length);
    const browserSelection = window.getSelection()!;
    browserSelection.removeAllRanges();
    browserSelection.addRange(range);
    const codeBlock = codeText!.parentElement!.closest(
      "[data-streamdown='code-block'], pre, code",
    )!;
    codeBlock.addEventListener("pointerup", (event) => event.stopPropagation());
    act(() => document.dispatchEvent(new Event("selectionchange")));
    act(() => vi.advanceTimersByTime(MESSAGE_COMMENT_SELECTION_SETTLE_MS));

    expect(
      document.body.querySelector<HTMLButtonElement>(".message-selection-action")?.textContent,
    ).toBe("Chat about this");
    browserSelection.removeAllRanges();
    draftChat[Symbol.dispose]();
    vi.useRealTimers();
  });

  it("detects native selection changes inside assistant Markdown", () => {
    vi.useFakeTimers();
    const draftChat = mount(
      createStore(ChatStore, {
        id: () => "keyboard-message-comment-draft",
        parts: () => [],
        streaming: () => false,
        submitting: () => false,
        configuration: () => undefined,
        commands: () => [],
        placeholder: () => "Ask Cake about this passage…",
        inputLabel: () => "Message about selected text",
        canSubmit: (draft) => Boolean(draft.trim()),
        submit: async () => true,
      }),
    );
    const comments = {
      threadsForMessage: () => [],
      prepareDraft: vi.fn(),
      draftChatStore: draftChat,
    } as unknown as MessageCommentsStore;
    act(() =>
      root.render(
        <Transcript
          parts={[
            {
              id: "assistant-keyboard",
              kind: "text",
              role: "assistant",
              text: "Keyboard selection works.",
              status: "complete",
            },
          ]}
          sessionId="session-1"
          isStreaming={false}
          behavior={{
            messageComments: comments,
          }}
          empty={<div />}
        />,
      ),
    );

    const content = container.querySelector<HTMLElement>(".assistant-message-content")!;
    const text = document.createTreeWalker(content, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, "Keyboard".length);
    const browserSelection = window.getSelection()!;
    browserSelection.removeAllRanges();
    browserSelection.addRange(range);
    act(() => document.dispatchEvent(new Event("selectionchange")));
    act(() => vi.advanceTimersByTime(MESSAGE_COMMENT_SELECTION_SETTLE_MS));

    expect(
      document.body.querySelector<HTMLButtonElement>(".message-selection-action")?.textContent,
    ).toBe("Chat about this");
    browserSelection.removeAllRanges();
    draftChat[Symbol.dispose]();
    vi.useRealTimers();
  });

  it("offers the same selection chat above a fullscreen assistant response", () => {
    vi.useFakeTimers();
    const draftChat = mount(
      createStore(ChatStore, {
        id: () => "fullscreen-message-comment-draft",
        parts: () => [],
        streaming: () => false,
        submitting: () => false,
        configuration: () => undefined,
        commands: () => [],
        placeholder: () => "Ask Cake about this passage…",
        inputLabel: () => "Message about selected fullscreen text",
        canSubmit: (draft) => Boolean(draft.trim()),
        submit: async () => true,
      }),
    );
    const comments = {
      threadsForMessage: () => [],
      prepareDraft: vi.fn(),
      draftChatStore: draftChat,
    } as unknown as MessageCommentsStore;
    act(() =>
      root.render(
        <Transcript
          parts={[
            {
              id: "assistant-1",
              kind: "text",
              role: "assistant",
              entryId: "entry-1",
              text: "Alpha important detail.",
              status: "complete",
            },
          ]}
          sessionId="session-1"
          isStreaming={false}
          behavior={{
            messageComments: comments,
          }}
          empty={<div />}
        />,
      ),
    );

    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="View response fullscreen"]')!
        .click(),
    );
    const fullscreen = document.body.querySelector<HTMLElement>(".fullscreen-surface")!;
    const content = fullscreen.querySelector<HTMLElement>(".fullscreen-surface-content")!;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    let important: Node | null = walker.nextNode();
    while (important && !important.textContent?.includes("Alpha important detail"))
      important = walker.nextNode();
    const range = document.createRange();
    range.setStart(important!, 6);
    range.setEnd(important!, 15);
    const browserSelection = window.getSelection()!;
    browserSelection.removeAllRanges();
    browserSelection.addRange(range);
    act(() => content.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));

    act(() => document.body.querySelector<HTMLButtonElement>(".message-selection-action")!.click());
    expect(document.body.querySelector(".fullscreen-surface")).toBe(fullscreen);
    expect(
      document.body.querySelector('[role="dialog"][aria-label="Chat about this"]'),
    ).not.toBeNull();
    expect(comments.prepareDraft).toHaveBeenCalledWith(
      expect.objectContaining({ selectedText: "important", startOffset: 6, endOffset: 15 }),
    );
    expect(
      document.body.querySelector<HTMLTextAreaElement>(
        '[aria-label="Message about selected fullscreen text"]',
      ),
    ).toBe(document.activeElement);
    browserSelection.removeAllRanges();
    draftChat[Symbol.dispose]();
    vi.useRealTimers();
  });

  it("restores a selection marker and reopens its persisted chat", () => {
    const now = new Date(0).toISOString();
    const thread = {
      id: "thread-1",
      anchor: { selectedText: "important", startOffset: 6, endOffset: 15 },
      messages: [
        { id: "question-1", role: "user", body: "Why this word?", status: "complete" },
        {
          id: "answer-1",
          role: "assistant",
          body: "Because it carries the point.",
          status: "complete",
        },
      ],
      status: "open",
      updatedAt: now,
    };
    const configuration = {
      session: {
        model: { provider: "openai", id: "gpt" },
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
      selectModel: vi.fn(),
      selectThinkingLevel: vi.fn(),
    } as unknown as ChatConfigurationStore;
    const threadChat = mount(
      createStore(ChatStore, {
        id: () => thread.id,
        parts: () =>
          thread.messages.map((message) => ({
            id: message.id,
            kind: "text" as const,
            role: message.role as "user" | "assistant",
            text: message.body,
            status: message.status as "complete",
          })),
        streaming: () => false,
        submitting: () => false,
        configuration: () => configuration,
        commands: () => [],
        placeholder: () => "Ask a follow-up…",
        inputLabel: () => "Reply to selection chat",
        canSubmit: (draft) => Boolean(draft.trim()),
        submit: async () => true,
      }),
    );
    const comments = {
      threadsForMessage: () => [thread],
      threadStreaming: () => false,
      chatStore: () => threadChat,
      replyThread: vi.fn(),
      resolveThread: vi.fn(),
    } as unknown as MessageCommentsStore;
    act(() =>
      root.render(
        <Transcript
          parts={[
            {
              id: "assistant-1",
              kind: "text",
              role: "assistant",
              text: "Alpha important detail.",
              status: "complete",
            },
          ]}
          sessionId="session-1"
          isStreaming={false}
          behavior={{
            messageComments: comments,
          }}
          empty={<div />}
        />,
      ),
    );

    const marker = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open selection chat 1"]',
    );
    expect(marker).not.toBeNull();
    act(() => marker!.click());
    const chat = document.body.querySelector('[role="dialog"][aria-label="Selection chat"]');
    expect(chat?.textContent).toContain("Why this word?");
    expect(chat?.textContent).toContain("Because it carries the point.");
    expect(chat?.querySelector(".chat-layout-embedded > .transcript")).not.toBeNull();
    expect(chat?.querySelector(".assistant-message .assistant-message-actions")).not.toBeNull();
    expect(chat?.textContent).not.toContain("Resolve chat");
    expect(chat?.textContent).not.toContain("Reopen chat");
    expect(chat?.querySelector(".chat-embedded-workbench-composer")).not.toBeNull();
    expect(chat?.querySelector<HTMLInputElement>('[aria-label="Model"]')?.value).toBe("GPT");
    expect(chat?.querySelector('[aria-label="Thinking level"]')?.textContent).toContain(
      "Medium reasoning",
    );

    const titlebar = chat!.querySelector<HTMLElement>(".message-comment-titlebar")!;
    Object.defineProperty(chat, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 100,
        top: 100,
        right: 620,
        bottom: 500,
        width: 520,
        height: 400,
        x: 100,
        y: 100,
        toJSON: () => ({}),
      }),
    });
    titlebar.setPointerCapture = vi.fn();
    act(() =>
      titlebar.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 120, clientY: 120 }),
      ),
    );
    act(() =>
      document.dispatchEvent(
        new MouseEvent("pointermove", { bubbles: true, clientX: 170, clientY: 190 }),
      ),
    );
    act(() => document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })));
    expect((chat as HTMLElement).style.left).toBe("150px");
    expect((chat as HTMLElement).style.top).toBe("170px");
    threadChat[Symbol.dispose]();
  });

  it("opens every assistant response in a fullscreen reader regardless of text length or streaming state", () => {
    act(() =>
      root.render(
        <TestTranscript
          sessionId="session-1"
          store={storeWith([
            {
              id: "short",
              kind: "text",
              role: "assistant",
              text: "Short answer",
              status: "complete",
            },
            {
              id: "streaming",
              kind: "text",
              role: "assistant",
              text: "Working",
              status: "streaming",
            },
          ])}
        />,
      ),
    );

    const expandButtons = container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="View response fullscreen"]',
    );
    expect(expandButtons).toHaveLength(2);
    act(() => expandButtons[0]!.click());

    const dialog = document.body.querySelector<HTMLElement>(".fullscreen-surface");
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Short answer");
    expect(document.body.style.overflow).toBe("hidden");

    act(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(document.body.querySelector(".fullscreen-surface")).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  it("renders submitted image attachments from Pi's persisted base64 block", () => {
    const image: UiPart = {
      id: "image-1",
      kind: "attachment",
      name: "Image 1",
      mediaType: "image/png",
      attachmentKind: "image",
      data: "aW1hZ2U=",
    };

    act(() => root.render(<TestTranscript sessionId="session-1" store={storeWith([image])} />));

    const preview = container.querySelector<HTMLImageElement>(".transcript-image img")!;
    expect(preview.src).toBe("data:image/png;base64,aW1hZ2U=");
    expect(preview.alt).toBe("Image 1");
  });
});
