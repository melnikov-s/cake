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
  const chatStore = (threadId: string) => {
    const current = chats.get(threadId);
    if (current) return current;
    const chat = mount(createStore(ChatStore, {
      id: () => threadId,
      parts: () => (fixture.reviewThreads ?? []).find((thread: { id: string }) => thread.id === threadId)?.messages.map((message: { id: string; role: "user" | "assistant"; body: string; status: "complete" | "streaming" }) => ({ id: message.id, kind: "text" as const, role: message.role, text: message.body, status: message.status })) ?? [],
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
  return {
    store: {
      get changes() { return fixture.workspaceChanges; },
      get selected() { return fixture.selectedWorkspaceChange; },
      get source() { return fixture.changeSource ?? "working-tree"; },
      get turns() { return fixture.changeTurns ?? []; },
      get selectedTurnId() { return fixture.selectedChangeTurnId; },
      get selectedTurn() { return (fixture.changeTurns ?? []).find((turn: { id: string }) => turn.id === fixture.selectedChangeTurnId); },
      error: undefined,
      loading: false,
      changeMatchesPath: (change: ChangedFile, path: string) => change.path === path || change.previousPath === path,
      select: fixture.selectChangeExplorerFile,
      selectSource: fixture.selectChangeSource ?? vi.fn(),
      selectTurn: fixture.selectChangeTurn ?? vi.fn(),
      focusPath: fixture.selectChangeExplorerFile,
      close: fixture.closeChangeExplorer
    } as any,
    reviews: {
      get threads() { return fixture.reviewThreads ?? []; },
      get activeThreadId() { return fixture.activeReviewThreadId; },
      set activeThreadId(value) { fixture.activeReviewThreadId = value; fixture.focusReviewThread?.(value); },
      get activeThread() { return fixture.activeReviewThread; },
      get pendingCommentCount() { return fixture.pendingReviewCommentCount ?? fixture.pendingReviewThreads?.length ?? 0; },
      threadStreaming: fixture.reviewThreadStreaming ?? (() => false),
      chatStore,
      createThread: fixture.createReviewThread,
      replyThread: fixture.replyReviewThread,
      resolveThread: fixture.resolveReviewThread,
      submitPending: fixture.sendPendingReviewComments
    } as any,
    browse: { readFile: fixture.readWorkspaceFile } as any,
    chat: { sessionTitle: fixture.sessionTitle } as any
  };
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
    act(() => container.querySelector<HTMLButtonElement>(".change-explorer-tree li button")!.click());
    expect((store as unknown as Record<string, any>).selectChangeExplorerFile).toHaveBeenCalledWith("src/app.ts");
  });

  it("shows historical changes by conversation turn without review controls", () => {
    const selectTurn = vi.fn();
    const store = {
      workspaceChanges: changes,
      selectedWorkspaceChange: changes[0],
      changeSource: "conversation-turn",
      selectedChangeTurnId: "turn-2",
      changeTurns: [
        { id: "turn-2", label: "Add the Changes source selector", capturedAt: "2026-08-16T12:00:00.000Z", fileCount: 2, additions: 42, deletions: 7 },
        { id: "turn-1", label: "Set up the explorer", capturedAt: "2026-08-16T11:00:00.000Z", fileCount: 1, additions: 10, deletions: 0 }
      ],
      sessionTitle: "Refine the plan",
      reviewThreads: [],
      reviewThreadStreaming: vi.fn(() => false),
      selectChangeExplorerFile: vi.fn(),
      selectChangeSource: vi.fn(),
      selectChangeTurn: selectTurn,
      closeChangeExplorer: vi.fn()
    } as unknown as ProjectWorkbenchStore;

    act(() => root.render(<ChangeExplorer {...explorerProps(store)} />));

    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Change source"]')?.value).toBe("conversation-turn");
    expect(container.querySelector(".change-turn-index")?.textContent).toContain("Add the Changes source selector");
    expect(container.querySelector(".change-explorer-view-toggle")).toBeNull();
    expect(container.querySelector(".review-gutter button")).toBeNull();
    const buttons = container.querySelectorAll<HTMLButtonElement>(".change-turn-index li button");
    act(() => buttons[1]!.click());
    expect(selectTurn).toHaveBeenCalledWith("turn-1");
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
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review comment"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Explain this line");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>(".review-composer button[type=submit]")!.click());

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
    expect(container.querySelector(".review-composer.inline")).not.toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review comment"]')?.placeholder).toBe("Leave a comment");
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

    act(() => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review comment"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));

    expect(container.querySelector(".review-composer")).toBeNull();
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
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review comment"]')!;
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
    const buttonTextarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review comment"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(buttonTextarea, "Button save");
      buttonTextarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>(".review-composer button[type=submit]")!.click());
    expect(createReviewThread).toHaveBeenCalledWith(expect.objectContaining({ path: "src/app.ts" }), "Button save");
  });

  it("minimizes a review thread when it is resolved", () => {
    const thread = {
      id: "review-1",
      status: "open",
      pending: false,
      anchor: { path: "src/app.ts", start: { diffLine: 1, newLine: 1 }, end: { diffLine: 1, newLine: 1 } },
      messages: [{ id: "message-1", role: "user", body: "Please simplify this", status: "complete" }]
    };
    const resolveReviewThread = vi.fn(async () => undefined);
    const store = {
      workspaceChanges: changes, selectedWorkspaceChange: changes[0], sessionTitle: "Review", reviewThreads: [thread],
      reviewThreadStreaming: vi.fn(() => false), createReviewThread: vi.fn(async () => undefined), replyReviewThread: vi.fn(async () => undefined), resolveReviewThread,
      selectChangeExplorerFile: vi.fn(), closeChangeExplorer: vi.fn()
    } as unknown as ProjectWorkbenchStore;
    act(() => root.render(<ChangeExplorer {...explorerProps(store)} />));

    act(() => container.querySelector<HTMLButtonElement>(".review-thread header button")!.click());

    expect(resolveReviewThread).toHaveBeenCalledWith("review-1");
    expect(container.querySelector(".review-thread")).toBeNull();
    expect(container.querySelector(".review-thread-resolved")?.textContent).toContain("Resolved thread");
  });

  it("submits a thread reply from the button or Enter and keeps Shift+Enter for a newline", async () => {
    const thread = {
      id: "review-1",
      status: "open",
      pending: false,
      anchor: { path: "src/app.ts", start: { diffLine: 1, newLine: 1 }, end: { diffLine: 1, newLine: 1 } },
      messages: [
        { id: "message-1", role: "user", body: "Please simplify this", status: "complete" },
        { id: "message-2", role: "assistant", body: "Done.", status: "complete" }
      ]
    };
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

  it("sends pending comments without closing Changes", () => {
    const sendPendingReviewComments = vi.fn(async () => undefined);
    const closeChangeExplorer = vi.fn();
    const store = {
      workspaceChanges: changes, selectedWorkspaceChange: changes[0], sessionTitle: "Review", reviewThreads: [],
      pendingReviewThreads: [{ id: "review-1" }], pendingReviewCommentCount: 2,
      reviewThreadStreaming: vi.fn(() => false), createReviewThread: vi.fn(async () => undefined), replyReviewThread: vi.fn(async () => undefined), resolveReviewThread: vi.fn(async () => undefined),
      selectChangeExplorerFile: vi.fn(), closeChangeExplorer, sendPendingReviewComments
    } as unknown as ProjectWorkbenchStore;
    act(() => root.render(<ChangeExplorer {...explorerProps(store)} />));

    act(() => container.querySelector<HTMLButtonElement>(".change-explorer-actions button")!.click());

    expect(sendPendingReviewComments).toHaveBeenCalledOnce();
    expect(closeChangeExplorer).not.toHaveBeenCalled();
    expect(container.querySelector(".change-explorer")).not.toBeNull();
    expect(container.querySelector(".change-explorer-actions")?.textContent).toContain("Send (2)");
  });

  it("lists review threads in the sidebar and links each one to its inline thread", () => {
    const focusReviewThread = vi.fn();
    const thread = {
      id: "review-1", status: "open", pending: true,
      anchor: { path: "src/app.ts", start: { diffLine: 1, newLine: 1 }, end: { diffLine: 1, newLine: 1 } },
      messages: [{ id: "message-1", role: "user", body: "Can you explain this?", status: "complete" }]
    };
    const store = {
      workspaceChanges: changes, selectedWorkspaceChange: changes[0], sessionTitle: "Review", reviewThreads: [thread], pendingReviewThreads: [thread], pendingReviewCommentCount: 1,
      reviewThreadStreaming: vi.fn(() => false), createReviewThread: vi.fn(async () => undefined), replyReviewThread: vi.fn(async () => undefined), resolveReviewThread: vi.fn(async () => undefined),
      selectChangeExplorerFile: vi.fn(), closeChangeExplorer: vi.fn(), sendPendingReviewComments: vi.fn(async () => undefined), focusReviewThread
    } as unknown as ProjectWorkbenchStore;
    act(() => root.render(<ChangeExplorer {...explorerProps(store)} />));

    expect(container.querySelector(".review-navigation")).toBeNull();
    expect(container.querySelector(".review-thread-index")?.textContent).toContain("Can you explain this?");
    expect(container.querySelector(".review-thread-index")?.textContent).toContain("src/app.ts · L1");
    act(() => container.querySelector<HTMLButtonElement>(".review-thread-index li button")!.click());
    expect(focusReviewThread).toHaveBeenCalledWith("review-1");
  });

  it("puts resolved threads last and renders them in the muted state", () => {
    const makeThread = (id: string, status: "open" | "resolved", body: string) => ({
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
