/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { afterEach, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import {
  SubagentHandleId,
  type SubagentUpdate,
} from "../../../src/contracts/subagents/subagent-data";
import type { Client } from "../../../src/renderer/client/Client";
import { SidebarCakeChatGroup } from "../../../src/renderer/components/sidebar-cake-chat-group";
import { Button } from "../../../src/renderer/components/ui/button";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import type { RootStore } from "../../../src/renderer/stores/RootStore";
import { applySubagentUpdate } from "../../../src/renderer/reducers/SubagentReducer";
import { messageSnapshots } from "../../../src/renderer/reducers/SessionPartReducer";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { workerActivity, workerTranscript } from "./subagent-activity-workflow-fixture";

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
      <SidebarCakeChatGroup
        cakeChat={root.cakeChatCollectionStore}
        shell={root.appShellStore}
        onOpenCakeChat={(id) => void root.navigationStore.openCakeChat(id)}
      />
      <Button onClick={() => root.navigationStore.showSettings()}>Elsewhere</Button>
    </>
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
  "shows the running dot for an owned %s worker while the foreground is idle",
  async (status) => {
    using fixture = renderActivitySidebar();
    expect(screen.queryByRole("img")).toBeNull();
    fixture.publish({
      _tag: "Snapshot",
      revision: 1,
      parentSessionId: CAKE_CHAT_SESSION_ID,
      activities: [cakeChatWorker({ status, streaming: false, parts: [] })],
      backgroundActive: true,
    });
    expect(screen.getByRole("img", { name: "Running" }).classList).toContain(
      "session-status-running",
    );
    await fixture.user.click(screen.getByRole("button", { name: /^Cake Chat/ }));
    await fixture.user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.getByRole("img", { name: "Running" })).toBeTruthy();
  },
);

it.each(["complete", "error", "aborted"] as const)(
  "keeps running until every worker settles, including %s retained handles",
  (status) => {
    using fixture = renderActivitySidebar();
    fixture.updateWorker(cakeChatWorker());
    fixture.updateWorker(cakeChatWorker({ handleId: secondHandleId }));
    fixture.updateWorker(cakeChatWorker({ status, streaming: false, parts: [] }));
    expect(screen.getByRole("img", { name: "Running" })).toBeTruthy();
    fixture.updateWorker(
      cakeChatWorker({ handleId: secondHandleId, status, streaming: false, parts: [] }),
    );
    expect(screen.queryByRole("img")).toBeNull();
  },
);

it("clears released workers and replacement snapshots without counting historical or unrelated work", () => {
  using fixture = renderActivitySidebar();
  act(() => {
    // A historical start receipt alone is not evidence of live work.
    applySnapshot(fixture.models.cakeChatConversation(CAKE_CHAT_SESSION_ID), {
      parts: messageSnapshots(workerTranscript(), CAKE_CHAT_SESSION_ID),
    });
    fixture.models.projectConversation("independent", "/project").streaming = true;
    applySubagentUpdate(fixture.models.subagentCatalog("independent"), "independent", {
      _tag: "Snapshot",
      revision: 1,
      parentSessionId: "independent",
      activities: [
        workerActivity({
          parentSessionId: "independent",
          handleId: SubagentHandleId.make("10000000-0000-4000-8000-000000000003"),
        }),
      ],
      backgroundActive: true,
    });
  });
  expect(screen.queryByRole("img")).toBeNull();
  fixture.updateWorker(cakeChatWorker());
  expect(screen.getByRole("img", { name: "Running" })).toBeTruthy();
  fixture.publish({
    _tag: "Removed",
    revision: 2,
    parentSessionId: CAKE_CHAT_SESSION_ID,
    handleId: cakeChatWorker().handleId,
  });
  // Removed retains the last running payload for inspection, but releases its lifecycle.
  expect(screen.queryByRole("img")).toBeNull();
  fixture.updateWorker(cakeChatWorker({ handleId: secondHandleId }));
  expect(screen.getByRole("img", { name: "Running" })).toBeTruthy();
  fixture.publish({
    _tag: "Snapshot",
    revision: 4,
    parentSessionId: CAKE_CHAT_SESSION_ID,
    activities: [],
    backgroundActive: false,
  });
  expect(screen.queryByRole("img")).toBeNull();
});

it.each(["foreground", "subagent"] as const)(
  "keeps overlapping activity running when the %s finishes first",
  async (first) => {
    using fixture = renderActivitySidebar();
    await fixture.user.click(screen.getByRole("button", { name: "Cake Chat" }));
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
    fixture.updateWorker(cakeChatWorker());
    const settleForeground = () =>
      act(() =>
        applyConversationUpdate(model, {
          _tag: "Event",
          revision: 2,
          event: {
            _tag: "TurnSettled",
            sessionId: CAKE_CHAT_SESSION_ID,
            turnId,
            outcome: "complete",
          },
        }),
      );
    const settleWorker = () =>
      fixture.updateWorker(cakeChatWorker({ status: "complete", streaming: false, parts: [] }));
    if (first === "foreground") settleForeground();
    else settleWorker();
    expect(screen.getByRole("img", { name: "Running" })).toBeTruthy();
    if (first === "foreground") settleWorker();
    else settleForeground();
    expect(screen.queryByRole("img")).toBeNull();
  },
);

it.each(["complete", "failed", "aborted"] as const)(
  "projects coordinator %s settlement while elsewhere and clears it when read",
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
        screen.getByRole("img", { name: outcome === "failed" ? "Error" : "Ready, unread" }),
      ).toBeTruthy();
      await user.click(screen.getByRole("button", { name: /^Cake Chat/ }));
      expect(screen.queryByRole("img")).toBeNull();
      await user.click(screen.getByRole("button", { name: "Elsewhere" }));
      expect(screen.queryByRole("img")).toBeNull();
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
      expect(screen.queryByRole("img")).toBeNull();
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
    expect(screen.queryByRole("img")).toBeNull();
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
    await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
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
    await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
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
