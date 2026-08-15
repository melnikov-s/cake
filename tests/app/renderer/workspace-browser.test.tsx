/**
 * @vitest-environment jsdom
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MainChatStore } from "../../../src/renderer/stores/MainChatStore";

vi.mock("@streamdown/code", () => ({
  code: {
    getThemes: () => ["github-light", "github-dark"],
    highlight: ({ code }: { code: string }, callback: (result: unknown) => void) => {
      const result = { tokens: code.split("\n").map((line) => [{ content: line, htmlStyle: { color: "#123456" } }]) };
      callback(result);
      return result;
    }
  }
}));

import { WorkspaceBrowser } from "../../../src/renderer/components/workspace-browser";

function browserProps(store: MainChatStore) {
  const fixture = store as unknown as Record<string, any>;
  return {
    store: { files: fixture.workspaceFiles, path: fixture.workspaceBrowserPath, loading: fixture.workspaceFilesLoading, readFile: fixture.readWorkspaceFile, select: fixture.selectWorkspaceFile, focusPath: fixture.focusWorkspaceReviewThread, close: fixture.closeWorkspaceBrowser } as any,
    reviews: { threads: fixture.reviewThreads ?? [], pendingCommentCount: fixture.pendingReviewCommentCount ?? 0, activeThread: fixture.activeReviewThread, createThread: fixture.createReviewThread, replyThread: fixture.replyReviewThread, resolveThread: fixture.resolveReviewThread, threadStreaming: fixture.reviewThreadStreaming ?? (() => false), submitPending: fixture.sendPendingReviewComments } as any,
    chat: { projectName: fixture.projectName } as any
  };
}

describe("WorkspaceBrowser", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it("shows the entire project tree and syntax-highlighted selected file", async () => {
    const selectWorkspaceFile = vi.fn();
    const store = {
      workspaceFiles: ["PLAN.md", "src/app.ts", "src/lib/util.ts"], workspaceBrowserPath: "src/app.ts", workspaceFilesLoading: false,
      projectName: "cake", reviewThreads: [], pendingReviewCommentCount: 0, activeReviewThread: undefined,
      readWorkspaceFile: vi.fn(async () => "const cake = true;\nexport { cake };") , selectWorkspaceFile, closeWorkspaceBrowser: vi.fn(),
      reviewThreadStreaming: vi.fn(() => false), createReviewThread: vi.fn(async () => true), replyReviewThread: vi.fn(async () => true), resolveReviewThread: vi.fn(async () => true), focusWorkspaceReviewThread: vi.fn(), sendPendingReviewComments: vi.fn()
    } as unknown as MainChatStore;

    await act(async () => root.render(<WorkspaceBrowser {...browserProps(store)} />));

    expect(container.querySelector('[aria-label="Project files"]')?.textContent).toContain("PLAN.md");
    expect(container.querySelector('[aria-label="Project files"]')?.textContent).toContain("util.ts");
    expect(container.querySelector('[aria-label="Workspace file src/app.ts"]')?.textContent).toContain("export { cake };");
    expect(container.querySelector(".syntax-token")).not.toBeNull();
    act(() => [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Project files"] li > button')].find((button) => button.textContent === "PLAN.md")!.click());
    expect(selectWorkspaceFile).toHaveBeenCalledWith("PLAN.md");
  });

  it("anchors questions to ordinary source lines rather than a diff", async () => {
    const createReviewThread = vi.fn(async () => true);
    const store = {
      workspaceFiles: ["src/app.ts"], workspaceBrowserPath: "src/app.ts", workspaceFilesLoading: false,
      projectName: "cake", reviewThreads: [], pendingReviewCommentCount: 0, activeReviewThread: undefined,
      readWorkspaceFile: vi.fn(async () => "const cake = true;"), selectWorkspaceFile: vi.fn(), closeWorkspaceBrowser: vi.fn(),
      reviewThreadStreaming: vi.fn(() => false), createReviewThread, replyReviewThread: vi.fn(async () => true), resolveReviewThread: vi.fn(async () => true), focusWorkspaceReviewThread: vi.fn(), sendPendingReviewComments: vi.fn()
    } as unknown as MainChatStore;
    await act(async () => root.render(<WorkspaceBrowser {...browserProps(store)} />));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Ask about line 1"]')!.click());
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review comment"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "What does this do?");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('.review-composer button[type="submit"]')!.click());
    expect(createReviewThread).toHaveBeenCalledWith(expect.objectContaining({ path: "src/app.ts", view: "file", start: expect.objectContaining({ newLine: 1 }), diff: "" }), "What does this do?");
  });
});
