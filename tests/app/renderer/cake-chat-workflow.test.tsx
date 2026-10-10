/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { observer } from "r-state-tree/react";
import { afterEach, expect, it } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/ipc/cake-chat-data";
import { Chat } from "../../../src/renderer/components/chat";
import { SidebarCakeChatGroup } from "../../../src/renderer/components/sidebar-cake-chat-group";
import type { RootStore } from "../../../src/renderer/stores/RootStore";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const Surface = observer(function Surface({ root }: { root: RootStore }) {
  const chat = root.cakeChatCollectionStore.activeSession;
  return (
    <>
      <SidebarCakeChatGroup
        cakeChat={root.cakeChatCollectionStore}
        shell={root.appShellStore}
        onOpenCakeChat={(id) => void root.navigationStore.openCakeChat(id)}
      />
      {chat && (
        <Chat
          store={chat.conversationSessionStore.chatStore}
          embedded
          composerFocusEnabled={false}
        />
      )}
    </>
  );
});

afterEach(cleanup);
it("reopening the permanent assistant retains its conversation and unsent message", async () => {
  using fixture = createRendererStoreFixture();
  applySnapshot(fixture.models.cakeChatCatalog, { loaded: true, sessions: [] });
  const view = render(<Surface root={fixture.root} />);
  try {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Cake Chat$/ }));
    await user.type(
      screen.getByRole("combobox", { name: "Message Cake Chat" }),
      "Discuss my projects",
    );
    await user.click(screen.getByRole("button", { name: /^Cake Chat$/ }));
    expect(screen.getByRole("combobox", { name: "Message Cake Chat" })).toHaveProperty(
      "value",
      "Discuss my projects",
    );
    expect(fixture.root.cakeChatCollectionStore.sessionId).toBe(CAKE_CHAT_SESSION_ID);
  } finally {
    view.unmount();
  }
});
