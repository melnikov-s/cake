/**
 * @vitest-environment jsdom
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, mount } from "r-state-tree";
import type { ChangedFile } from "../../../src/ipc/session-contract";
import type { ProjectWorkbenchStore } from "../../../src/renderer/stores/ProjectWorkbenchStore";
import { ChatStore } from "../../../src/renderer/stores/ChatStore";

vi.mock("@streamdown/code", () => ({
  code: {
    getThemes: () => ["github-light", "github-dark"],
    highlight: ({ code }: { code: string }, callback: (result: unknown) => void) => {
      const result = { tokens: code.split("\n").map((line) => [{ content: line, htmlStyle: { color: "#123456", "--shiki-dark": "#abcdef" } }]) };
      callback(result);
      return result;
    }
  }
}));

import { ChangeExplorer } from "../../../src/renderer/components/change-explorer";

const changes: ChangedFile[] = [
  { path: "src/app.ts", status: "modified", additions: 1, deletions: 1, diff: "-1 const old = true;\n+1 const fresh = true;" },
  { path: "PLAN.md", status: "modified", additions: 1, deletions: 0, diff: "+1 # Plan" }
];

function explorerProps(store: ProjectWorkbenchStore) {
  const fixture = store as unknown as Record<string, any>;
  const chats = new Map<string, ChatStore>();
  let draftAnchor: any;
  const draftChat = mount(createStore(ChatStore, {
    id: () => "code-review-draft",
    parts: () => draftAnchor ? [{ id: "code-context", kind: "text" as const, role: "user" as const, text: draftAnchor.selectedText, status: "complete" as const }] : [],
    streaming: () => false,
    submitting: () => false,
    configuration: () => undefined,
    commands: () => [],
    placeholder: () => "Ask Cake about this code…",
    inputLabel: () => "Message code chat",
    canSubmit: (draft) => Boolean(draftAnchor && draft.trim()),
    submit: async (draft) => Boolean(await fixture.createReviewThread(draftAnchor, draft))
  }));
  const chatStore = (threadId: string) => {
    const current = chats.get(threadId);
    if (current) return current;
    const chat = mount(createStore(ChatStore, {
      id: () => threadId,
      parts: () => (fixture.reviewThreads ?? []).find((thread: { id: string }) => thread.id === threadId)?.uiParts ?? [],
      streaming: () => fixture.reviewThreadStreaming?.(threadId) ?? false,
      submitting: () => false,
      configuration: () => undefined,
      commands: () => [],
      placeholder: () => "Ask a follow-up…",
      inputLabel: () => "Reply to review thread",
      canSubmit: (draft) => Boolean(draft.trim()),
      submit: (draft) => fixture.replyReviewThread(threadId, draft)
    }));
    chats.set(threadId, chat);
    return chat;
  };
  const reviews = {
    get threads() { return fixture.reviewThreads ?? []; },
    get activeThreadId() { return fixture.activeReviewThreadId; },
    set activeThreadId(value) { fixture.activeReviewThreadId = value; fixture.focusReviewThread?.(value); },
    get activeThread() { return fixture.activeReviewThread; },
    get pendingCommentCount() { return fixture.pendingReviewCommentCount ?? fixture.pendingReviewThreads?.length ?? 0; },
    get draftAnchor() { return draftAnchor; },
    draftChatStore: draftChat,
    prepareDraft: (anchor: any) => { draftAnchor = anchor; draftChat.setDraft(""); },
    cancelDraft: () => { draftAnchor = undefined; draftChat.setDraft(""); },
    threadStreaming: fixture.reviewThreadStreaming ?? (() => false),
    chatStore,
    createThread: fixture.createReviewThread,
    replyThread: fixture.replyReviewThread,
    resolveThread: fixture.resolveReviewThread,
    submitPending: fixture.sendPendingReviewComments
  };
  return {
    store: {
      get changes() { return fixture.workspaceChanges; },
      get selected() { return fixture.selectedWorkspaceChange; },
      error: undefined,
      loading: false,
      changeMatchesPath: (change: ChangedFile, path: string) => change.path === path || change.previousPath === path,
      select: fixture.selectChangeExplorerFile,
      focusPath: fixture.selectChangeExplorerFile,
      close: fixture.closeChangeExplorer
    } as any,
    reviews: reviews as any,
    browse: { readFile: fixture.readWorkspaceFile } as any,
    chat: { sessionTitle: fixture.sessionTitle } as any
  };
}

function mockReviewThread(input: { id: string; status: "open" | "resolved"; pending: boolean; anchor: { path: string; start: { diffLine: number; newLine: number }; end: { diffLine: number; newLine: number } }; messages: Array<{ id: string; role: "user" | "assistant"; body: string; status: "complete" }> }) {
  const uiParts = input.messages.map((message) => ({ id: message.id, kind: "text" as const, role: message.role, text: message.body, status: message.status }));
  return { ...input, uiParts, textParts: uiParts, messageCount: uiParts.length };
}

function selectText(element: HTMLElement, text: string) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const start = node.textContent?.indexOf(text) ?? -1;
    if (start < 0) continue;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + text.length);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    return;
  }
  throw new Error(`Could not select ${text}`);
}

describe("ChangeExplorer", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("fills the app with a highlighted diff and a selectable file tree", () => {
    const store = {
      workspaceChanges: changes,
      selectedWorkspaceChange: changes[0],
      sessionTitle: "Refine the plan",
      reviewThreads: [],
      reviewThreadStreaming: vi.fn(() => false),
      createReviewThread: vi.fn(async () => undefined),
      replyReviewThread: vi.fn(async () => undefined),
      resolveReviewThread: vi.fn(async () => undefined),
      selectChangeExplorerFile: vi.fn(),
      closeChangeExplorer: vi.fn()
    } as unknown as ProjectWorkbenchStore;

    act(() => root.render(<ChangeExplorer {...explorerProps(store)} />));

    expect(container.querySelector(".change-explorer")).not.toBeNull();
    expect(container.querySelector(".change-explorer-file header")?.textContent).toContain("Refine the plan");
    expect(container.querySelector(".syntax-token")?.textContent).toContain("const old");
    expect(container.querySelector(".change-explorer-tree")?.textContent).toContain("src");
    expect(container.querySelector(".change-explorer-tree")?.textContent).toContain("PLAN.md");
    expect(container.querySelector(".change-explorer-all-diff")).not.toBeNull();
    expect(container.querySelectorAll(".change-explorer-file-section")).toHaveLength(2);
    expect(container.querySelector(".change-explorer-all-diff")?.textContent).toContain("# Plan");
    expect(container.querySelector(".review-thread-index")).toBeNull();
    expect(container.querySelector('[aria-label="Resize comments panel"]')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>(".change-explorer-tree li button")!.click());
    expect((store as unknown as Record<string, any>).selectChangeExplorerFile).toHaveBeenCalledWith("src/app.ts");
  });

  it("scrolls the full diff when a sidebar file is selected", () => {
    let selected = changes[0];
    const selectChangeExplorerFile = vi.fn((path: string) => {
      selected = changes.find((change) => change.path === path)!;
    });
    const store = {
      workspaceChanges: changes,
      get selectedWorkspaceChange() { return selected; },
      sessionTitle: "Review",
      reviewThreads: [],
      reviewThreadStreaming: vi.fn(() => false),
      createReviewThread: vi.fn(async () => undefined),
      replyReviewThread: vi.fn(async () => undefined),
      resolveReviewThread: vi.fn(async () => undefined),
      selectChangeExplorerFile,
      closeChangeExplorer: vi.fn()
    } as unknown as ProjectWorkbenchStore;
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });

    act(() => root.render(<ChangeExplorer {...explorerProps(store)} />));
    scrollIntoView.mockClear();
    const plan = [...container.querySelectorAll<HTMLButtonElement>(".change-explorer-tree li > button")].find((button) => button.textContent?.includes("PLAN.md"))!;
    act(() => plan.click());
    act(() => root.render(<ChangeExplorer {...explorerProps(store)} />));

    expect(selectChangeExplorerFile).toHaveBeenCalledWith("PLAN.md");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: undefined });
  });

  it("selects the file whose section reaches the top while scrolling the full diff", () => {
    const selectChangeExplorerFile = vi.fn();
    const store = {
      workspaceChanges: changes,
      selectedWorkspaceChange: changes[0],
      sessionTitle: "Review",
      reviewThreads: [],
      reviewThreadStreaming: vi.fn(() => false),
      createReviewThread: vi.fn(async () => undefined),
      replyReviewThread: vi.fn(async () => undefined),
      resolveReviewThread: vi.fn(async () => undefined),
      selectChangeExplorerFile,
      closeChangeExplorer: vi.fn()
    } as unknown as ProjectWorkbenchStore;

    act(() => root.render(<ChangeExplorer {...explorerProps(store)} />));
    const diff = container.querySelector<HTMLElement>(".change-explorer-all-diff")!;
    const sections = [...container.querySelectorAll<HTMLElement>(".change-explorer-file-section")];
    Object.defineProperty(diff, "getBoundingClientRect", { configurable: true, value: () => ({ top: 0 }) });
    Object.defineProperty(sections[0]!, "getBoundingClientRect", { configurable: true, value: () => ({ top: -120 }) });
    Object.defineProperty(sections[1]!, "getBoundingClientRect", { configurable: true, value: () => ({ top: 12 }) });

    act(() => diff.dispatchEvent(new Event("scroll")));

    expect(selectChangeExplorerFile).toHaveBeenCalledWith("PLAN.md");
  });

  it("keeps the full session name available when the header context is truncated", () => {
    const sessionTitle = "A very long session name that should stay on a single truncated line in the Changes header";
    const store = {
      workspaceChanges: changes,
      selectedWorkspaceChange: changes[0],
      sessionTitle,
      reviewThreads: [],
      reviewThreadStreaming: vi.fn(() => false),
      createReviewThread: vi.fn(async () => undefined),
      replyReviewThread: vi.fn(async () => undefined),
      resolveReviewThread: vi.fn(async () => undefined),
      selectChangeExplorerFile: vi.fn(),
      closeChangeExplorer: vi.fn()
    } as unknown as ProjectWorkbenchStore;

    act(() => root.render(<ChangeExplorer {...explorerProps(store)} />));

    const context = container.querySelector<HTMLElement>(".change-explorer-file > header small")!;
    expect(context.title).toContain(sessionTitle);
    expect(context.textContent).toContain(sessionTitle);
  });

  it("toggles between the diff and the full workspace file", async () => {
    const readWorkspaceFile = vi.fn(async () => "const fresh = true;\nconst unchanged = true;");
    const store = {
      workspaceChanges: changes,
      selectedWorkspaceChange: changes[0],
      sessionTitle: "Review",
      reviewThreads: [],
      reviewThreadStreaming: vi.fn(() => false),
      createReviewThread: vi.fn(async () => undefined),
      replyReviewThread: vi.fn(async () => undefined),
      resolveReviewThread: vi.fn(async () => undefined),
      selectChangeExplorerFile: vi.fn(),
      closeChangeExplorer: vi.fn(),
      readWorkspaceFile
    } as unknown as ProjectWorkbenchStore;

    act(() => root.render(<ChangeExplorer {...explorerProps(store)} />));
    expect(container.querySelector('[aria-label="Changes to src/app.ts"]')).not.toBeNull();

    await act(async () => container.querySelector<HTMLButtonElement>('.change-explorer-view-toggle button[aria-pressed="false"]')!.click());

    expect(readWorkspaceFile).toHaveBeenCalledWith("src/app.ts");
    expect(container.querySelector('[aria-label="Full file src/app.ts"]')?.textContent).toContain("const fresh = true;");
    expect(container.querySelectorAll(".change-explorer-full-file .change-explorer-line")).toHaveLength(3);
    expect(container.querySelector(".change-explorer-full-file .remove")?.textContent).toContain("−const old = true;");
    expect(container.querySelector(".change-explorer-full-file .add")?.textContent).toContain("+const fresh = true;");
    expect(container.querySelector(".change-explorer-full-file .context")?.textContent).toContain("const unchanged = true;");

    act(() => container.querySelector<HTMLButtonElement>('.change-explorer-view-toggle button:first-child')!.click());
    expect(container.querySelector('[aria-label="Changes to src/app.ts"]')).not.toBeNull();
  });

  it("adds a comment from a line in the full file view", async () => {
    const createReviewThread = vi.fn(async () => true);
    const store = {
      workspaceChanges: changes, selectedWorkspaceChange: changes[0], sessionTitle: "Review", reviewThreads: [],
      reviewThreadStreaming: vi.fn(() => false), createReviewThread, replyReviewThread: vi.fn(async () => undefined), resolveReviewThread: vi.fn(async () => undefined),
      selectChangeExplorerFile: vi.fn(), closeChangeExplorer: vi.fn(), readWorkspaceFile: vi.fn(async () => "const fresh = true;\nconst unchanged = true;")
    } as unknown as ProjectWorkbenchStore;
    act(() => root.render(<ChangeExplorer {...explorerProps(store)} />));
    await act(async () => container.querySelector<HTMLButtonElement>('.change-explorer-view-toggle button:last-child')!.click());

    act(() => container.querySelector<HTMLButtonElement>('.change-explorer-full-file .review-gutter button[aria-label="Comment on line 2"]')!.click());
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message code chat"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Explain this line");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>(".review-thread-draft button[type=submit]")!.click());

    expect(createReviewThread).toHaveBeenCalledWith(expect.objectContaining({
      path: "src/app.ts",
      view: "full",
      start: expect.objectContaining({ diffLine: 1, newLine: 2 }),
      selectedText: "const unchanged = true;",
      diff: changes[0]!.diff
    }), "Explain this line");
  });

  it("opens the same inline comment composer from a gutter line", () => {
    const store = {
      workspaceChanges: changes, selectedWorkspaceChange: changes[0], sessionTitle: "Review", reviewThreads: [],
      reviewThreadStreaming: vi.fn(() => false), createReviewThread: vi.fn(async () => undefined), replyReviewThread: vi.fn(async () => undefined), resolveReviewThread: vi.fn(async () => undefined),
      selectChangeExplorerFile: vi.fn(), closeChangeExplorer: vi.fn()
    } as unknown as ProjectWorkbenchStore;
    act(() => root.render(<ChangeExplorer {...explorerProps(store)} />));
    const add = container.querySelector<HTMLButtonElement>('.review-gutter button[aria-label="Comment on line 1"]')!;
    act(() => add.click());
    expect(container.querySelector(".review-thread-draft")).not.toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message code chat"]')?.placeholder).toBe("Ask Cake about this code…");
    expect(container.querySelector(".review-thread-draft .user-message")?.textContent).toContain("const old = true;");
  });

  it("waits for the plus button and uses the current selection as the first message", () => {
    const store = {
      workspaceChanges: changes, selectedWorkspaceChange: changes[0], sessionTitle: "Review", reviewThreads: [],
      reviewThreadStreaming: vi.fn(() => false), createReviewThread: vi.fn(async () => undefined), replyReviewThread: vi.fn(async () => undefined), resolveReviewThread: vi.fn(async () => undefined),
      selectChangeExplorerFile: vi.fn(), closeChangeExplorer: vi.fn()
    } as unknown as ProjectWorkbenchStore;
    act(() => root.render(<ChangeExplorer {...explorerProps(store)} />));
    const row = [...container.querySelectorAll<HTMLElement>(".change-explorer-line")].find((item) => item.textContent?.includes("const fresh = true;"))!;

    selectText(row, "fresh");
    act(() => row.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
    expect(container.querySelector(".review-thread-draft")).toBeNull();

    act(() => row.querySelector<HTMLButtonElement>(".review-gutter button")!.click());
    expect(container.querySelector(".review-thread-draft .user-message")?.textContent).toContain("fresh");
    expect(container.querySelector(".review-thread-draft .user-message")?.textContent).not.toContain("const fresh = true;");
  });

  it("uses the first Escape to close a comment composer without escaping the changes view", () => {
    const store = {
      workspaceChanges: changes, selectedWorkspaceChange: changes[0], sessionTitle: "Review", reviewThreads: [],
      reviewThreadStreaming: vi.fn(() => false), createReviewThread: vi.fn(async () => undefined), replyReviewThread: vi.fn(async () => undefined), resolveReviewThread: vi.fn(async () => undefined),
      selectChangeExplorerFile: vi.fn(), closeChangeExplorer: vi.fn()
    } as unknown as ProjectWorkbenchStore;
    const escaped = vi.fn();
    window.addEventListener("keydown", escaped);
    act(() => root.render(<ChangeExplorer {...explorerProps(store)} />));
    act(() => container.querySelector<HTMLButtonElement>('.review-gutter button[aria-label="Comment on line 1"]')!.click());

    act(() => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message code chat"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));

    expect(container.querySelector(".review-thread-draft")).toBeNull();
    expect(escaped).not.toHaveBeenCalled();
    expect(container.querySelector(".change-explorer")).not.toBeNull();
    window.removeEventListener("keydown", escaped);
  });

  it("saves comments with Enter and leaves Shift+Enter available for a new line", async () => {
    const createReviewThread = vi.fn(async () => undefined);
    const store = {
      workspaceChanges: changes, selectedWorkspaceChange: changes[0], sessionTitle: "Review", reviewThreads: [],
      reviewThreadStreaming: vi.fn(() => false), createReviewThread, replyReviewThread: vi.fn(async () => undefined), resolveReviewThread: vi.fn(async () => undefined),
      selectChangeExplorerFile: vi.fn(), closeChangeExplorer: vi.fn()
    } as unknown as ProjectWorkbenchStore;
    act(() => root.render(<ChangeExplorer {...explorerProps(store)} />));
    act(() => container.querySelector<HTMLButtonElement>('.review-gutter button[aria-label="Comment on line 1"]')!.click());
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message code chat"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Ship it");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const newline = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
    act(() => textarea.dispatchEvent(newline));
    expect(newline.defaultPrevented).toBe(false);
    expect(createReviewThread).not.toHaveBeenCalled();

    const save = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => textarea.dispatchEvent(save));
    expect(save.defaultPrevented).toBe(true);
    expect(createReviewThread).toHaveBeenCalledWith(expect.objectContaining({ path: "src/app.ts" }), "Ship it");

    createReviewThread.mockClear();
    act(() => container.querySelector<HTMLButtonElement>('.review-gutter button[aria-label="Comment on line 1"]')!.click());
    const buttonTextarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message code chat"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(buttonTextarea, "Button save");
      buttonTextarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>(".review-thread-draft button[type=submit]")!.click());
    expect(createReviewThread).toHaveBeenCalledWith(expect.objectContaining({ path: "src/app.ts" }), "Button save");
  });

  it("minimizes a review thread when it is resolved", () => {
    const thread = mockReviewThread({
      id: "review-1",
      status: "open",
      pending: false,
      anchor: { path: "src/app.ts", start: { diffLine: 1, newLine: 1 }, end: { diffLine: 1, newLine: 1 } },
      messages: [{ id: "message-1", role: "user", body: "Please simplify this", status: "complete" }]
    });
    const resolveReviewThread = vi.fn(async () => undefined);
    const store = {
      workspaceChanges: changes, selectedWorkspaceChange: changes[0], sessionTitle: "Review", reviewThreads: [thread],
      reviewThreadStreaming: vi.fn(() => false), createReviewThread: vi.fn(async () => undefined), replyReviewThread: vi.fn(async () => undefined), resolveReviewThread,
      selectChangeExplorerFile: vi.fn(), closeChangeExplorer: vi.fn()
    } as unknown as ProjectWorkbenchStore;
    act(() => root.render(<ChangeExplorer {...explorerProps(store)} />));

    const resolve = [...container.querySelectorAll<HTMLButtonElement>(".review-thread header button")].find((button) => button.textContent === "Resolve")!;
    act(() => resolve.click());

    expect(resolveReviewThread).toHaveBeenCalledWith("review-1");
    expect(container.querySelector(".review-thread")).toBeNull();
    expect(container.querySelector(".review-thread-collapsed")?.textContent).toContain("Review thread");
  });

  it("toggles an unresolved review thread from its header without resolving it", () => {
    const thread = mockReviewThread({
      id: "review-1",
      status: "open",
      pending: false,
      anchor: { path: "src/app.ts", start: { diffLine: 1, newLine: 1 }, end: { diffLine: 1, newLine: 1 } },
      messages: [{ id: "message-1", role: "user", body: "Please simplify this", status: "complete" }]
    });
    const resolveReviewThread = vi.fn(async () => undefined);
    const store = {
      workspaceChanges: changes, selectedWorkspaceChange: changes[0], sessionTitle: "Review", reviewThreads: [thread],
      reviewThreadStreaming: vi.fn(() => false), createReviewThread: vi.fn(async () => undefined), replyReviewThread: vi.fn(async () => undefined), resolveReviewThread,
      selectChangeExplorerFile: vi.fn(), closeChangeExplorer: vi.fn()
    } as unknown as ProjectWorkbenchStore;
    act(() => root.render(<ChangeExplorer {...explorerProps(store)} />));

    expect([...container.querySelectorAll<HTMLButtonElement>(".review-thread header button")].some((button) => button.textContent === "Minimize")).toBe(false);
    act(() => container.querySelector<HTMLButtonElement>(".review-thread-header-toggle")!.click());

    expect(resolveReviewThread).not.toHaveBeenCalled();
    expect(container.querySelector(".review-thread")).toBeNull();
    const collapsed = container.querySelector<HTMLButtonElement>(".review-thread-collapsed.open")!;
    expect(collapsed.textContent).toContain("Review thread");
    act(() => collapsed.click());
    expect(container.querySelector(".review-thread")).not.toBeNull();
    expect(resolveReviewThread).not.toHaveBeenCalled();
  });

  it("submits a thread reply from the button or Enter and keeps Shift+Enter for a newline", async () => {
    const thread = mockReviewThread({
      id: "review-1",
      status: "open",
      pending: false,
      anchor: { path: "src/app.ts", start: { diffLine: 1, newLine: 1 }, end: { diffLine: 1, newLine: 1 } },
      messages: [
        { id: "message-1", role: "user", body: "Please simplify this", status: "complete" },
        { id: "message-2", role: "assistant", body: "Done.", status: "complete" }
      ]
    });
    const replyReviewThread = vi.fn(async () => true);
    const store = {
      workspaceChanges: changes, selectedWorkspaceChange: changes[0], sessionTitle: "Review", reviewThreads: [thread],
      reviewThreadStreaming: vi.fn(() => false), createReviewThread: vi.fn(async () => true), replyReviewThread, resolveReviewThread: vi.fn(async () => true),
      selectChangeExplorerFile: vi.fn(), closeChangeExplorer: vi.fn(), focusReviewThread: vi.fn()
    } as unknown as ProjectWorkbenchStore;
    act(() => root.render(<ChangeExplorer {...explorerProps(store)} />));

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply to review thread"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "First reply");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>(".chat-embedded-composer button[type=submit]")!.click());
    expect(replyReviewThread).toHaveBeenLastCalledWith("review-1", "First reply");

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Second reply");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const newline = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
    act(() => textarea.dispatchEvent(newline));
    expect(newline.defaultPrevented).toBe(false);
    expect(replyReviewThread).toHaveBeenCalledTimes(1);

    const submit = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => textarea.dispatchEvent(submit));
    expect(submit.defaultPrevented).toBe(true);
    expect(replyReviewThread).toHaveBeenLastCalledWith("review-1", "Second reply");
  });

  it("does not expose the removed pending-comment batch action", () => {
    const sendPendingReviewComments = vi.fn(async () => undefined);
    const closeChangeExplorer = vi.fn();
    const store = {
      workspaceChanges: changes, selectedWorkspaceChange: changes[0], sessionTitle: "Review", reviewThreads: [],
      pendingReviewThreads: [{ id: "review-1" }], pendingReviewCommentCount: 2,
      reviewThreadStreaming: vi.fn(() => false), createReviewThread: vi.fn(async () => undefined), replyReviewThread: vi.fn(async () => undefined), resolveReviewThread: vi.fn(async () => undefined),
      selectChangeExplorerFile: vi.fn(), closeChangeExplorer, sendPendingReviewComments
    } as unknown as ProjectWorkbenchStore;
    act(() => root.render(<ChangeExplorer {...explorerProps(store)} />));

    expect(container.querySelector(".change-explorer-actions")?.textContent).not.toContain("Send");
    expect(sendPendingReviewComments).not.toHaveBeenCalled();
    expect(closeChangeExplorer).not.toHaveBeenCalled();
    expect(container.querySelector(".change-explorer")).not.toBeNull();
  });

  it("lists review threads in the sidebar and links each one to its inline thread", () => {
    const focusReviewThread = vi.fn();
    const thread = mockReviewThread({
      id: "review-1", status: "open", pending: true,
      anchor: { path: "src/app.ts", start: { diffLine: 1, newLine: 1 }, end: { diffLine: 1, newLine: 1 } },
      messages: [{ id: "message-1", role: "user", body: "Can you explain this?", status: "complete" }]
    });
    const store = {
      workspaceChanges: changes, selectedWorkspaceChange: changes[0], sessionTitle: "Review", reviewThreads: [thread], pendingReviewThreads: [thread], pendingReviewCommentCount: 1,
      reviewThreadStreaming: vi.fn(() => false), createReviewThread: vi.fn(async () => undefined), replyReviewThread: vi.fn(async () => undefined), resolveReviewThread: vi.fn(async () => undefined),
      selectChangeExplorerFile: vi.fn(), closeChangeExplorer: vi.fn(), sendPendingReviewComments: vi.fn(async () => undefined), focusReviewThread
    } as unknown as ProjectWorkbenchStore;
    act(() => root.render(<ChangeExplorer {...explorerProps(store)} />));

    expect(container.querySelector(".review-navigation")).toBeNull();
    expect(container.querySelector(".review-thread-index")?.textContent).toContain("Can you explain this?");
    expect(container.querySelector(".review-thread-index")?.textContent).toContain("src/app.ts · L1");
    const resizeHandle = container.querySelector<HTMLElement>('[aria-label="Resize comments panel"]')!;
    expect(resizeHandle.getAttribute("aria-orientation")).toBe("horizontal");
    expect(resizeHandle.getAttribute("aria-valuenow")).toBe("104");
    act(() => resizeHandle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    expect(container.querySelector<HTMLElement>(".change-explorer-sidebar-body")?.style.getPropertyValue("--review-panel-height")).toBe("120px");
    act(() => container.querySelector<HTMLButtonElement>(".review-thread-index li button")!.click());
    expect(focusReviewThread).toHaveBeenCalledWith("review-1");
  });

  it("puts resolved threads last and renders them in the muted state", () => {
    const makeThread = (id: string, status: "open" | "resolved", body: string) => mockReviewThread({
      id, status, pending: false,
      anchor: { path: "src/app.ts", start: { diffLine: 1, newLine: 1 }, end: { diffLine: 1, newLine: 1 } },
      messages: [{ id: `${id}-message`, role: "user", body, status: "complete" }]
    });
    const store = {
      workspaceChanges: changes, selectedWorkspaceChange: changes[0], sessionTitle: "Review",
      reviewThreads: [makeThread("resolved-1", "resolved", "Finished comment"), makeThread("open-1", "open", "Active comment")], pendingReviewThreads: [], pendingReviewCommentCount: 0,
      reviewThreadStreaming: vi.fn(() => false), createReviewThread: vi.fn(async () => undefined), replyReviewThread: vi.fn(async () => undefined), resolveReviewThread: vi.fn(async () => undefined),
      selectChangeExplorerFile: vi.fn(), closeChangeExplorer: vi.fn(), focusReviewThread: vi.fn()
    } as unknown as ProjectWorkbenchStore;
    act(() => root.render(<ChangeExplorer {...explorerProps(store)} />));

    const rows = [...container.querySelectorAll<HTMLButtonElement>(".review-thread-index li button")];
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining("Active comment"), expect.stringContaining("Finished comment")]);
    expect(rows[1]?.classList.contains("resolved")).toBe(true);
  });
});
