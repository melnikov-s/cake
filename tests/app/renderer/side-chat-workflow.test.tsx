/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  TurnId,
  type ConversationSnapshot,
} from "../../../src/contracts/conversations/conversation-data";
import {
  DiscussionSessionStartInput,
  type DiscussionThread,
} from "../../../src/contracts/discussion-sessions/discussion-session-data";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import { SideChatLayout } from "../../../src/renderer/components/side-chat-layout";
import { SideChatsMenu } from "../../../src/renderer/components/side-chats-menu";
import {
  applyConversationSnapshot,
  applyDiscussionSessionUpdate,
} from "../../../src/renderer/reducers/ConversationReducer";
import { applyDiscussionCatalogUpdate } from "../../../src/renderer/reducers/DiscussionReducer";
import type { MessageSelectionAnchor } from "../../../src/renderer/stores/MessageCommentsStore";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

function conversation(sessionId: string): ConversationSnapshot {
  return {
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    parts: [],
    models: [],
    model: { provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol" },
    thinkingLevel: "high",
    availableThinkingLevels: ["off", "high"],
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  };
}

function thread(id: string, title: string): DiscussionThread {
  return {
    id,
    sidecarSessionId: `sidecar-${id}`,
    parentSessionId: "parent-1",
    workingDirectory: "/project",
    anchor: {
      path: "session:parent-1",
      view: "session",
      start: { diffLine: 0 },
      end: { diffLine: 0 },
      selectedText: "",
      contextBefore: "",
      contextAfter: "",
      diff: "",
    },
    parts: [{ id: `${id}-prompt`, kind: "text", role: "user", text: title, status: "complete" }],
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function renderSideChats(
  start: Client["discussionSessions"]["start"],
  options: {
    threads?: DiscussionThread[];
    selection?: MessageSelectionAnchor;
    withoutModel?: boolean;
    streamingThreads?: readonly string[];
  } = {},
) {
  const fixture = createRendererStoreFixture({
    client: { discussionSessions: { start } },
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [
      sessionSummary({
        sessionId: "parent-1",
        projectPath: "/project",
        workingDirectory: "/project",
      }),
    ],
  });
  const session = fixture.root.sessionRegistry.load("parent-1", "/project");
  fixture.root.projectWorkbenchStore.projectOpenStore.projectPath = "/project";
  fixture.root.navigationStore.selectProjectSession("parent-1");
  const snapshot = conversation("parent-1");
  if (options.withoutModel) Object.assign(snapshot, { model: undefined });
  applyConversationSnapshot(session.model, snapshot);
  let revision = 0;
  function publish(threads: DiscussionThread[]) {
    for (const item of threads) {
      if (!item.sidecarSessionId) continue;
      const model = fixture.models.discussionConversation(item.sidecarSessionId, "/project");
      applyDiscussionSessionUpdate(model, item.sidecarSessionId, {
        _tag: "Snapshot",
        revision: revision + 1,
        snapshot: {
          identity: {
            _tag: "DiscussionSession",
            sessionId: item.sidecarSessionId,
            parentSessionId: "parent-1",
          },
          conversation: {
            ...conversation(item.sidecarSessionId),
            parts: item.parts,
            streaming: options.streamingThreads?.includes(item.id) ?? false,
          },
        },
      });
    }
    applyDiscussionCatalogUpdate(fixture.models.discussionCatalog("parent-1"), "parent-1", {
      _tag: "Snapshot",
      revision: ++revision,
      parentSessionId: "parent-1",
      threads,
    });
  }
  publish(options.threads ?? []);
  if (options.selection) {
    // Establish an already-open selection draft; native text-selection initiation is not covered here.
    session.messageCommentsStore.prepareDraft(options.selection);
    session.conversationSessionStore.sideChatStore.open({
      key: "selection-draft",
      title: "Side chat",
      eyebrow: () => "Selection",
      chatStore: session.messageCommentsStore.draftChatStore,
    });
  }
  const view = render(
    <SideChatLayout
      store={session.conversationSessionStore.sideChatStore}
      renderChat={(chat) => <Chat store={chat} embedded composerFocusEnabled={false} />}
    >
      <SideChatsMenu store={session} />
      <Chat
        store={session.conversationSessionStore.chatStore}
        embedded
        composerFocusEnabled={false}
      />
    </SideChatLayout>,
  );
  return {
    user: userEvent.setup(),
    publish(threads: DiscussionThread[]) {
      act(() => publish(threads));
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

afterEach(cleanup);

describe("Secondary conversation workflows", () => {
  it.each([false, true])(
    "creates a session-wide side chat (without model: %s) and opens it when the catalog arrives",
    async (withoutModel) => {
      const created = thread("new-thread", "Compare approaches");
      const start = vi.fn<Client["discussionSessions"]["start"]>(async (input) => {
        // Exercise the same encoder as RPC; a typed fake alone accepts explicit undefined keys.
        Schema.encodeSync(DiscussionSessionStartInput)(input);
        return {
          turnId: TurnId.make("10000000-0000-4000-8000-000000000001"),
          thread: created,
        };
      });
      using fixture = renderSideChats(start, { withoutModel });
      const input = screen.getByRole<HTMLTextAreaElement>("combobox");
      expect(screen.queryByRole("button", { name: /^Side chats,/ })).toBeNull();
      await fixture.user.type(input, "/sidechat Compare approaches");
      await fixture.user.click(screen.getByRole("button", { name: "Send" }));
      const expectedInput: DiscussionSessionStartInput = {
        parentSessionId: "parent-1",
        workingDirectory: "/project",
        text: "Compare approaches",
        anchor: created.anchor,
        annotations: [],
      };
      if (!withoutModel)
        Object.assign(expectedInput, {
          model: { provider: "openai-codex", id: "gpt-5.6-sol" },
          thinkingLevel: "high",
        });
      await waitFor(() =>
        expect(start).toHaveBeenCalledExactlyOnceWith(
          expectedInput,
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ),
      );
      expect(input.value).toBe("");
      expect(screen.queryByRole("complementary", { name: "Side chat" })).toBeNull();
      fixture.publish([created]);
      const panel = await screen.findByRole("complementary", { name: "Side chat" });
      expect(within(panel).getByRole("combobox", { name: "Reply to side chat" })).toBeDefined();
      await fixture.user.click(within(panel).getByRole("button", { name: "Close Side chat" }));
      expect(screen.queryByRole("complementary", { name: "Side chat" })).toBeNull();
      expect(screen.getByRole("combobox")).toBeDefined();
    },
  );

  it("replaces the open side chat from the session menu and can reopen it after closing", async () => {
    const start = vi.fn<Client["discussionSessions"]["start"]>();
    const first = thread("first", "First discussion");
    const second = {
      ...thread("second", "Second discussion"),
      anchor: {
        ...thread("second", "").anchor,
        view: "message" as const,
        path: "session:parent-1/message/answer",
        messageId: "answer",
        selectedText: "Selected passage",
      },
    };
    using fixture = renderSideChats(start, { threads: [first, second] });
    await fixture.user.click(screen.getByRole("button", { name: "Side chats, 2 open" }));
    await fixture.user.click(screen.getByRole("button", { name: /First discussion/ }));
    expect(screen.getByRole("combobox", { name: "Reply to side chat" })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Side chats, 2 open" }));
    await fixture.user.click(screen.getByRole("button", { name: /Selected passage/ }));
    expect(screen.getAllByRole("complementary", { name: "Side chat" })).toHaveLength(1);
    expect(screen.getByRole("combobox", { name: "Reply to selection side chat" })).toBeDefined();
    expect(screen.queryByRole("combobox", { name: "Reply to side chat" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Close Side chat" }));
    await fixture.user.click(screen.getByRole("button", { name: "Side chats, 2 open" }));
    await fixture.user.click(screen.getByRole("button", { name: /First discussion/ }));
    expect(screen.getByRole("combobox", { name: "Reply to side chat" })).toBeDefined();
    expect(start).not.toHaveBeenCalled();
  });

  it("lists only open user side chats, projects live activity, and follows catalog removal", async () => {
    const start = vi.fn<Client["discussionSessions"]["start"]>();
    const selection = {
      ...thread("selection", "Explain this"),
      anchor: {
        ...thread("selection", "").anchor,
        view: "message" as const,
        path: "session:parent-1/message/answer",
        messageId: "answer",
        selectedText: "The important selection",
      },
    };
    const resolved = { ...thread("resolved", "Resolved discussion"), status: "resolved" as const };
    const code = {
      ...thread("code", "Code discussion"),
      anchor: { ...thread("code", "").anchor, view: "file" as const, path: "src/app.ts" },
    };
    const assistant = {
      ...thread("assistant", "Assistant discussion"),
      anchor: { ...thread("assistant", "").anchor, path: "session:parent-1/assistant" },
    };
    using fixture = renderSideChats(start, {
      threads: [resolved, code, assistant, selection],
      streamingThreads: [selection.id],
    });
    await fixture.user.click(screen.getByRole("button", { name: "Side chats, 1 open" }));
    const menu = within(screen.getByLabelText("Open side chats"));
    expect(menu.getByText("Working…")).toBeDefined();
    expect(menu.queryByText(/Resolved discussion|Code discussion|Assistant discussion/)).toBeNull();
    await fixture.user.click(menu.getByRole("button", { name: /The important selection/ }));
    expect(screen.queryByLabelText("Open side chats")).toBeNull();
    const panel = within(screen.getByRole("complementary", { name: "Side chat" }));
    expect(panel.getByRole("combobox", { name: "Reply to selection side chat" })).toBeDefined();
    expect(panel.getByRole("button", { name: "Stop" })).toBeDefined();
    await fixture.user.click(panel.getByRole("button", { name: "Close Side chat" }));
    fixture.publish([resolved, code, assistant, { ...selection, status: "resolved" }]);
    expect(screen.queryByRole("button", { name: /^Side chats,/ })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Message" })).toBeDefined();
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    { artifactId: undefined, entryId: "entry-1" },
    { artifactId: undefined, entryId: undefined },
    { artifactId: "cake-s4-table", entryId: "entry-1" },
    { artifactId: "cake-s4-table", entryId: undefined },
  ])(
    "submits a selection draft ($artifactId, $entryId) and hands off to the live thread",
    async ({ artifactId, entryId }) => {
      const selection: MessageSelectionAnchor = {
        messageId: "assistant-1",
        entryId,
        selectedText: "Original selection",
        startOffset: 4,
        endOffset: 22,
        contextBefore: "The ",
        contextAfter: " matters.",
        artifactId,
      };
      const created: DiscussionThread = {
        ...thread("selection-thread", "Explain the selection"),
        anchor: {
          path: artifactId
            ? `session:parent-1/artifact/${artifactId}`
            : "session:parent-1/message/assistant-1",
          view: artifactId ? "artifact" : "message",
          start: { diffLine: 0 },
          end: { diffLine: 0 },
          selectedText: selection.selectedText,
          contextBefore: selection.contextBefore,
          contextAfter: selection.contextAfter,
          diff: "",
          startOffset: selection.startOffset,
          endOffset: selection.endOffset,
        },
      };
      if (!artifactId) Object.assign(created.anchor, { messageId: selection.messageId });
      if (entryId !== undefined) Object.assign(created.anchor, { entryId });
      const start = vi.fn<Client["discussionSessions"]["start"]>(async (input) => {
        Schema.encodeSync(DiscussionSessionStartInput)(input);
        return {
          turnId: TurnId.make("10000000-0000-4000-8000-000000000001"),
          thread: created,
        };
      });
      using fixture = renderSideChats(start, { selection });
      const input = screen.getByRole<HTMLTextAreaElement>("combobox", {
        name: "Message about selected text",
      });
      await fixture.user.type(input, "Explain the selection");
      const panel = screen.getByRole("complementary", { name: "Side chat" });
      await fixture.user.click(within(panel).getByRole("button", { name: "Send" }));
      await waitFor(() =>
        expect(start).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            text: "Explain the selection",
            anchor: created.anchor,
            annotations: [],
          }),
          expect.any(Object),
        ),
      );
      fixture.publish([created]);
      await waitFor(() =>
        expect(screen.queryByRole("combobox", { name: "Message about selected text" })).toBeNull(),
      );
      expect(
        within(panel).getByRole("combobox", { name: "Reply to selection side chat" }),
      ).toBeDefined();
    },
  );
});
