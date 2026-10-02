/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot, toSnapshot, type StoreSnapshot } from "r-state-tree";
import { observer } from "r-state-tree/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/domain/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import { mountRootStore } from "../../../src/renderer/bootstrap/mount-root-store";
import { Chat } from "../../../src/renderer/components/chat";
import { SidebarCakeChatGroup } from "../../../src/renderer/components/sidebar-cake-chat-group";
import { RootProjection } from "../../../src/renderer/models/RootProjection";
import type { RootStore } from "../../../src/renderer/stores/RootStore";
import { createTestClient, type TestClientOverrides } from "./test-client";

const configuration = {
  provider: "provider",
  modelId: "model",
  thinkingLevel: "medium",
  fastMode: false,
};
const savedWindow: StoreSnapshot = {
  state: {},
  children: {
    cakeChatCollectionStore: {
      state: {},
      children: {
        registry: { state: { targets: ["saved-chat"] }, children: {} },
        pendingSessions: {
          state: { conversationIds: ["saved-chat"], pendingSessionIds: ["saved-chat"] },
          children: {
            conversations: [
              {
                key: "saved-chat",
                state: {
                  name: "Saved plan",
                  configuration,
                  draftPrompt: { text: "Do this later", attachments: [], resolved: false },
                  createdAt: "2026-01-01T00:00:00.000Z",
                  modifiedAt: "2026-01-01T00:00:00.000Z",
                },
                children: {},
              },
            ],
          },
        },
      },
    },
  },
};

const DraftSurface = observer(function DraftSurface({ root }: { root: RootStore }) {
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

function renderDrafts(overrides: TestClientOverrides) {
  const client = createTestClient({
    ...overrides,
    savedDrafts: { list: async () => [], ...overrides.savedDrafts },
  });
  let models = RootProjection.create();
  applySnapshot(models.cakeChatCatalog, { loaded: true, sessions: [] });
  let root = mountRootStore(client, savedWindow, async () => undefined, models);
  let view = render(<DraftSurface root={root} />);
  return {
    user: userEvent.setup(),
    reopenWindow() {
      const snapshot = toSnapshot(root);
      view.unmount();
      root[Symbol.dispose]();
      models[Symbol.dispose]();
      models = RootProjection.create();
      applySnapshot(models.cakeChatCatalog, { loaded: true, sessions: [] });
      root = mountRootStore(client, snapshot, async () => undefined, models);
      view = render(<DraftSurface root={root} />);
    },
    materialize() {
      act(() =>
        applySnapshot(models.cakeChatCatalog, {
          loaded: true,
          sessions: [
            {
              sessionId: "saved-chat",
              title: "Authoritative plan",
              createdAt: "2026-01-01T00:00:00.000Z",
              modifiedAt: "2026-01-01T00:00:01.000Z",
              messageCount: 1,
              resolved: false,
            },
          ],
        }),
      );
    },
    [Symbol.dispose]() {
      view.unmount();
      root[Symbol.dispose]();
      models[Symbol.dispose]();
    },
  };
}

afterEach(cleanup);

describe("Cake Chat saved draft workflows", () => {
  it("restores a saved draft across window remount and activates with its name, configuration and content", async () => {
    const start = vi.fn<Client["cakeChats"]["start"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    using fixture = renderDrafts({ cakeChats: { start } });
    await fixture.user.click(screen.getByRole("button", { name: /^Saved plan / }));
    expect(screen.getByRole("button", { name: "Activate draft" })).toBeDefined();
    fixture.reopenWindow();
    expect(screen.getByRole("button", { name: /^Saved plan / })).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Activate draft" }));
    await waitFor(() =>
      expect(start).toHaveBeenCalledExactlyOnceWith(
        {
          sessionId: "saved-chat",
          tools: expect.any(Array),
          text: "Do this later",
          renderUserMessageAsMarkdown: false,
          attachments: [],
          newSession: { configuration, name: "Saved plan" },
        },
        expect.any(Object),
      ),
    );
    expect(screen.queryByRole("button", { name: "Activate draft" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Saved plan / })).toBeDefined();
    const input = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message Cake Chat" });
    await fixture.user.type(input, "Unsent follow-up");
    fixture.materialize();
    expect(screen.getAllByRole("button", { name: /^Authoritative plan / })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Saved plan / })).toBeNull();
    expect(
      screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message Cake Chat" }).value,
    ).toBe("Unsent follow-up");
  });

  it("retains failed activation content and retries without losing the saved configuration", async () => {
    const start = vi
      .fn<Client["cakeChats"]["start"]>()
      .mockRejectedValueOnce(new Error("Send failed"))
      .mockResolvedValueOnce(TurnId.make("10000000-0000-4000-8000-000000000001"));
    using fixture = renderDrafts({ cakeChats: { start } });
    await fixture.user.click(screen.getByRole("button", { name: /^Saved plan / }));
    await fixture.user.click(screen.getByRole("button", { name: "Activate draft" }));
    expect(await screen.findByText("Send failed")).toBeDefined();
    expect(
      screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message Cake Chat" }).value,
    ).toBe("Do this later");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: "Do this later",
        newSession: { configuration, name: "Saved plan" },
      }),
      expect.any(Object),
    );
  });

  it("resolves and deletes a renderer-owned draft without calling the Cake Chat backend", async () => {
    const resolve = vi.fn<Client["cakeChats"]["resolve"]>(async () => undefined);
    const deleteResolved = vi.fn<Client["cakeChats"]["deleteResolved"]>(async () => undefined);
    const showSessionContextMenu = vi.fn<Client["electron"]["showSessionContextMenu"]>(
      async () => ({ action: "delete" }),
    );
    using fixture = renderDrafts({
      cakeChats: { resolve, deleteResolved },
      electron: { showSessionContextMenu },
    });
    await fixture.user.click(screen.getByRole("button", { name: /^Saved plan / }));
    await fixture.user.click(screen.getByRole("button", { name: "Resolve Saved plan" }));
    expect(screen.queryByRole("button", { name: "Resolve Saved plan" })).toBeNull();
    await fixture.user.click(
      screen.getAllByRole("button", { name: "Expand Cake Chat resolved" })[0]!,
    );
    await fixture.user.pointer({
      target: screen.getByRole("button", { name: /^Saved plan / }),
      keys: "[MouseRight]",
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Saved plan / })).toBeNull());
    expect(screen.queryByRole("button", { name: "Activate draft" })).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    expect(deleteResolved).not.toHaveBeenCalled();
    fixture.reopenWindow();
    expect(screen.queryByRole("button", { name: /^Saved plan / })).toBeNull();
  });
});
