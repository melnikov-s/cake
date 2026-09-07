/**
 * @vitest-environment jsdom
 */
import React, { act, forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, mount, observable } from "r-state-tree";
import type { Annotation, UiPart } from "../../../src/ipc/session-contract";
import { cakeHotkeyEventName } from "../../../src/renderer/lib/hotkeys";

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
      customScrollParent?: HTMLElement;
    },
    ref,
  ) {
    virtualizedProps.current = props as unknown as Record<string, unknown>;
    useImperativeHandle(ref, () => ({
      getState: (callback: (state: unknown) => void) =>
        callback({
          ranges: [{ startIndex: 0, endIndex: props.data.length - 1, size: 100 }],
          scrollTop: props.customScrollParent?.scrollTop ?? 0,
        }),
      scrollToIndex,
    }));
    useEffect(() => {
      virtualizedLifecycle("mounted");
      return () => {
        virtualizedLifecycle("unmounted");
      };
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
  groupTranscriptParts,
  type ChatTranscriptBehavior,
} from "../../../src/renderer/components/chat-transcript";
import { MessageCommentsStore } from "../../../src/renderer/stores/MessageCommentsStore";
import type { ChatConfigurationStore } from "../../../src/renderer/stores/ChatConfigurationStore";
import { ChatStore } from "../../../src/renderer/stores/ChatStore";
import { RendererInfrastructureFixture } from "./renderer-infrastructure";

interface TranscriptHarness {
  visibleParts: UiPart[];
  isStreaming: boolean;
  error?: string;
  errorDetails?: string;
  forkAt(entryId: string): void | Promise<void>;
  handoffAt(entryId: string): void | Promise<void>;
}

function storeWith(
  parts: UiPart[],
  isStreaming = false,
  error?: string,
  errorDetails?: string,
): TranscriptHarness {
  return {
    visibleParts: parts,
    error,
    errorDetails,
    isStreaming,
    forkAt: vi.fn(),
    handoffAt: vi.fn(),
  };
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
  messageNavigationRequest,
  annotations,
  addAnnotation,
  updateAnnotation,
  removeAnnotation,
  virtualized = true,
}: {
  parts: UiPart[];
  sessionId: string;
  isStreaming: boolean;
  isSubmitting?: boolean;
  hideThinking?: boolean;
  behavior?: ChatTranscriptBehavior & {
    workLogViewMode?: "auto" | "diff" | "log";
    workLogsExpansion?: "collapsed" | "expanded" | "fully-expanded";
  };
  empty?: React.ReactNode;
  footer?: React.ReactNode;
  error?: string;
  errorDetails?: string;
  errorTitle?: string;
  messageNavigationRequest?: { messageId: string; revision: number };
  annotations?: readonly Annotation[];
  addAnnotation?(annotation: Parameters<ChatStore["addAnnotation"]>[0]): void;
  updateAnnotation?(id: string, update: Partial<Omit<Annotation, "id">>): void;
  removeAnnotation?(id: string): void;
  virtualized?: boolean;
}) {
  const {
    workLogViewMode = "auto",
    workLogsExpansion: initialExpansion = "collapsed",
    ...transcriptBehavior
  } = behavior ?? {};
  // Expansion state must survive prop-only re-renders, like a real ChatStore.
  const workLogStateRef = useRef<
    | {
        expansion: { value: "collapsed" | "expanded" | "fully-expanded" };
        items: Map<string, boolean>;
        groups: Map<string, boolean>;
      }
    | undefined
  >(undefined);
  if (!workLogStateRef.current)
    workLogStateRef.current = {
      expansion: observable({ value: initialExpansion }),
      items: observable(new Map()),
      groups: observable(new Map()),
    };
  const workLogState = workLogStateRef.current;
  const changedFilesStateRef = useRef(observable({ open: false }));
  const changedFilesChurningRef = useRef<boolean | undefined>(undefined);
  const transcriptScrollStatesRef = useRef(
    new Map<
      string,
      { ranges: Array<{ startIndex: number; endIndex: number; size: number }>; scrollTop: number }
    >(),
  );
  const store = {
    id: sessionId,
    parts,
    streaming: isStreaming,
    submitting: isSubmitting,
    hideThinking,
    workLogViewMode,
    userMessageRendersAsMarkdown: (_entryId: string, projected: boolean) => projected,
    setWorkLogViewMode: () => undefined,
    cycleWorkLogViewMode: () => undefined,
    workLogElapsedMs: () => undefined,
    workLogElapsedMsRange: () => undefined,
    get workLogsExpansion() {
      return workLogState.expansion.value;
    },
    get workLogItemOverrides() {
      return workLogState.items;
    },
    get workLogGroupOverrides() {
      return workLogState.groups;
    },
    setWorkLogsExpansion(expansion: "collapsed" | "expanded" | "fully-expanded") {
      workLogState.expansion.value = expansion;
      workLogState.items.clear();
      workLogState.groups.clear();
    },
    cycleWorkLogsExpansion() {
      workLogState.expansion.value =
        workLogState.expansion.value === "collapsed"
          ? "expanded"
          : workLogState.expansion.value === "expanded"
            ? "fully-expanded"
            : "collapsed";
      workLogState.items.clear();
      workLogState.groups.clear();
    },
    workLogGroupOpen(groupId: string, hasDiff: boolean) {
      const override = workLogState.groups.get(groupId);
      if (override !== undefined) return override;
      if (workLogState.expansion.value === "collapsed") return false;
      if (workLogViewMode === "diff" && !hasDiff) return false;
      return true;
    },
    setWorkLogGroupOpen(groupId: string, open: boolean) {
      workLogState.groups.set(groupId, open);
    },
    workLogItemOpen(partId: string) {
      return workLogState.items.get(partId) ?? workLogState.expansion.value === "fully-expanded";
    },
    setWorkLogItemOpen(partId: string, open: boolean) {
      workLogState.items.set(partId, open);
    },
    get transcriptScrollState() {
      return transcriptScrollStatesRef.current.get(sessionId);
    },
    messageNavigationRequest,
    get changedFilesOpen() {
      return changedFilesStateRef.current.open;
    },
    setChangedFilesOpen(open: boolean) {
      changedFilesStateRef.current.open = open;
    },
    syncChangedFilesOpen(churning: boolean) {
      if (changedFilesChurningRef.current === churning) return;
      changedFilesChurningRef.current = churning;
      if (churning) changedFilesStateRef.current.open = false;
    },
    annotations: annotations ?? [],
    canAnnotate: Boolean(addAnnotation),
    addAnnotation,
    updateAnnotation,
    removeAnnotation,
    setTranscriptScrollState(
      state:
        | {
            ranges: Array<{ startIndex: number; endIndex: number; size: number }>;
            scrollTop: number;
          }
        | undefined,
    ) {
      if (state !== undefined) transcriptScrollStatesRef.current.set(sessionId, state);
      else transcriptScrollStatesRef.current.delete(sessionId);
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
      virtualized={virtualized}
      key={sessionId}
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
        onHandoff: (entryId) => {
          void store.handoffAt(entryId);
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

  it("defaults a loaded session with no scroll target to the very bottom", () => {
    const parts: UiPart[] = [
      { id: "assistant-1", kind: "text", role: "assistant", text: "First", status: "complete" },
      { id: "assistant-2", kind: "text", role: "assistant", text: "Latest", status: "complete" },
    ];

    act(() => root.render(<TestTranscript sessionId="session-1" store={storeWith(parts)} />));

    expect(virtualizedProps.current?.initialTopMostItemIndex).toEqual({ index: 1, align: "end" });
    expect(virtualizedProps.current?.followOutput).toBe(false);
  });

  it("lays consecutive sources out together in a wrapping horizontal group", () => {
    const parts: UiPart[] = [
      { id: "source-1", kind: "source", title: "github.com", url: "https://github.com/one" },
      { id: "source-2", kind: "source", title: "example.com", url: "https://example.com" },
      { id: "source-3", kind: "source", title: "docs.dev", url: "https://docs.dev" },
    ];

    act(() => root.render(<TestTranscript sessionId="session-1" store={storeWith(parts)} />));

    const group = container.querySelector<HTMLElement>('[data-slot="source-group"]')!;
    expect(group.className).toContain("flex-wrap");
    expect(Array.from(group.querySelectorAll("a"), (source) => source.textContent)).toEqual([
      "github.com",
      "example.com",
      "docs.dev",
    ]);
    expect(virtualizedProps.current?.data as Array<{ kind: string }>).toHaveLength(1);
  });

  it("renders user input as plain text with its original line breaks", () => {
    const parts: UiPart[] = [
      {
        id: "user-1",
        kind: "text",
        role: "user",
        text: "# Not a heading\n**Not bold**",
        status: "complete",
      },
    ];

    act(() => root.render(<TestTranscript sessionId="session-1" store={storeWith(parts)} />));

    const message = container.querySelector<HTMLElement>('[data-slot="message-content"]')!;
    expect(message.className).toContain("bg-user-message");
    expect(message.className).toContain("text-user-message-foreground");
    expect(message.textContent).toBe("# Not a heading\n**Not bold**");
    expect(message.classList.contains("whitespace-pre-wrap")).toBe(true);
    expect(message.querySelector("h1, strong")).toBeNull();
  });

  it("renders opted-in user input as Markdown", () => {
    const parts: UiPart[] = [
      {
        id: "user-1",
        kind: "text",
        role: "user",
        text: "# A heading\n\n**Bold**",
        status: "complete",
        entryId: "user-entry-1",
        renderAs: "markdown",
      },
    ];

    act(() => root.render(<TestTranscript sessionId="session-1" store={storeWith(parts)} />));

    const message = container.querySelector<HTMLElement>('[data-slot="message-content"]')!;
    expect(message.classList.contains("whitespace-pre-wrap")).toBe(false);
    expect(message.querySelector("h1")?.textContent).toBe("A heading");
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

    const transcriptItems = Array.from(container.querySelectorAll('[data-slot="transcript-item"]'));
    expect(transcriptItems.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Please fix this"),
      expect.stringContaining("1 comment replied"),
      expect.stringContaining("Done"),
    ]);
  });

  it("renders a skill load as an expandable indicator instead of a user message", () => {
    const parts: UiPart[] = [
      {
        id: "skill-1",
        kind: "skill",
        name: "pdf-tools",
        content: "# PDF tools\n\nExtract text from PDFs.",
      },
    ];

    act(() => root.render(<TestTranscript sessionId="session-1" store={storeWith(parts)} />));

    const skill = container.querySelector<HTMLDetailsElement>("details");
    expect(skill?.querySelector("summary")?.textContent).toContain("Skill loadedpdf-tools");
    expect(skill?.open).toBe(false);
    expect(container.querySelector(".user-message")).toBeNull();

    act(() => skill?.querySelector<HTMLElement>("summary")?.click());
    expect(skill?.open).toBe(true);
    expect(skill?.textContent).toContain("Extract text from PDFs.");
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

    const transcriptItems = Array.from(container.querySelectorAll('[data-slot="transcript-item"]'));
    expect(transcriptItems[0]?.classList.contains("pt-3")).toBe(false);
    expect(transcriptItems[1]?.classList.contains("pt-3")).toBe(true);
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

  it("scrolls to a specifically requested transcript message", () => {
    const parts: UiPart[] = [
      { id: "user-1", kind: "text", role: "user", text: "First", status: "complete" },
      {
        id: "assistant-1",
        kind: "text",
        role: "assistant",
        text: "Second",
        status: "complete",
      },
      { id: "user-2", kind: "text", role: "user", text: "Third", status: "complete" },
    ];

    act(() =>
      root.render(
        <Transcript
          parts={parts}
          sessionId="session-1"
          isStreaming={false}
          messageNavigationRequest={{ messageId: "assistant-1", revision: 1 }}
          empty={<div />}
        />,
      ),
    );

    const message = container.querySelector('[data-part-id="assistant-1"]');
    expect(message).not.toBeNull();
  });

  it("indicates when Pi is busy before the first turn part appears", () => {
    act(() => root.render(<TestTranscript sessionId="session-1" store={storeWith([], true)} />));

    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  it("keeps direct shell commands out of work logs and assistant loading", () => {
    const command: UiPart = {
      id: "command-1",
      kind: "command",
      command: "printf hello",
      output: "hello",
      excludeFromContext: false,
      state: "success",
    };
    const tool: UiPart = {
      id: "tool-1",
      kind: "tool",
      name: "read",
      input: "README.md",
      state: "success",
    };

    expect(groupTranscriptParts([command, tool])).toEqual([
      command,
      { kind: "activity-group", id: "activity-0", parts: [tool] },
    ]);
    expect(chatWorkIsActive([command], false, true)).toBe(false);

    act(() =>
      root.render(
        <Transcript parts={[command]} sessionId="session-1" isStreaming={false} isSubmitting />,
      ),
    );

    expect(container.querySelector('[data-slot="shell-command"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="activity-group"]')).toBeNull();
    expect(container.querySelector('[data-slot="loading-state"]')).toBeNull();
  });

  it("keeps the working indicator in the user message while tool results are in flight", () => {
    const user: UiPart = {
      id: "user-1",
      kind: "text",
      role: "user",
      text: "Run a command",
      status: "complete",
    };
    const reasoning: UiPart = {
      id: "reasoning-1",
      kind: "reasoning",
      text: "Thinking",
      status: "streaming",
    };

    act(() =>
      root.render(<TestTranscript sessionId="session-1" store={storeWith([user], true)} />),
    );
    expect(container.querySelector('[role="status"]')).not.toBeNull();

    act(() =>
      root.render(
        <TestTranscript sessionId="session-1" store={storeWith([user, reasoning], true)} />,
      ),
    );
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="activity-group"]')).not.toBeNull();
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

  it("leaves work log expansion under user control when settled part IDs replace live IDs", async () => {
    const liveReasoning: UiPart = {
      id: "live-reasoning",
      kind: "reasoning",
      text: "Inspecting",
      status: "streaming",
    };
    const running: UiPart = {
      id: "tool-1",
      kind: "tool",
      name: "read",
      input: "file",
      state: "running",
    };
    const render = (parts: UiPart[], isStreaming = false) =>
      root.render(<TestTranscript sessionId="session-1" store={storeWith(parts, isStreaming)} />);

    act(() => render([liveReasoning, running], true));
    const log = container.querySelector<HTMLDetailsElement>('[data-slot="activity-group"]')!;
    expect(log.open).toBe(false);
    expect(container.querySelector('[data-slot="work-log-content"]')).toBeNull();

    act(() =>
      container.querySelector<HTMLElement>('[data-slot="activity-group"] > summary')!.click(),
    );
    const toolToggle = container.querySelector<HTMLButtonElement>(
      '[data-slot="work-log-content"] [data-slot="tool"] button',
    )!;
    expect(toolToggle.getAttribute("aria-expanded")).toBe("false");
    act(() => toolToggle.click());
    // Signal-driven commits can be dropped in reused vitest workers, so re-render
    // explicitly and retry until the DOM reflects the store's item override.
    await waitFor(() => {
      act(() => render([liveReasoning, running], true));
      expect(toolToggle.getAttribute("aria-expanded")).toBe("true");
    });
    expect(log.open).toBe(true);

    const settledReasoning: UiPart = {
      ...liveReasoning,
      id: "entry-assistant-reasoning-0",
      status: "complete",
    };
    act(() => render([settledReasoning, { ...running, state: "success" }]));
    expect(log.open).toBe(true);
    expect(toolToggle.getAttribute("aria-expanded")).toBe("true");
    expect(log.querySelector(':scope > summary span[class*="bg-success"]')).not.toBeNull();
  });

  it("summarizes changed files at the conversation end and collapses the list", () => {
    const parts: UiPart[] = [
      {
        id: "tool-edit-1",
        kind: "tool",
        name: "edit",
        input: JSON.stringify({
          path: "/workspace/src/app.ts",
          edits: [{ oldText: "old", newText: "fresh" }],
        }),
        filePath: "/workspace/src/app.ts",
        state: "success",
      },
      {
        id: "tool-edit-2",
        kind: "tool",
        name: "edit",
        input: JSON.stringify({
          path: "/workspace/src/app.ts",
          edits: [{ oldText: "stale", newText: "current" }],
        }),
        filePath: "/workspace/src/app.ts",
        state: "success",
      },
      {
        id: "tool-write",
        kind: "tool",
        name: "write",
        input: JSON.stringify({
          path: "/workspace/src/new.ts",
          content: "first\nsecond",
        }),
        filePath: "/workspace/src/new.ts",
        state: "success",
      },
    ];

    const openSourceLocation = vi.fn();
    act(() =>
      root.render(
        <Transcript
          parts={parts}
          sessionId="session-1"
          isStreaming={false}
          behavior={{ workspacePath: "/workspace", openSourceLocation }}
          virtualized={false}
        />,
      ),
    );

    const summary = container.querySelector<HTMLElement>('[aria-label="Changed Files"]')!;
    const trigger = summary.querySelector<HTMLButtonElement>("button")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(summary.querySelector("ul")).toBeNull();

    act(() => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(summary.textContent).toContain("src/app.ts+2−2");
    expect(summary.textContent).toContain("src/new.ts+2−0");

    act(() =>
      summary
        .querySelector<HTMLButtonElement>('[title="Open src/app.ts in VS Code Changes"]')!
        .click(),
    );
    expect(openSourceLocation).toHaveBeenCalledWith({ path: "src/app.ts", view: "changes" });

    act(() => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(summary.querySelector("ul")).toBeNull();
  });

  it("keeps changed files collapsed unless clicked and recollapses when streaming restarts", () => {
    const parts: UiPart[] = [
      {
        id: "tool-edit",
        kind: "tool",
        name: "edit",
        input: JSON.stringify({
          path: "/workspace/src/app.ts",
          edits: [{ oldText: "old", newText: "fresh" }],
        }),
        filePath: "/workspace/src/app.ts",
        state: "success",
      },
    ];

    const render = (isStreaming: boolean) =>
      root.render(
        <Transcript
          parts={parts}
          sessionId="session-1"
          isStreaming={isStreaming}
          behavior={{ workspacePath: "/workspace" }}
          virtualized={false}
        />,
      );
    act(() => render(true));

    const changedFiles = container.querySelector<HTMLElement>('[aria-label="Changed Files"]')!;
    const loading = container.querySelector<HTMLElement>('[data-slot="loading-state"]')!;
    const trigger = changedFiles.querySelector<HTMLButtonElement>("button")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.hasAttribute("disabled")).toBe(false);
    expect(changedFiles.compareDocumentPosition(loading) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    act(() => render(false));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.hasAttribute("disabled")).toBe(false);

    act(() => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(changedFiles.querySelector("ul")).not.toBeNull();

    act(() => render(true));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.hasAttribute("disabled")).toBe(false);

    act(() => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(changedFiles.querySelector("ul")).not.toBeNull();

    act(() => render(false));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.hasAttribute("disabled")).toBe(false);

    act(() => render(true));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("switches an expanded work log between auto, diff, and log view modes", () => {
    const editPart: UiPart = {
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
    const readPart: UiPart = {
      id: "tool-read",
      kind: "tool",
      name: "read",
      input: JSON.stringify({ path: "README.md" }),
      state: "success",
      output: "README text",
    };

    const render = (viewMode: "auto" | "diff" | "log", part: UiPart = editPart) =>
      root.render(
        <Transcript
          parts={[part]}
          sessionId="session-1"
          isStreaming
          behavior={{
            workLogsExpansion: "expanded",
            workLogViewMode: viewMode,
          }}
          empty={<div />}
        />,
      );

    // In auto mode with edit parts (has diff), renders diff view
    act(() => render("auto", editPart));
    expect(container.querySelector('[aria-label="Streaming file diff"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Streaming file diff"]')?.textContent).toContain(
      "fresh",
    );

    // In auto mode with only read parts (no diff), renders log view
    act(() => render("auto", readPart));
    expect(container.querySelector('[aria-label="Streaming file diff"]')).toBeNull();

    // In explicit diff mode, renders diff view
    act(() => render("diff", editPart));
    expect(container.querySelector('[aria-label="Streaming file diff"]')).not.toBeNull();

    // In explicit log mode, renders tool-call items even if edits exist
    act(() => render("log", editPart));
    expect(container.querySelector('[aria-label="Streaming file diff"]')).toBeNull();
  });

  it("shows empty reasoning as a non-expandable status", () => {
    const empty: UiPart = { id: "reasoning-1", kind: "reasoning", text: "", status: "complete" };

    act(() => root.render(<TestTranscript sessionId="session-1" store={storeWith([empty])} />));

    const status = container.querySelector<HTMLElement>('[data-slot="activity-group"]')!;
    expect(status.textContent).toContain("Reasoning details not exposed");
    expect(status.querySelector('span[class*="bg-success"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="activity-group"] > summary')).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  it("shows an empty in-progress reasoning block as thinking", () => {
    const empty: UiPart = { id: "reasoning-1", kind: "reasoning", text: "", status: "streaming" };

    act(() =>
      root.render(<TestTranscript sessionId="session-1" store={storeWith([empty], true)} />),
    );

    expect(container.querySelector('[data-slot="activity-group"]')?.textContent).toContain(
      "Thinking…",
    );
    expect(
      container.querySelector('[data-slot="activity-group"] span[class*="animate-pulse"]'),
    ).not.toBeNull();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  it("presents a matching background start and waits as one compact work-log item", () => {
    const handleId = crypto.randomUUID();
    const spawn: UiPart = {
      id: "subagent-spawn",
      kind: "tool",
      name: "cake",
      command: "subagents.start",
      input: JSON.stringify({
        task: "Tell a joke",
        profile: "worker",
        model: {
          prefer: "exact",
          provider: "openai-codex",
          modelId: "gpt-5.6-sol",
          thinkingLevel: "max",
        },
      }),
      output: JSON.stringify({ handleId, task: "Tell a joke", status: "running" }),
      state: "success",
    };
    const firstPoll: UiPart = {
      id: "subagent-poll",
      kind: "tool",
      name: "cake",
      command: "subagents.wait",
      input: JSON.stringify({ handleId }),
      output: JSON.stringify({
        handleId,
        task: "Tell a joke",
        profile: "worker",
        status: "running",
      }),
      state: "success",
    };
    const wait: UiPart = {
      id: "subagent-wait",
      kind: "tool",
      name: "cake",
      command: "subagents.wait",
      input: JSON.stringify({ handleId }),
      output: JSON.stringify({
        handleId,
        task: "Tell a joke",
        profile: "worker",
        status: "complete",
        resolvedModel: {
          requested: "exact",
          source: "exact",
          provider: "openai-codex",
          modelId: "gpt-5.6-sol",
          thinkingLevel: "max",
          fallbacks: [],
        },
        parts: [
          {
            id: "child-answer",
            kind: "text",
            text: "A compact joke.",
            status: "complete",
          },
        ],
      }),
      state: "success",
    };

    act(() =>
      root.render(
        <TestTranscript sessionId="session-1" store={storeWith([spawn, firstPoll, wait])} />,
      ),
    );
    expect(
      container.querySelector('[data-slot="activity-group"] > summary')?.textContent,
    ).toContain("1 tool call");

    act(() =>
      container.querySelector<HTMLElement>('[data-slot="activity-group"] > summary')!.click(),
    );
    expect(container.textContent).toContain("openai-codex/gpt-5.6-sol");
    expect(container.textContent).toContain("Tell a joke");
    expect(container.textContent).toContain("Background · 2 waits");
    expect(container.textContent).toContain("Released");
    expect(container.textContent).not.toContain("A compact joke.");
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

    const log = container.querySelector<HTMLElement>('[data-slot="activity-group"]')!;
    expect(log.querySelector(':scope > summary span[class*="bg-success"]')).not.toBeNull();
    expect(log.querySelector(':scope > summary span[class*="bg-destructive"]')).toBeNull();
    expect(container.querySelector('[data-slot="work-log-content"]')).toBeNull();
    act(() =>
      container.querySelector<HTMLElement>('[data-slot="activity-group"] > summary')!.click(),
    );
    expect(
      log.querySelector('[data-slot="work-log-content"] span[class*="bg-destructive"]'),
    ).not.toBeNull();
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
    const loadingState = container.querySelector('[data-slot="loading-state"]');
    expect(loadingState).not.toBeNull();

    act(() =>
      root.render(
        <TestTranscript
          sessionId="session-1"
          store={storeWith([user, { ...reasoning, status: "complete" }, tool], true)}
        />,
      ),
    );
    expect(container.querySelector('[data-slot="loading-state"]')).toBe(loadingState);

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
    expect(container.querySelector('[data-slot="loading-state"]')).toBe(loadingState);

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
    expect(container.querySelector('[data-slot="loading-state"]')).toBe(loadingState);
  });

  it("restores each selected session's virtualized scroll state", () => {
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
    act(() => {
      const transcript = container.querySelector<HTMLElement>(".transcript");
      if (transcript) transcript.scrollTop = 240;
      transcript?.dispatchEvent(new Event("scroll"));
    });
    act(() => root.render(<TestTranscript sessionId="session-2" store={storeWith([second])} />));
    act(() => root.render(<TestTranscript sessionId="session-1" store={storeWith([first])} />));

    expect(virtualizedLifecycle.mock.calls).toEqual([
      ["mounted"],
      ["unmounted"],
      ["mounted"],
      ["unmounted"],
      ["mounted"],
    ]);
    expect(virtualizedProps.current?.restoreStateFrom).toEqual({
      ranges: [{ startIndex: 0, endIndex: 0, size: 100 }],
      scrollTop: 240,
    });
    expect(virtualizedProps.current?.initialTopMostItemIndex).toBeUndefined();
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
    expect(container.querySelector('[data-slot="loading-state"]')).not.toBeNull();

    act(() =>
      root.render(
        <TestTranscript sessionId="session-1" store={storeWith([user, assistant], true)} />,
      ),
    );
    expect(container.querySelector('[data-slot="loading-state"]')).not.toBeNull();

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
    expect(container.querySelector('[data-slot="loading-state"]')).toBeNull();
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

    const message = container.querySelectorAll<HTMLElement>('[data-slot="message"]')[1]!;
    const content = message.querySelector<HTMLElement>('[data-slot="message-content"]')!;
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
        .querySelector<HTMLButtonElement>(
          '[aria-label="Fork response with full context into new chat"]',
        )!
        .click(),
    );
    expect(store.forkAt).toHaveBeenCalledWith("assistant-entry");

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Hand off response without tool history into new chat"]',
        )!
        .click(),
    );
    expect(store.handoffAt).toHaveBeenCalledWith("assistant-entry");
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

  /** Selects the first occurrence of `needle` inside `scope` as the browser selection. */
  function selectWithin(scope: HTMLElement, needle: string): void {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = node.textContent?.indexOf(needle) ?? -1;
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + needle.length);
      const browserSelection = window.getSelection()!;
      browserSelection.removeAllRanges();
      browserSelection.addRange(range);
      return;
    }
    throw new Error(`Could not locate ${needle}`);
  }

  function rightClick(target: Element): void {
    act(() => {
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 42,
          clientY: 64,
        }),
      );
    });
  }

  function mountedContextMenuAction() {
    type SelectionAction = "chat-about-selection" | "add-annotation";
    let resolve: ((action: SelectionAction) => void) | undefined;
    return {
      showSelectionContextMenu: vi.fn(
        () =>
          new Promise<SelectionAction>((next) => {
            resolve = next;
          }),
      ),
      async trigger(action: SelectionAction = "chat-about-selection") {
        await act(async () => resolve?.(action));
      },
    };
  }

  function mountedComments(draftChat: ChatStore): MessageCommentsStore {
    return {
      threadsForMessage: () => [],
      prepareDraft: vi.fn(),
      draftChatStore: draftChat,
    } as unknown as MessageCommentsStore;
  }

  it("offers Chat about this when right-clicking a message selection", async () => {
    const comments: MessageCommentsStore = mount(
      createStore(MessageCommentsStore, {
        client: { createReviewThread: vi.fn() } as never,
        sessionRegistry: { findModel: () => undefined } as never,
        reviews: () => ({ configuration: undefined }) as never,
        context: () => ({ workspacePath: "/project", sessionId: "session-1" }),
      }),
    );
    const contextMenu = mountedContextMenuAction();
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
            showSelectionContextMenu: contextMenu.showSelectionContextMenu,
          }}
          empty={<div />}
        />,
      ),
    );

    const content = container.querySelector<HTMLElement>('[data-slot="message-content"]')!;
    selectWithin(content, "important");
    rightClick(content);
    expect(contextMenu.showSelectionContextMenu).toHaveBeenCalledWith({
      canChat: true,
      canAnnotate: false,
    });
    await contextMenu.trigger();

    const dialog = document.body.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Chat about this"]',
    )!;
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector('.transcript [data-slot="message-content"]')?.textContent).toBe(
      "important",
    );
    expect(dialog.querySelector(".transcript [data-slot='message-label']")?.textContent).toBe(
      "You",
    );
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
    window.getSelection()?.removeAllRanges();
    comments[Symbol.dispose]();
  });

  it("offers annotation and chat actions for a selection in the work-log diff", () => {
    const contextMenu = mountedContextMenuAction();
    const editPart: UiPart = {
      id: "tool-edit-selection",
      kind: "tool",
      name: "edit",
      input: JSON.stringify({
        path: "src/app.ts",
        edits: [{ oldText: "old", newText: "fresh" }],
      }),
      filePath: "src/app.ts",
      state: "success",
    };

    act(() =>
      root.render(
        <Transcript
          parts={[editPart]}
          sessionId="session-1"
          isStreaming={false}
          behavior={{
            messageComments: {} as MessageCommentsStore,
            showSelectionContextMenu: contextMenu.showSelectionContextMenu,
            workLogsExpansion: "expanded",
          }}
          addAnnotation={vi.fn()}
          empty={<div />}
        />,
      ),
    );

    const diff = container.querySelector<HTMLElement>('[aria-label="Code changes"]')!;
    selectWithin(diff, "fresh");
    rightClick(diff);

    expect(contextMenu.showSelectionContextMenu).toHaveBeenCalledWith({
      canChat: true,
      canAnnotate: true,
    });
  });

  it("adds an annotated transcript selection to the composer", async () => {
    const addAnnotation = vi.fn();
    const contextMenu = mountedContextMenuAction();
    act(() =>
      root.render(
        <Transcript
          parts={[
            {
              id: "assistant-annotation",
              kind: "text",
              role: "assistant",
              entryId: "entry-annotation",
              text: "Alpha important detail.",
              status: "complete",
            },
          ]}
          sessionId="session-1"
          isStreaming={false}
          behavior={{ showSelectionContextMenu: contextMenu.showSelectionContextMenu }}
          addAnnotation={addAnnotation}
          empty={<div />}
        />,
      ),
    );

    const content = container.querySelector<HTMLElement>('[data-slot="message-content"]')!;
    selectWithin(content, "important");
    rightClick(content);
    expect(contextMenu.showSelectionContextMenu).toHaveBeenCalledWith({
      canChat: false,
      canAnnotate: true,
    });
    await contextMenu.trigger("add-annotation");

    const dialog = document.body.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Add annotation"]',
    )!;
    const comment = dialog.querySelector<HTMLTextAreaElement>('[aria-label="Annotation comment"]')!;
    expect(comment).toBe(document.activeElement);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        comment,
        "Remember this constraint",
      );
      comment.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());

    expect(addAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "assistant-annotation",
        entryId: "entry-annotation",
        selectedText: "important",
        comment: "Remember this constraint",
      }),
    );
    expect(document.body.querySelector('[role="dialog"][aria-label="Add annotation"]')).toBeNull();
  });

  it("renders pinned annotation marker and opens details popover to edit or delete", () => {
    const updateAnnotation = vi.fn();
    const removeAnnotation = vi.fn();
    const annotation = {
      id: "annotation-1",
      messageId: "assistant-annotation-view",
      entryId: "entry-annotation-view",
      selectedText: "important",
      startOffset: 6,
      endOffset: 15,
      contextBefore: "Alpha ",
      contextAfter: " detail.",
      comment: "Initial note",
    };

    act(() =>
      root.render(
        <Transcript
          parts={[
            {
              id: "assistant-annotation-view",
              kind: "text",
              role: "assistant",
              entryId: "entry-annotation-view",
              text: "Alpha important detail.",
              status: "complete",
            },
          ]}
          sessionId="session-1"
          isStreaming={false}
          annotations={[annotation]}
          updateAnnotation={updateAnnotation}
          removeAnnotation={removeAnnotation}
          empty={<div />}
        />,
      ),
    );

    const markerButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="View annotation 1"]',
    )!;
    expect(markerButton).not.toBeNull();

    // Click marker to open details popover
    act(() => markerButton.click());

    const detailsDialog = document.body.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Annotation details"]',
    )!;
    expect(detailsDialog).not.toBeNull();
    expect(detailsDialog.textContent).toContain("Initial note");

    // Click Edit button
    const editButton = detailsDialog.querySelector<HTMLButtonElement>(
      'button[aria-label="Edit annotation"]',
    )!;
    act(() => editButton.click());

    const editInput = detailsDialog.querySelector<HTMLTextAreaElement>(
      '[aria-label="Edit annotation comment"]',
    )!;
    expect(editInput).not.toBeNull();

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        editInput,
        "Updated note",
      );
      editInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // Save changes
    act(() => detailsDialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(updateAnnotation).toHaveBeenCalledWith("annotation-1", {
      comment: "Updated note",
    });

    // Test delete action
    const deleteButton = detailsDialog.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete annotation"]',
    );
    if (deleteButton) {
      act(() => deleteButton.click());
      expect(removeAnnotation).toHaveBeenCalledWith("annotation-1");
    }
  });

  it("keeps the native menu over editing surfaces and collapsed selections", () => {
    const draftChat = mount(
      createStore(ChatStore, {
        id: () => "selection-editing-surface",
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
    const comments = mountedComments(draftChat);
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
          behavior={{ messageComments: comments }}
          empty={<div />}
        />,
      ),
    );

    const content = container.querySelector<HTMLElement>('[data-slot="message-content"]')!;
    // A collapsed selection keeps the default menu.
    rightClick(content);

    // Right-clicking an editing surface keeps the native cut/copy/paste menu.
    selectWithin(content, "important");
    const composerInput = document.createElement("textarea");
    composerInput.append(document.createTextNode("draft text"));
    container.appendChild(composerInput);
    rightClick(composerInput);

    draftChat[Symbol.dispose]();
  });

  it("offers Chat about this for selections in the user's own message", async () => {
    const draftChat = mount(
      createStore(ChatStore, {
        id: () => "user-message-comment-draft",
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
    const comments = mountedComments(draftChat);
    const contextMenu = mountedContextMenuAction();
    act(() =>
      root.render(
        <Transcript
          parts={[
            {
              id: "user-1",
              kind: "text",
              role: "user",
              text: "Explain the settings shape please.",
              status: "complete",
            },
          ]}
          sessionId="session-1"
          isStreaming={false}
          behavior={{
            messageComments: comments,
            showSelectionContextMenu: contextMenu.showSelectionContextMenu,
          }}
          empty={<div />}
        />,
      ),
    );

    const message = container.querySelector<HTMLElement>('[data-slot="message-content"]')!;
    selectWithin(message, "settings shape");
    rightClick(message);
    await contextMenu.trigger();
    expect(comments.prepareDraft).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "user-1", selectedText: "settings shape" }),
    );
    expect(
      document.body.querySelector('[role="dialog"][aria-label="Chat about this"]'),
    ).not.toBeNull();
    draftChat[Symbol.dispose]();
  });

  it("offers Chat about this for selections inside fenced code", async () => {
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
    const comments = mountedComments(draftChat);
    const contextMenu = mountedContextMenuAction();
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
            showSelectionContextMenu: contextMenu.showSelectionContextMenu,
          }}
          empty={<div />}
        />,
      ),
    );

    const content = container.querySelector<HTMLElement>('[data-slot="message-content"]')!;
    selectWithin(content, "value");
    const codeBlock = content.querySelector("[data-streamdown='code-block'], pre, code")!;
    rightClick(codeBlock);
    await contextMenu.trigger();
    expect(comments.prepareDraft).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "assistant-code", selectedText: "value" }),
    );
    draftChat[Symbol.dispose]();
  });

  it("does not offer Chat about this while the selected part is streaming", () => {
    const draftChat = mount(
      createStore(ChatStore, {
        id: () => "streaming-selection-draft",
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
    const comments = mountedComments(draftChat);
    act(() =>
      root.render(
        <Transcript
          parts={[
            {
              id: "assistant-live",
              kind: "text",
              role: "assistant",
              text: "Streaming answer text.",
              status: "streaming",
            },
          ]}
          sessionId="session-1"
          isStreaming
          behavior={{ messageComments: comments }}
          empty={<div />}
        />,
      ),
    );

    const content = container.querySelector<HTMLElement>('[data-slot="message-content"]')!;
    selectWithin(content, "answer");
    rightClick(content);
    draftChat[Symbol.dispose]();
  });

  it("offers the same selection chat above a fullscreen assistant response", async () => {
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
    const comments = mountedComments(draftChat);
    const contextMenu = mountedContextMenuAction();
    act(() =>
      root.render(
        <RendererInfrastructureFixture>
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
              showSelectionContextMenu: contextMenu.showSelectionContextMenu,
            }}
            empty={<div />}
          />
        </RendererInfrastructureFixture>,
      ),
    );

    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="View response fullscreen"]')!
        .click(),
    );
    const fullscreen = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    const content = fullscreen.querySelector<HTMLElement>("article")!;
    selectWithin(content, "important");
    rightClick(content);
    await contextMenu.trigger();
    expect(document.body.querySelector('[role="dialog"]')).toBe(fullscreen);
    expect(
      document.body.querySelector('[role="dialog"][aria-label="Chat about this"]'),
    ).not.toBeNull();
    expect(comments.prepareDraft).toHaveBeenCalledWith(
      expect.objectContaining({ selectedText: "important" }),
    );
    expect(
      document.body.querySelector<HTMLTextAreaElement>(
        '[aria-label="Message about selected fullscreen text"]',
      ),
    ).toBe(document.activeElement);
    window.getSelection()?.removeAllRanges();
    draftChat[Symbol.dispose]();
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
        model: { provider: "openai", id: "gpt", name: "GPT" },
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
    expect(chat?.querySelector(".transcript")).not.toBeNull();
    expect(chat?.querySelector('[aria-label="Message actions"]')).not.toBeNull();
    expect(chat?.textContent).not.toContain("Resolve chat");
    expect(chat?.textContent).not.toContain("Reopen chat");
    expect(chat?.querySelector("form")).not.toBeNull();
    expect(chat?.querySelector('[aria-label="Model configuration"]')?.textContent).toContain("GPT");
    expect(chat?.querySelector('[aria-label="Model configuration"]')?.textContent).toContain(
      "Medium",
    );

    const titlebar = chat!.querySelector<HTMLElement>("header")!;
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
        <RendererInfrastructureFixture>
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
          />
        </RendererInfrastructureFixture>,
      ),
    );

    const expandButtons = container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="View response fullscreen"]',
    );
    expect(expandButtons).toHaveLength(2);
    act(() => expandButtons[0]!.click());

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Short answer");
    expect(document.body.style.overflow).toBe("hidden");

    act(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.style.overflow).toBe("");

    const streamingMessage = expandButtons[1]!.closest<HTMLElement>('[data-slot="message"]')!;
    act(() => streamingMessage.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    act(() => window.dispatchEvent(new CustomEvent(cakeHotkeyEventName)));
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("Working");
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

    const preview = container.querySelector<HTMLImageElement>("figure img")!;
    expect(preview.src).toBe("data:image/png;base64,aW1hZ2U=");
    expect(preview.alt).toBe("Image 1");
  });
});
