/** @vitest-environment jsdom */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscussionThread } from "../../../src/ipc/discussion-session-data";
import { TurnId } from "../../../src/ipc/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import {
  editorLease,
  editorSessionId,
  editorWorkingDirectory,
  renderEmbeddedEditor,
} from "./embedded-editor-workflow-fixture";

function discussion(view: "file" | "message"): DiscussionThread {
  const thread: DiscussionThread = {
    id: `${view}-thread`,
    sidecarSessionId: `${view}-sidecar`,
    parentSessionId: editorSessionId,
    workingDirectory: editorWorkingDirectory,
    anchor: {
      path: view === "file" ? "src/app.ts" : `session:${editorSessionId}/message/project-answer`,
      view,
      start: { diffLine: 3, newLine: 4 },
      end: { diffLine: 5, newLine: 6 },
      selectedText: "important detail",
      contextBefore: "Alpha ",
      contextAfter: ".",
      diff: "",
    },
    parts: [
      {
        id: `${view}-answer`,
        kind: "text",
        role: "assistant",
        text: "Because it preserves state.",
        status: "complete",
      },
    ],
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  if (view === "message")
    Object.assign(thread.anchor, { messageId: "project-answer", startOffset: 6, endOffset: 22 });
  return thread;
}

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.unstubAllGlobals();
});

// Start at the complete App with real Root/Reviews/Comments/Chat/Editor Stores.
// Native text-marker geometry requires Electron; do not fabricate Range rectangles here.
describe("IDE conversation workflows", () => {
  it("keeps an opened selection side chat available when entering and leaving the IDE", async () => {
    using fixture = renderEmbeddedEditor({ vscode: { open: async () => editorLease("a") } }, [
      discussion("message"),
    ]);
    // App exposes SideChatsMenu in Agent mode, not in its IDE header.
    await fixture.user.click(screen.getByRole("button", { name: "Side chats, 1 open" }));
    await fixture.user.click(screen.getByRole("button", { name: /important detail/ }));
    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    await waitFor(() => expect(screen.getByTitle("VS Code workspace")).toBeDefined());
    expect(screen.getAllByText("Editor conversation")).toHaveLength(2);
    expect(screen.queryByLabelText("Open side chats")).toBeNull();
    const panel = within(screen.getByRole("complementary", { name: "Side chat" }));
    expect(await panel.findByText("Because it preserves state.")).toBeDefined();
    expect(panel.getByRole("combobox", { name: "Reply to selection side chat" })).toBeDefined();
    expect(screen.getByRole("combobox", { name: "Message" })).toBeDefined();
    await fixture.user.click(panel.getByRole("button", { name: "Close Side chat" }));
    expect(screen.queryByRole("complementary", { name: "Side chat" })).toBeNull();
    expect(screen.getByTitle("VS Code workspace")).toBeDefined();
    expect(screen.getByRole("combobox", { name: "Message" })).toBeDefined();
  });

  it("opens captured source context in VS Code and removes it from the next message", async () => {
    const reveal = vi.fn<Client["vscode"]["reveal"]>(async () => ({
      outcome: { view: "file" },
      locations: [],
    }));
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => TurnId.make("source-turn"));
    using fixture = renderEmbeddedEditor({
      vscode: { open: async () => editorLease("a"), reveal },
      sessionChats: { prompt },
    });
    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    await waitFor(() => expect(screen.getByTitle("VS Code workspace")).toBeDefined());
    fixture.nativeEvent({
      type: "embedded-editor-selection",
      workspacePath: editorWorkingDirectory,
      path: "src/main.ts",
      startLine: 2,
      endLine: 3,
    });
    await fixture.user.click(screen.getByRole("button", { name: "src/main.ts#L3-L4" }));
    await fixture.user.click(
      screen.getByRole("button", { name: "Open src/main.ts#L3-L4 in VS Code" }),
    );
    await waitFor(() =>
      expect(reveal).toHaveBeenCalledWith(
        editorWorkingDirectory,
        expect.objectContaining({
          kind: "working-directory",
          path: "src/main.ts",
          range: { start: { line: 2 }, end: { line: 3 } },
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    await fixture.user.click(screen.getByRole("button", { name: "Remove src/main.ts#L3-L4" }));
    expect(screen.queryByRole("button", { name: "Remove src/main.ts#L3-L4" })).toBeNull();
    await fixture.user.type(
      screen.getByRole("combobox", { name: "Message" }),
      "Continue without context",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(prompt).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Continue without context", attachments: [] }),
        expect.any(Object),
      ),
    );
  });

  it("scopes native review navigation to the active session and restores project chat explicitly", async () => {
    using fixture = renderEmbeddedEditor({ vscode: { open: async () => editorLease("a") } }, [
      discussion("file"),
    ]);
    await fixture.user.click(screen.getByRole("button", { name: "Open VS Code" }));
    await waitFor(() => expect(screen.getByTitle("VS Code workspace")).toBeDefined());
    const opened = {
      type: "embedded-editor-annotation-opened" as const,
      workspacePath: editorWorkingDirectory,
      sessionId: editorSessionId,
      threadId: "file-thread",
    };
    fixture.nativeEvent({ ...opened, workspacePath: "/other-project" });
    fixture.nativeEvent({ ...opened, sessionId: "other-session" });
    expect(screen.queryByText("Chat about selection")).toBeNull();
    fixture.nativeEvent(opened);
    expect(screen.getByText("Chat about selection")).toBeDefined();
    expect(screen.getByText("src/app.ts · L4–6")).toBeDefined();
    expect(screen.getByRole("combobox", { name: "Reply to code chat" })).toBeDefined();
    expect(await screen.findByText("Because it preserves state.")).toBeDefined();
    expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Project chat" }));
    expect(screen.queryByText("Chat about selection")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Message" })).toBeDefined();
    expect(screen.getByTitle("VS Code workspace")).toBeDefined();
  });
});
