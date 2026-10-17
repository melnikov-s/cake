/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledMessage } from "../../../src/contracts/scheduled-messages/scheduled-message-data";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { applyScheduledMessageUpdate } from "../../../src/renderer/reducers/ScheduledMessageReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const sessionId = "session-one";
const messageId = "8de1a807-dc99-49ee-8d35-7a3ed20bef06";
const now = "2026-09-04T12:00:00.000Z";
const scheduled: ScheduledMessage = {
  id: messageId,
  targetSessionId: sessionId,
  text: "Check the build",
  sendAt: "2026-09-04T12:02:00.000Z",
  createdAt: now,
};

function renderScheduled(
  options: {
    initial?: boolean;
    failFirstCancel?: boolean;
    pendingCancel?: Client["scheduledMessages"]["cancel"];
  } = {},
) {
  let revision = 1;
  const schedule = vi.fn<Client["scheduledMessages"]["schedule"]>(async (input) => {
    const message = { ...input, id: messageId, createdAt: now };
    applyScheduledMessageUpdate(catalog, {
      _tag: "Event",
      revision: ++revision,
      event: { _tag: "Upserted", message },
    });
    return message;
  });
  const cancel = vi.fn<Client["scheduledMessages"]["cancel"]>(async (id, commandOptions) => {
    if (options.pendingCancel) return options.pendingCancel(id, commandOptions);
    if (options.failFirstCancel && cancel.mock.calls.length === 1)
      throw new Error("Scheduling service unavailable");
    applyScheduledMessageUpdate(catalog, {
      _tag: "Event",
      revision: ++revision,
      event: { _tag: "Removed", id },
    });
  });
  const fixture = createRendererStoreFixture({
    client: { scheduledMessages: { schedule, cancel } },
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [sessionSummary({ sessionId, projectPath: "/project" })],
  });
  const session = fixture.root.sessionRegistry.load(sessionId, "/project");
  fixture.root.navigationStore.selectProjectSession(sessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(sessionId);
  applyConversationUpdate(fixture.models.projectConversation(sessionId, "/project"), {
    _tag: "Snapshot",
    revision: 1,
    snapshot: {
      sessionId,
      sessionFile: "/project/session-one.jsonl",
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
    },
  });
  const catalog = fixture.models.scheduledMessageCatalog(sessionId);
  applyScheduledMessageUpdate(catalog, {
    _tag: "Snapshot",
    revision,
    messages: options.initial ? [scheduled] : [],
  });
  const view = render(
    <Chat
      store={session.conversationSessionStore.chatStore}
      embedded
      composerFocusEnabled={false}
    />,
  );
  return {
    user: userEvent.setup(),
    schedule,
    cancel,
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

describe("Scheduled message workflow", () => {
  it("schedules a follow-up from Chat, counts down, and removes it after cancellation", async () => {
    using fixture = renderScheduled();
    await fixture.user.type(screen.getByRole("combobox"), "/schedule 2m Check the build");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    const list = await screen.findByRole("list", { name: "Scheduled messages" });
    expect(within(list).getByText("Check the build")).toBeDefined();
    expect(within(list).getByText("sends in 2m")).toBeDefined();
    expect(screen.getByRole<HTMLTextAreaElement>("combobox").value).toBe("");
    expect(fixture.schedule).toHaveBeenCalledWith(
      {
        targetSessionId: sessionId,
        text: "Check the build",
        sendAt: scheduled.sendAt,
        createdBySessionId: sessionId,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(within(list).getByText("sends in 1m")).toBeDefined();
    await fixture.user.click(
      screen.getByRole("button", { name: "Cancel scheduled message: Check the build" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("list", { name: "Scheduled messages" })).toBeNull(),
    );
    expect(fixture.cancel).toHaveBeenCalledWith(
      messageId,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("keeps a scheduled message visible after failed cancellation and lets the user retry", async () => {
    using fixture = renderScheduled({ initial: true, failFirstCancel: true });
    await fixture.user.click(
      screen.getByRole("button", { name: "Cancel scheduled message: Check the build" }),
    );
    expect(await screen.findByText("Scheduling service unavailable")).toBeDefined();
    expect(screen.getByRole("list", { name: "Scheduled messages" })).toBeDefined();
    await fixture.user.click(
      screen.getByRole("button", { name: "Cancel scheduled message: Check the build" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("list", { name: "Scheduled messages" })).toBeNull(),
    );
    expect(screen.queryByText("Scheduling service unavailable")).toBeNull();
    expect(fixture.cancel).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid schedule without sending it and preserves the command for correction", async () => {
    using fixture = renderScheduled();
    await fixture.user.type(screen.getByRole("combobox"), "/schedule 0s Check the build");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    expect(
      await screen.findByText("Schedule time must be a valid future duration or ISO timestamp"),
    ).toBeDefined();
    expect(fixture.schedule).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLTextAreaElement>("combobox").value).toBe(
      "/schedule 0s Check the build",
    );
  });

  it("aborts an outstanding cancellation when the renderer closes without an unhandled late failure", async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    const fixture = renderScheduled({ initial: true, pendingCancel: () => pending });
    try {
      await fixture.user.click(
        screen.getByRole("button", { name: "Cancel scheduled message: Check the build" }),
      );
      expect(fixture.cancel).toHaveBeenCalledTimes(1);
    } finally {
      fixture[Symbol.dispose]();
    }
    expect(fixture.cancel.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => {
      reject(new Error("offline"));
      await pending.catch(() => undefined);
    });
  });
});
