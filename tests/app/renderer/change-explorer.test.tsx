/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionChange } from "../../../src/ipc/session-contract";
import type { WindowStore } from "../../../src/renderer/stores/window-store";

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

const changes: SessionChange[] = [
  { id: "file:src/app.ts", toolCallId: "call-1", path: "src/app.ts", additions: 1, deletions: 1, diff: "-1 const old = true;\n+1 const fresh = true;", timestamp: new Date(0).toISOString() },
  { id: "file:PLAN.md", toolCallId: "call-2", path: "PLAN.md", additions: 1, deletions: 0, diff: "+1 # Plan", timestamp: new Date(0).toISOString() }
];

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
      sessionChanges: changes,
      selectedSessionChange: changes[0],
      sessionTitle: "Refine the plan",
      reviewThreads: [],
      reviewThreadStreaming: vi.fn(() => false),
      createReviewThread: vi.fn(async () => undefined),
      replyReviewThread: vi.fn(async () => undefined),
      resolveReviewThread: vi.fn(async () => undefined),
      selectChangeExplorerFile: vi.fn(),
      closeChangeExplorer: vi.fn()
    } as unknown as WindowStore;

    act(() => root.render(<ChangeExplorer store={store} />));

    expect(container.querySelector(".change-explorer")).not.toBeNull();
    expect(container.querySelector(".change-explorer-file header")?.textContent).toContain("Refine the plan");
    expect(container.querySelector(".syntax-token")?.textContent).toContain("const old");
    expect(container.querySelector(".change-explorer-tree")?.textContent).toContain("src");
    expect(container.querySelector(".change-explorer-tree")?.textContent).toContain("PLAN.md");
    act(() => container.querySelector<HTMLButtonElement>(".change-explorer-tree li button")!.click());
    expect(store.selectChangeExplorerFile).toHaveBeenCalledWith("src/app.ts");
  });

  it("opens the same inline comment composer from a gutter line", () => {
    const store = {
      sessionChanges: changes, selectedSessionChange: changes[0], sessionTitle: "Review", reviewThreads: [],
      reviewThreadStreaming: vi.fn(() => false), createReviewThread: vi.fn(async () => undefined), replyReviewThread: vi.fn(async () => undefined), resolveReviewThread: vi.fn(async () => undefined),
      selectChangeExplorerFile: vi.fn(), closeChangeExplorer: vi.fn()
    } as unknown as WindowStore;
    act(() => root.render(<ChangeExplorer store={store} />));
    const add = container.querySelector<HTMLButtonElement>('.review-gutter button[aria-label="Comment on line 1"]')!;
    act(() => add.click());
    expect(container.querySelector(".review-composer.inline")).not.toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review comment"]')?.placeholder).toBe("Leave a comment");
  });

  it("uses the first Escape to close a comment composer without escaping the changes view", () => {
    const store = {
      sessionChanges: changes, selectedSessionChange: changes[0], sessionTitle: "Review", reviewThreads: [],
      reviewThreadStreaming: vi.fn(() => false), createReviewThread: vi.fn(async () => undefined), replyReviewThread: vi.fn(async () => undefined), resolveReviewThread: vi.fn(async () => undefined),
      selectChangeExplorerFile: vi.fn(), closeChangeExplorer: vi.fn()
    } as unknown as WindowStore;
    const escaped = vi.fn();
    window.addEventListener("keydown", escaped);
    act(() => root.render(<ChangeExplorer store={store} />));
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
      sessionChanges: changes, selectedSessionChange: changes[0], sessionTitle: "Review", reviewThreads: [],
      reviewThreadStreaming: vi.fn(() => false), createReviewThread, replyReviewThread: vi.fn(async () => undefined), resolveReviewThread: vi.fn(async () => undefined),
      selectChangeExplorerFile: vi.fn(), closeChangeExplorer: vi.fn()
    } as unknown as WindowStore;
    act(() => root.render(<ChangeExplorer store={store} />));
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
      sessionChanges: changes, selectedSessionChange: changes[0], sessionTitle: "Review", reviewThreads: [thread],
      reviewThreadStreaming: vi.fn(() => false), createReviewThread: vi.fn(async () => undefined), replyReviewThread: vi.fn(async () => undefined), resolveReviewThread,
      selectChangeExplorerFile: vi.fn(), closeChangeExplorer: vi.fn()
    } as unknown as WindowStore;
    act(() => root.render(<ChangeExplorer store={store} />));

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
      sessionChanges: changes, selectedSessionChange: changes[0], sessionTitle: "Review", reviewThreads: [thread],
      reviewThreadStreaming: vi.fn(() => false), createReviewThread: vi.fn(async () => true), replyReviewThread, resolveReviewThread: vi.fn(async () => true),
      selectChangeExplorerFile: vi.fn(), closeChangeExplorer: vi.fn(), focusReviewThread: vi.fn()
    } as unknown as WindowStore;
    act(() => root.render(<ChangeExplorer store={store} />));

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply to review thread"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "First reply");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>(".review-reply button")!.click());
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

  it("sends pending comments from Changes and closes the view", () => {
    const sendPendingReviewComments = vi.fn(async () => undefined);
    const store = {
      sessionChanges: changes, selectedSessionChange: changes[0], sessionTitle: "Review", reviewThreads: [],
      pendingReviewThreads: [{ id: "review-1" }], pendingReviewCommentCount: 2,
      reviewThreadStreaming: vi.fn(() => false), createReviewThread: vi.fn(async () => undefined), replyReviewThread: vi.fn(async () => undefined), resolveReviewThread: vi.fn(async () => undefined),
      selectChangeExplorerFile: vi.fn(), closeChangeExplorer: vi.fn(), sendPendingReviewComments
    } as unknown as WindowStore;
    act(() => root.render(<ChangeExplorer store={store} />));

    act(() => container.querySelector<HTMLButtonElement>(".change-explorer-actions button")!.click());

    expect(sendPendingReviewComments).toHaveBeenCalledOnce();
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
      sessionChanges: changes, selectedSessionChange: changes[0], sessionTitle: "Review", reviewThreads: [thread], pendingReviewThreads: [thread], pendingReviewCommentCount: 1,
      reviewThreadStreaming: vi.fn(() => false), createReviewThread: vi.fn(async () => undefined), replyReviewThread: vi.fn(async () => undefined), resolveReviewThread: vi.fn(async () => undefined),
      selectChangeExplorerFile: vi.fn(), closeChangeExplorer: vi.fn(), sendPendingReviewComments: vi.fn(async () => undefined), focusReviewThread
    } as unknown as WindowStore;
    act(() => root.render(<ChangeExplorer store={store} />));

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
      sessionChanges: changes, selectedSessionChange: changes[0], sessionTitle: "Review",
      reviewThreads: [makeThread("resolved-1", "resolved", "Finished comment"), makeThread("open-1", "open", "Active comment")], pendingReviewThreads: [], pendingReviewCommentCount: 0,
      reviewThreadStreaming: vi.fn(() => false), createReviewThread: vi.fn(async () => undefined), replyReviewThread: vi.fn(async () => undefined), resolveReviewThread: vi.fn(async () => undefined),
      selectChangeExplorerFile: vi.fn(), closeChangeExplorer: vi.fn(), focusReviewThread: vi.fn()
    } as unknown as WindowStore;
    act(() => root.render(<ChangeExplorer store={store} />));

    const rows = [...container.querySelectorAll<HTMLButtonElement>(".review-thread-index li button")];
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining("Active comment"), expect.stringContaining("Finished comment")]);
    expect(rows[1]?.classList.contains("resolved")).toBe(true);
  });
});
