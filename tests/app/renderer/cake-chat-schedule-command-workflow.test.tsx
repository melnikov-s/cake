/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { cakeChatBuiltinSlashCommands } from "../../../src/contracts/conversations/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { CakeChatSurface } from "../../../src/renderer/components/cake-chat-surface";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { applyScheduledMessageUpdate } from "../../../src/renderer/reducers/ScheduledMessageReducer";
import { projectRecord } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const now = "2026-10-21T22:00:00.000Z";
const messageId = "8de1a807-dc99-49ee-8d35-7a3ed20bef06";

function renderChat(sessionId: string, options: { fail?: boolean; pending?: boolean } = {}) {
  const prompt = vi.fn<Client["sessionChats"]["prompt"]>();
  const compact = vi.fn<Client["sessionChats"]["compact"]>(async () => undefined);
  const start = vi.fn<Client["cakeChats"]["start"]>();
  const schedule = vi.fn<Client["scheduledMessages"]["schedule"]>(async (input) => {
    if (options.fail) throw new Error("Scheduling service unavailable");
    const message = { ...input, id: messageId, createdAt: now };
    applyScheduledMessageUpdate(catalog, {
      _tag: "Event",
      revision: 2,
      event: { _tag: "Upserted", message },
    });
    return message;
  });
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    client: {
      artifacts: { effective: async () => [] },
      scheduledMessages: { schedule },
      sessionChats: { prompt, compact },
      cakeChats: { start },
    },
  });
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: options.pending
      ? []
      : [
          {
            sessionId,
            title: "Chat",
            ...(sessionId === CAKE_CHAT_SESSION_ID ? {} : { projectPath: "/project" }),
          },
        ],
  });
  const collection = fixture.root.cakeChatCollectionStore;
  const chat = collection.registry.load(sessionId);
  if (options.pending) collection.pendingSessions.create(sessionId);
  collection.sessionLayoutStore.showSession(sessionId);
  fixture.root.navigationStore.selectCakeChat(sessionId);
  applyConversationSnapshot(chat.model, {
    sessionId,
    sessionFile: options.pending ? "" : "/chat.sqlite",
    parts: [],
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: false,
    diagnostics: [],
    commands: cakeChatBuiltinSlashCommands,
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  });
  const catalog = fixture.models.scheduledMessageCatalog(sessionId);
  applyScheduledMessageUpdate(catalog, { _tag: "Snapshot", revision: 1, messages: [] });
  const view = render(
    <StoreProvider store={fixture.root}>
      <VirtuosoMockContext.Provider value={{ viewportHeight: 1200, itemHeight: 100 }}>
        <CakeChatSurface />
      </VirtuosoMockContext.Provider>
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    schedule,
    prompt,
    compact,
    start,
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(now);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe.each([
  ["Cake Chat", CAKE_CHAT_SESSION_ID],
  ["Project Chat", `project-chat:${"a".repeat(64)}`],
])("%s scheduling command", (_name, sessionId) => {
  it.each([
    ["2m", "2026-10-21T22:02:00.000Z"],
    ["2026-10-22T10:00:00Z", "2026-10-22T10:00:00.000Z"],
  ])(
    "dispatches /schedule %s to the durable scheduling service, not the assistant",
    async (when, sendAt) => {
      using fixture = renderChat(sessionId);
      const input = screen.getByRole("combobox");
      await fixture.user.type(input, `/schedule ${when} Check the build`);
      await fixture.user.click(screen.getByRole("button", { name: "Send" }));
      expect(fixture.schedule).toHaveBeenCalledExactlyOnceWith(
        {
          targetSessionId: sessionId,
          createdBySessionId: sessionId,
          text: "Check the build",
          sendAt,
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      const group = await screen.findByRole("group", { name: "Scheduled" });
      expect(within(group).getByText("Check the build")).toBeDefined();
      expect(screen.getByRole<HTMLTextAreaElement>("combobox").value).toBe("");
      expect(fixture.prompt).not.toHaveBeenCalled();
      expect(fixture.start).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["/schedule", "Usage: /schedule <10s|5m|2h|1d|ISO time> <message>"],
    ["/schedule 5m", "Usage: /schedule <10s|5m|2h|1d|ISO time> <message>"],
    ["/schedule 0s Check", "Schedule time must be a valid future duration or ISO timestamp"],
    ["/schedule nonsense Check", "Schedule time must be a valid future duration or ISO timestamp"],
  ])("rejects %s locally and retains the draft", async (command, error) => {
    using fixture = renderChat(sessionId);
    await fixture.user.type(screen.getByRole("combobox"), command);
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(error)).toBeDefined();
    expect(screen.getByRole<HTMLTextAreaElement>("combobox").value).toBe(command);
    expect(fixture.schedule).not.toHaveBeenCalled();
    expect(fixture.prompt).not.toHaveBeenCalled();
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("continues routing /compact through the existing conversation operation", async () => {
    using fixture = renderChat(sessionId);
    await fixture.user.type(screen.getByRole("combobox"), "/compact Keep scheduling details");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    expect(fixture.compact).toHaveBeenCalledExactlyOnceWith(
      { sessionId, instructions: "Keep scheduling details" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByRole<HTMLTextAreaElement>("combobox").value).toBe("");
    expect(fixture.schedule).not.toHaveBeenCalled();
    expect(fixture.prompt).not.toHaveBeenCalled();
  });

  it("reports scheduling failures without sending or discarding the command", async () => {
    using fixture = renderChat(sessionId, { fail: true });
    const command = "/schedule 5m Check the build";
    await fixture.user.type(screen.getByRole("combobox"), command);
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Scheduling service unavailable")).toBeDefined();
    expect(screen.getByRole<HTMLTextAreaElement>("combobox").value).toBe(command);
    expect(fixture.prompt).not.toHaveBeenCalled();
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("requires an existing conversation rather than starting one with slash text", async () => {
    using fixture = renderChat(sessionId, { pending: true });
    await fixture.user.type(screen.getByRole("combobox"), "/schedule 5m Check");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Scheduling requires an existing conversation")).toBeDefined();
    expect(fixture.schedule).not.toHaveBeenCalled();
    expect(fixture.start).not.toHaveBeenCalled();
    expect(fixture.prompt).not.toHaveBeenCalled();
  });
});
