/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { afterEach, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-data";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import { SidebarCakeChatGroup } from "../../../src/renderer/components/sidebar-cake-chat-group";
import { Button } from "../../../src/renderer/components/ui/button";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import type { RootStore } from "../../../src/renderer/stores/RootStore";
import { createRendererStoreFixture } from "./renderer-store-fixture";

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
  const setUnread = vi.fn<Client["cakeChats"]["setUnread"]>(async (unread) => {
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
    expect(setUnread).toHaveBeenCalledWith(false, expect.anything());
    action = "mark-unread";
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Cake Chat/ }));
    await waitFor(() => expect(setUnread).toHaveBeenCalledWith(true, expect.anything()));
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
