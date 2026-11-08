/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscussionThread } from "../../../src/contracts/discussion-sessions/discussion-session-data";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import { SubagentActivity } from "../../../src/renderer/models/SubagentActivity";
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
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const rect = measure.call(this);
      // Even a wide workspace only gives its chat companion a narrow local area.
      if (this.getAttribute("data-slot") === "side-chat-layout") return { ...rect, width: 416 };
      if (this.tagName === "MAIN") return { ...rect, width: 1440 };
      return rect;
    },
  );
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
  vi.restoreAllMocks();
});

// Start at the complete App with real Root/Reviews/Comments/Chat/Editor Stores.
// Native text-marker geometry requires Electron; do not fabricate Range rectangles here.
describe("IDE conversation workflows", () => {
  it("opens private worker history from the header without leaving VS Code or duplicating it in Sessions", async () => {
    using fixture = renderEmbeddedEditor({ vscode: { open: async () => editorLease("a") } });
    act(() => {
      const catalog = fixture.models.subagentCatalog(editorSessionId);
      catalog.loaded = true;
      catalog.activities.push(
        SubagentActivity.create({
          parentSessionId: editorSessionId,
          handleId: "10000000-0000-4000-8000-000000000099",
          anchorPartId: "worker-start",
          task: "Review editor ownership",
          status: "complete",
          parts: [
            {
              id: "worker-answer",
              kind: "text",
              role: "assistant",
              text: "Editor ownership is intact.",
              status: "complete",
            },
          ],
        }),
      );
    });
    await fixture.user.click(screen.getByRole("button", { name: "VS Code" }));
    await waitFor(() => expect(screen.getByTitle("VS Code workspace")).toBeDefined());
    await fixture.user.click(screen.getByRole("button", { name: "Side chats and subagents, 1" }));
    const menu = within(screen.getByRole("dialog", { name: "Open side chats" }));
    expect(menu.getByText("No open side chats")).toBeTruthy();
    await fixture.user.click(menu.getByRole("button", { name: "Review editor ownership" }));
    act(() => {
      fixture.root.sessionRegistry
        .findSession(editorSessionId)!
        .subagentActivityStore.chatStore("10000000-0000-4000-8000-000000000099")!
        .transcriptInteraction.setTranscriptScrollPosition({ kind: "top" });
    });
    expect(await screen.findByText("Editor ownership is intact.")).toBeTruthy();
    expect(screen.getByTitle("VS Code workspace")).toBeDefined();
    expect(fixture.root.conversationNavigatorStore.tree(editorWorkingDirectory).total).toBe(1);
  });

  it.each(["browser", "vscode"] as const)(
    "replaces the main chat inside a narrow %s companion and dismisses without resolving",
    async (mode) => {
      const browserState = {
        sessionId: editorSessionId,
        url: "https://example.com",
        title: "Example",
        loading: false,
        canGoBack: false,
        canGoForward: false,
        inspecting: false,
      };
      const setResolved = vi.fn<Client["discussionSessions"]["setResolved"]>();
      using fixture = renderEmbeddedEditor(
        {
          vscode: { open: async () => editorLease("a") },
          browser: { open: async () => browserState, updateBounds: async () => browserState },
          discussionSessions: { setResolved },
        },
        {
          threads: [
            discussion("message"),
            {
              ...discussion("message"),
              id: "other-thread",
              sidecarSessionId: "other-sidecar",
              anchor: {
                ...discussion("message").anchor,
                selectedText: "Another selection with a very long title ".repeat(12),
              },
            },
          ],
        },
      );
      await fixture.user.type(screen.getByRole("combobox", { name: "Message" }), "Main draft");
      await fixture.user.click(screen.getByRole("button", { name: "Side chats, 2 open" }));
      await fixture.user.click(screen.getByRole("button", { name: /important detail/ }));
      await fixture.user.click(
        screen.getByRole("button", { name: mode === "browser" ? "Browser" : "VS Code" }),
      );
      const workspace =
        mode === "browser"
          ? await screen.findByLabelText("Browser viewport")
          : await screen.findByTitle("VS Code workspace");
      expect(screen.getAllByText("Editor conversation")).toHaveLength(2);
      expect(screen.queryByLabelText("Open side chats")).toBeNull();
      expect(await screen.findByText("Because it preserves state.")).toBeDefined();
      expect(screen.getByRole("combobox", { name: "Reply to selection side chat" })).toBeDefined();
      expect(screen.getByRole("combobox", { name: "Message" })).toBeDefined();
      const panel = screen.getByRole("complementary", { name: "Side chat" });
      const layout = panel.closest('[data-slot="side-chat-layout"]')!;
      expect(layout.getAttribute("data-presentation")).toBe("replacement");
      expect(layout.firstElementChild!.hasAttribute("inert")).toBe(true);
      expect(screen.queryByRole("separator", { name: "Resize side chat" })).toBeNull();
      const tabs = within(within(panel).getByRole("tablist", { name: "Side chats" }));
      expect(tabs.getAllByRole("tab")).toHaveLength(2);
      await fixture.user.type(within(panel).getByRole("combobox"), "First side draft");
      await fixture.user.click(tabs.getByRole("tab", { name: /Another selection/ }));
      expect(within(panel).getByRole("combobox")).toHaveProperty("value", "");
      await fixture.user.click(tabs.getByRole("tab", { name: "important detail" }));
      expect(within(panel).getByRole("combobox")).toHaveProperty("value", "First side draft");
      await fixture.user.click(within(panel).getByRole("button", { name: "Close side chat" }));
      expect(layout.getAttribute("data-presentation")).toBe("closed");
      expect(layout.firstElementChild!.hasAttribute("inert")).toBe(false);
      expect(screen.getByRole("combobox", { name: "Message" })).toHaveProperty(
        "value",
        "Main draft",
      );
      expect(setResolved).not.toHaveBeenCalled();
      expect(
        mode === "browser"
          ? screen.getByLabelText("Browser viewport")
          : screen.getByTitle("VS Code workspace"),
      ).toBe(workspace);
      // Existing origin navigation still returns to the main chat without leaving the tool.
      await fixture.user.click(screen.getByRole("button", { name: "Side chats, 2 open" }));
      await fixture.user.click(screen.getByRole("button", { name: /important detail/ }));
      await fixture.user.click(
        within(screen.getByRole("navigation", { name: "Conversation breadcrumb" })).getByRole(
          "button",
          { name: "Editor conversation" },
        ),
      );
      expect(screen.getByRole("combobox", { name: "Message" })).toHaveProperty(
        "value",
        "Main draft",
      );
      expect(
        mode === "browser"
          ? screen.getByLabelText("Browser viewport")
          : screen.getByTitle("VS Code workspace"),
      ).toBeDefined();
    },
  );

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
    await fixture.user.click(screen.getByRole("button", { name: "VS Code" }));
    await waitFor(() => expect(screen.getByTitle("VS Code workspace")).toBeDefined());
    fixture.nativeEvent({
      type: "embedded-editor-selection",
      workspacePath: editorWorkingDirectory,
      path: "src/main.ts",
      startLine: 2,
      endLine: 3,
    });
    await fixture.user.click(screen.getByRole("button", { name: "src/main.ts#L3-L4" }));
    await fixture.user.click(screen.getByRole("button", { name: "Open src/main.ts#L3-L4" }));
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

  it("scopes native review navigation to the active session and restores its conversation explicitly", async () => {
    using fixture = renderEmbeddedEditor(
      { vscode: { open: async () => editorLease("a") } },
      {
        threads: [discussion("file")],
      },
    );
    await fixture.user.click(screen.getByRole("button", { name: "VS Code" }));
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
    await fixture.user.click(screen.getByRole("button", { name: "Conversation" }));
    expect(screen.queryByText("Chat about selection")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Message" })).toBeDefined();
    expect(screen.getByTitle("VS Code workspace")).toBeDefined();
  });
});
