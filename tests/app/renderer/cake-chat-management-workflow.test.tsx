/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { observer } from "r-state-tree/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_TITLE_MAX_LENGTH } from "../../../src/ipc/session-contract";
import {
  TurnId,
  type ConversationSnapshot,
} from "../../../src/domain/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import { SidebarCakeChatGroup } from "../../../src/renderer/components/sidebar-cake-chat-group";
import {
  applyConversationSnapshot,
  applyConversationUpdate,
} from "../../../src/renderer/reducers/ConversationReducer";
import type { RootStore } from "../../../src/renderer/stores/RootStore";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

const summary = (sessionId: string, title: string, resolved = false) => ({
  sessionId,
  title,
  resolved,
  createdAt: "2026-01-01T00:00:00.000Z",
  modifiedAt: "2026-01-01T00:00:00.000Z",
  messageCount: 1,
});
function conversation(sessionId: string): ConversationSnapshot {
  return {
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    parts: [],
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  };
}

const ManagementSurface = observer(function ManagementSurface({ root }: { root: RootStore }) {
  const collection = root.cakeChatCollectionStore;
  const session = collection.activeSession;
  return (
    <>
      <SidebarCakeChatGroup
        store={root.sidebarStore}
        sessionList={root.sidebarStore.sessionListStore}
        cakeChat={collection}
        shell={root.appShellStore}
        resolved={false}
        onOpenCakeChat={(id) => void root.openCakeChat(id)}
        onCreateCakeChat={() => void root.startCakeChat()}
      />
      <SidebarCakeChatGroup
        store={root.sidebarStore}
        sessionList={root.sidebarStore.sessionListStore}
        cakeChat={collection}
        shell={root.appShellStore}
        resolved
        onOpenCakeChat={(id) => void root.openCakeChat(id)}
        onCreateCakeChat={() => void root.startCakeChat()}
      />
      {session && (
        <Chat
          store={session.conversationSessionStore.chatStore}
          embedded
          composerFocusEnabled={false}
        />
      )}
    </>
  );
});

function renderManagement(
  client: TestClientOverrides = {},
  sessions = [summary("first", "First chat"), summary("second", "Second chat")],
) {
  const fixture = createRendererStoreFixture({
    client: { ...client, cakeChats: { open: async () => undefined, ...client.cakeChats } },
  });
  applySnapshot(fixture.models.cakeChatCatalog, { loaded: true, sessions });
  for (const item of sessions)
    applyConversationSnapshot(
      fixture.models.cakeChatConversation(item.sessionId),
      conversation(item.sessionId),
    );
  fixture.root.appShellStore.selectCakeChat();
  const view = render(<ManagementSurface root={fixture.root} />);
  return {
    user: userEvent.setup(),
    catalog(sessions: ReturnType<typeof summary>[]) {
      act(() => applySnapshot(fixture.models.cakeChatCatalog, { loaded: true, sessions }));
    },
    snapshot(sessionId: string) {
      act(() =>
        applyConversationUpdate(fixture.models.cakeChatConversation(sessionId), {
          _tag: "Snapshot",
          revision: 2,
          snapshot: conversation(sessionId),
        }),
      );
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

afterEach(cleanup);

describe("Cake Chat management workflows", () => {
  it("restores a resolved chat and waits for its live snapshot before sending", async () => {
    const restore = vi.fn<Client["cakeChats"]["restore"]>(async () => undefined);
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    using fixture = renderManagement({ cakeChats: { restore }, sessionChats: { prompt } }, [
      summary("resolved", "Archived chat", true),
    ]);
    await fixture.user.click(
      screen.getAllByRole("button", { name: "Expand Cake Chat resolved" })[0]!,
    );
    await fixture.user.click(screen.getByRole("button", { name: /^Archived chat / }));
    const input = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message Cake Chat" });
    await fixture.user.type(input, "Continue");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(restore).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "resolved", tools: expect.any(Array) }),
        expect.any(Object),
      ),
    );
    expect(prompt).not.toHaveBeenCalled();
    fixture.catalog([summary("resolved", "Archived chat")]);
    fixture.snapshot("resolved");
    await waitFor(() =>
      expect(prompt).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "resolved", text: "Continue" }),
        expect.any(Object),
      ),
    );
    expect(input.value).toBe("");
  });

  it("deletes an archived chat through the native session menu", async () => {
    const showSessionContextMenu = vi.fn<Client["electron"]["showSessionContextMenu"]>(
      async () => ({ action: "delete" }),
    );
    const deleteResolved = vi.fn<Client["cakeChats"]["deleteResolved"]>(async () => undefined);
    using fixture = renderManagement(
      { electron: { showSessionContextMenu }, cakeChats: { deleteResolved } },
      [summary("resolved", "Archived chat", true)],
    );
    await fixture.user.click(
      screen.getAllByRole("button", { name: "Expand Cake Chat resolved" })[0]!,
    );
    await fixture.user.pointer({
      target: screen.getByRole("button", { name: /^Archived chat / }),
      keys: "[MouseRight]",
    });
    await waitFor(() =>
      expect(deleteResolved).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "resolved" }),
        expect.any(Object),
      ),
    );
    fixture.catalog([]);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^Archived chat / })).toBeNull(),
    );
  });
  it("creates a chat from the sidebar, submits its first prompt and uses the projected identity for a follow-up", async () => {
    const start = vi.fn<Client["cakeChats"]["start"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000002"),
    );
    using fixture = renderManagement({ cakeChats: { start }, sessionChats: { prompt } }, []);
    await fixture.user.click(screen.getAllByRole("button", { name: "New Cake Chat" })[0]!);
    const input = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message Cake Chat" });
    await fixture.user.type(input, "/name Shared composer title");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("button", { name: /^Shared composer title / })).toBeDefined();
    await fixture.user.type(input, "Hello Cake");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    const request = start.mock.calls[0]![0];
    expect(request).toEqual({
      sessionId: expect.any(String),
      tools: expect.any(Array),
      text: "Hello Cake",
      renderUserMessageAsMarkdown: false,
      attachments: [],
      newSession: { name: "Shared composer title" },
    });
    fixture.catalog([summary(request.sessionId, "Authoritative title")]);
    fixture.snapshot(request.sessionId);
    expect(screen.getByRole("button", { name: /^Authoritative title / })).toBeDefined();
    await fixture.user.type(input, "Follow up");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(prompt).toHaveBeenCalledWith(
        {
          sessionId: request.sessionId,
          text: "Follow up",
          responseMode: "text",
          renderUserMessageAsMarkdown: false,
          attachments: [],
        },
        expect.any(Object),
      ),
    );
  });

  it.each(["/model invalid", "/toolcompact continue", "/name"])(
    "keeps rejected command %s available for correction",
    async (command) => {
      using fixture = renderManagement();
      await fixture.user.click(screen.getByRole("button", { name: /^First chat / }));
      const input = screen.getByRole<HTMLTextAreaElement>("combobox", {
        name: "Message Cake Chat",
      });
      await fixture.user.type(input, command);
      await fixture.user.click(screen.getByRole("button", { name: "Send" }));
      expect(input.value).toBe(command);
      expect(await screen.findByRole("button", { name: "Dismiss error" })).toBeDefined();
    },
  );

  it("retains a failed message for retry", async () => {
    const prompt = vi
      .fn<Client["sessionChats"]["prompt"]>()
      .mockRejectedValueOnce(new Error("Request failed"))
      .mockResolvedValueOnce(TurnId.make("10000000-0000-4000-8000-000000000001"));
    using fixture = renderManagement({ sessionChats: { prompt } });
    await fixture.user.click(screen.getByRole("button", { name: /^First chat / }));
    const input = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message Cake Chat" });
    await fixture.user.type(input, "Hello Cake");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Request failed")).toBeDefined();
    expect(input.value).toBe("Hello Cake");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    expect(prompt).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: "Hello Cake",
        attachments: [],
      }),
      expect.any(Object),
    );
    expect(input.value).toBe("");
  });
  it("opens the latest selected chat even when earlier open requests settle later", async () => {
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const second = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    const open = vi.fn<Client["cakeChats"]["open"]>(({ sessionId }) =>
      sessionId === "first" ? first : second,
    );
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    using fixture = renderManagement({ cakeChats: { open }, sessionChats: { prompt } });
    await fixture.user.click(screen.getByRole("button", { name: /^First chat / }));
    await fixture.user.click(screen.getByRole("button", { name: /^Second chat / }));
    await act(async () => {
      finishFirst();
      await first;
      finishSecond();
      await second;
    });
    await fixture.user.type(
      screen.getByRole("combobox", { name: "Message Cake Chat" }),
      "Continue the second chat",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(prompt).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "second", text: "Continue the second chat" }),
        expect.any(Object),
      ),
    );
    expect(open).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: /^Second chat / }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(
      screen.getByRole("button", { name: /^First chat / }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("renames through the composer and reflects the authoritative catalog title", async () => {
    const rename = vi.fn<Client["cakeChats"]["rename"]>(async () => undefined);
    using fixture = renderManagement({ cakeChats: { rename } });
    await fixture.user.click(screen.getByRole("button", { name: /^First chat / }));
    const input = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message Cake Chat" });
    const name = "x".repeat(SESSION_TITLE_MAX_LENGTH + 20);
    await fixture.user.type(input, `/name ${name}`);
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(rename).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "first",
          name: name.slice(0, SESSION_TITLE_MAX_LENGTH),
        }),
        expect.any(Object),
      ),
    );
    fixture.catalog([
      summary("first", name.slice(0, SESSION_TITLE_MAX_LENGTH)),
      summary("second", "Second chat"),
    ]);
    expect(
      screen.getByRole("button", {
        name: new RegExp(`^${name.slice(0, SESSION_TITLE_MAX_LENGTH)} `),
      }),
    ).toBeDefined();
    expect(input.value).toBe("");
  });

  it("continues queued resolution after the first request fails", async () => {
    let rejectFirst!: (reason: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const resolve = vi.fn<Client["cakeChats"]["resolve"]>(({ sessionId }) =>
      sessionId === "first" ? pending : Promise.resolve(),
    );
    using fixture = renderManagement({ cakeChats: { resolve } });
    await fixture.user.click(screen.getByRole("button", { name: /^First chat / }));
    await fixture.user.click(screen.getByRole("button", { name: "Resolve First chat" }));
    await fixture.user.click(screen.getByRole("button", { name: "Resolve Second chat" }));
    expect(resolve).toHaveBeenCalledTimes(1);
    await act(async () => {
      rejectFirst(new Error("First resolve failed"));
      await pending.catch(() => undefined);
    });
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
    expect(resolve).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionId: "second" }),
      expect.any(Object),
    );
    expect(await screen.findByText("First resolve failed")).toBeDefined();
    fixture.catalog([summary("first", "First chat"), summary("second", "Second chat", true)]);
    expect(screen.getByRole("button", { name: "Resolve First chat" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Resolve Second chat" })).toBeNull();
  });
});
