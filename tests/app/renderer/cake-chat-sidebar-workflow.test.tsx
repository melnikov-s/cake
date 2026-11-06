/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import {
  SubagentHandleId,
  type SubagentUpdate,
} from "../../../src/contracts/subagents/subagent-data";
import type { Client } from "../../../src/renderer/client/Client";
import { ConversationNavigator } from "../../../src/renderer/components/conversation-navigator";
import { Button } from "../../../src/renderer/components/ui/button";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import type { RootStore } from "../../../src/renderer/stores/RootStore";
import { applySubagentUpdate } from "../../../src/renderer/reducers/SubagentReducer";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { workerActivity } from "./subagent-activity-workflow-fixture";

const summary = (unread = false) => ({
  sessionId: CAKE_CHAT_SESSION_ID,
  title: "Cake Chat",
  createdAt: "2026-01-01T00:00:00Z",
  modifiedAt: "2026-01-01T00:00:00Z",
  messageCount: 2,
  resolved: false,
  unread,
});
function Surface({ root }: { root: RootStore }) {
  return (
    <>
      <StoreProvider store={root}>
        <ConversationNavigator projectPath={undefined} />
      </StoreProvider>
      <Button onClick={() => root.navigationStore.showSettings()}>Elsewhere</Button>
    </>
  );
}
function coordinator() {
  return within(
    screen
      .getByRole("button", { name: "Cake Chat" })
      .closest<HTMLElement>('[data-slot="conversation-navigator-row"]')!,
  );
}
afterEach(cleanup);

const cakeChatWorker = (overrides: Parameters<typeof workerActivity>[0] = {}) =>
  workerActivity({ parentSessionId: CAKE_CHAT_SESSION_ID, ...overrides });
const secondHandleId = SubagentHandleId.make("10000000-0000-4000-8000-000000000002");

function renderActivitySidebar() {
  const fixture = createRendererStoreFixture({
    client: { cakeChats: { open: async () => undefined } },
  });
  applySnapshot(fixture.models.cakeChatCatalog, { loaded: true, sessions: [summary()] });
  const view = render(<Surface root={fixture.root} />);
  let revision = 0;
  return {
    ...fixture,
    user: userEvent.setup(),
    publish(update: SubagentUpdate) {
      revision = Math.max(revision, update.revision);
      act(() =>
        applySubagentUpdate(
          fixture.models.subagentCatalog(CAKE_CHAT_SESSION_ID),
          CAKE_CHAT_SESSION_ID,
          update,
        ),
      );
    },
    updateWorker(activity: ReturnType<typeof cakeChatWorker>) {
      this.publish({
        _tag: "Activity",
        parentSessionId: CAKE_CHAT_SESSION_ID,
        revision: ++revision,
        activity: { ...activity, revision },
      });
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

it.each(["queued", "running"] as const)(
  "shows an owned %s worker separately from the idle coordinator",
  async (status) => {
    using fixture = renderActivitySidebar();
    fixture.updateWorker(cakeChatWorker({ status, streaming: false, parts: [] }));
    expect(screen.getByLabelText("1 running descendants")).toBeTruthy();
    expect(coordinator().getByLabelText("Idle")).toBeTruthy();
    expect(coordinator().queryByRole("img", { name: "Running" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Collapse Cake Chat" }));
    expect(screen.getByLabelText("1 running descendants")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Running" })).toBeNull();
  },
);
it.each(["complete", "error", "aborted"] as const)(
  "counts only live descendants as workers settle with %s",
  (status) => {
    using fixture = renderActivitySidebar();
    fixture.updateWorker(cakeChatWorker());
    fixture.updateWorker(cakeChatWorker({ handleId: secondHandleId }));
    expect(screen.getByLabelText("2 running descendants")).toBeTruthy();
    fixture.updateWorker(cakeChatWorker({ status, streaming: false, parts: [] }));
    expect(screen.getByLabelText("1 running descendants")).toBeTruthy();
    fixture.updateWorker(
      cakeChatWorker({ handleId: secondHandleId, status, streaming: false, parts: [] }),
    );
    expect(screen.queryByLabelText(/running descendants/)).toBeNull();
    expect(coordinator().getByLabelText("Idle")).toBeTruthy();
  },
);
it("releases worker activity on removal and authoritative replacement", () => {
  using fixture = renderActivitySidebar();
  fixture.updateWorker(cakeChatWorker());
  expect(screen.getByLabelText("1 running descendants")).toBeTruthy();
  fixture.publish({
    _tag: "Removed",
    revision: 2,
    parentSessionId: CAKE_CHAT_SESSION_ID,
    handleId: cakeChatWorker().handleId,
  });
  expect(screen.queryByLabelText(/running descendants/)).toBeNull();
  fixture.updateWorker(cakeChatWorker({ handleId: secondHandleId }));
  expect(screen.getByLabelText("1 running descendants")).toBeTruthy();
  fixture.publish({
    _tag: "Snapshot",
    revision: 4,
    parentSessionId: CAKE_CHAT_SESSION_ID,
    activities: [],
    backgroundActive: false,
  });
  expect(screen.queryByLabelText(/running descendants/)).toBeNull();
});

it.each(["complete", "failed", "aborted"] as const)(
  "projects coordinator %s settlement while elsewhere and acknowledges only completed responses",
  async (outcome) => {
    using fixture = createRendererStoreFixture({
      client: { cakeChats: { open: async () => undefined } },
    });
    applySnapshot(fixture.models.cakeChatCatalog, { loaded: true, sessions: [summary()] });
    const view = render(<Surface root={fixture.root} />);
    try {
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Cake Chat" }));
      const model = fixture.models.cakeChatConversation(CAKE_CHAT_SESSION_ID);
      const turnId = TurnId.make("00000000-0000-4000-8000-000000000001");
      act(() =>
        applyConversationUpdate(model, {
          _tag: "Event",
          revision: 1,
          event: {
            _tag: "TurnAccepted",
            sessionId: CAKE_CHAT_SESSION_ID,
            turnId,
            delivery: "prompt",
          },
        }),
      );
      expect(screen.getByRole("img", { name: "Running" })).toBeTruthy();
      await user.click(screen.getByRole("button", { name: "Elsewhere" }));
      expect(screen.getByRole("img", { name: "Running" })).toBeTruthy();
      // Observation remains pinned even when the coordinator isn't the selected surface.
      expect(fixture.root.cakeChatCollectionStore.registry.observationTargets).toContainEqual({
        sessionId: CAKE_CHAT_SESSION_ID,
        tools: fixture.root.applicationControlStore.tools(),
      });
      act(() =>
        applyConversationUpdate(model, {
          _tag: "Event",
          revision: 2,
          event: { _tag: "TurnSettled", sessionId: CAKE_CHAT_SESSION_ID, turnId, outcome },
        }),
      );
      expect(screen.queryByRole("img", { name: "Running" })).toBeNull();
      expect(
        screen.getByRole("img", { name: outcome === "complete" ? "Ready, unread" : "Error" }),
      ).toBeTruthy();
      const assertAcknowledged = () => {
        if (outcome === "complete")
          expect(coordinator().queryByRole("img", { name: "Ready, unread" })).toBeNull();
        else expect(screen.getByRole("img", { name: "Error" })).toBeTruthy();
      };
      await user.click(screen.getByRole("button", { name: /^Cake Chat/ }));
      assertAcknowledged();
      await user.click(screen.getByRole("button", { name: "Elsewhere" }));
      assertAcknowledged();
      // Delegated/independently running Project work and queued coordinator input are not its own active turn.
      act(() => {
        const worker = fixture.models.projectConversation("worker", "/project");
        worker.streaming = true;
        applyConversationUpdate(model, {
          _tag: "Event",
          revision: 3,
          event: {
            _tag: "TurnAccepted",
            sessionId: CAKE_CHAT_SESSION_ID,
            turnId: TurnId.make("00000000-0000-4000-8000-000000000003"),
            delivery: "follow-up",
          },
        });
      });
      assertAcknowledged();
    } finally {
      view.unmount();
    }
  },
);

it("acknowledges completion seen while open rather than making it unread on departure", async () => {
  using fixture = createRendererStoreFixture({
    client: { cakeChats: { open: async () => undefined } },
  });
  applySnapshot(fixture.models.cakeChatCatalog, { loaded: true, sessions: [summary()] });
  const view = render(<Surface root={fixture.root} />);
  try {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Cake Chat" }));
    const model = fixture.models.cakeChatConversation(CAKE_CHAT_SESSION_ID);
    act(() => {
      applyConversationUpdate(model, {
        _tag: "Event",
        revision: 1,
        event: { _tag: "StreamingChanged", sessionId: CAKE_CHAT_SESSION_ID, streaming: true },
      });
    });
    expect(screen.getByRole("img", { name: "Running" })).toBeTruthy();
    act(() => {
      applyConversationUpdate(model, {
        _tag: "Event",
        revision: 2,
        event: { _tag: "StreamingChanged", sessionId: CAKE_CHAT_SESSION_ID, streaming: false },
      });
      applyConversationUpdate(model, {
        _tag: "Event",
        revision: 3,
        event: {
          _tag: "TurnSettled",
          sessionId: CAKE_CHAT_SESSION_ID,
          turnId: TurnId.make("00000000-0000-4000-8000-000000000002"),
          outcome: "complete",
        },
      });
    });
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(coordinator().queryByRole("img", { name: "Ready, unread" })).toBeNull();
  } finally {
    view.unmount();
  }
});

it("uses the permanent menu target, restores manual unread and clears it on opening or Mark as Read", async () => {
  let action: "mark-read" | "mark-unread" = "mark-read";
  const menu = vi.fn<Client["electron"]["showSessionContextMenu"]>(async () => ({ action }));
  const setUnread = vi.fn<Client["cakeChats"]["setUnread"]>(async ({ unread }) => {
    act(() =>
      applySnapshot(fixture.models.cakeChatCatalog, { loaded: true, sessions: [summary(unread)] }),
    );
  });
  using fixture = createRendererStoreFixture({
    client: {
      cakeChats: { open: async () => undefined, setUnread },
      electron: { showSessionContextMenu: menu },
    },
  });
  // Same authoritative persisted reminder returned to a fresh window/restart.
  applySnapshot(fixture.models.cakeChatCatalog, { loaded: true, sessions: [summary(true)] });
  const view = render(<Surface root={fixture.root} />);
  try {
    const user = userEvent.setup();
    expect(screen.getByRole("img", { name: "Ready, unread" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^Cake Chat/ }));
    await waitFor(() =>
      expect(coordinator().queryByRole("img", { name: "Ready, unread" })).toBeNull(),
    );
    expect(setUnread).toHaveBeenCalledWith(
      { unread: false, sessionId: CAKE_CHAT_SESSION_ID },
      expect.anything(),
    );
    action = "mark-unread";
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Cake Chat/ }));
    await waitFor(() =>
      expect(setUnread).toHaveBeenCalledWith(
        { unread: true, sessionId: CAKE_CHAT_SESSION_ID },
        expect.anything(),
      ),
    );
    expect(menu).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: CAKE_CHAT_SESSION_ID, permanent: true, unread: false }),
      expect.anything(),
    );
    expect(screen.getByRole("img", { name: "Ready, unread" })).toBeTruthy();
    action = "mark-read";
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Cake Chat/ }));
    await waitFor(() =>
      expect(coordinator().queryByRole("img", { name: "Ready, unread" })).toBeNull(),
    );
    expect(menu).toHaveBeenLastCalledWith(
      expect.objectContaining({ unread: true }),
      expect.anything(),
    );
    const model = fixture.models.cakeChatConversation(CAKE_CHAT_SESSION_ID);
    act(() => {
      model.streaming = true;
    });
    setUnread.mockClear();
    action = "mark-unread"; // Even a stale/native menu result cannot mark a running coordinator unread.
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Cake Chat/ }));
    await waitFor(() =>
      expect(menu).toHaveBeenLastCalledWith(
        expect.objectContaining({ unread: undefined }),
        expect.anything(),
      ),
    );
    expect(setUnread).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
});
