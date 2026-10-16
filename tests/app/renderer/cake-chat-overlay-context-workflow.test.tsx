/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applySnapshot } from "r-state-tree";
import { observer } from "r-state-tree/react";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import {
  receiveCakeChatOverlayContext,
  startCakeChatOverlay,
} from "../../../src/renderer/bootstrap/start-cake-chat-overlay";
import type { Client } from "../../../src/renderer/client/Client";
import { AppNotifications } from "../../../src/renderer/components/app-notifications";
import { Chat } from "../../../src/renderer/components/chat";
import type { RootStore } from "../../../src/renderer/stores/RootStore";
import { StoreProvider } from "r-state-tree/react";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);

const Surface = observer(function Surface({ root }: { root: RootStore }) {
  const chat = root.cakeChatCollectionStore.registry.find(CAKE_CHAT_SESSION_ID);
  return (
    <StoreProvider store={root}>
      <AppNotifications />
      {chat && <Chat store={chat.conversationSessionStore.chatStore} embedded />}
    </StoreProvider>
  );
});

function overlayFixture(startScreenCapture?: Client["electron"]["startScreenCapture"]) {
  const fixture = createRendererStoreFixture({
    client: {
      cakeChats: { open: async () => undefined },
      ...(startScreenCapture ? { electron: { startScreenCapture } } : null),
    },
  });
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [{ sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" }],
  });
  fixture.root.cakeChatCollectionStore.pendingSessions.markMaterialized(CAKE_CHAT_SESSION_ID);
  const draft = () =>
    fixture.root.cakeChatCollectionStore.registry.find(CAKE_CHAT_SESSION_ID)!
      .conversationSessionStore.composerStore.draftStore;
  return { fixture, draft, [Symbol.dispose]: () => fixture[Symbol.dispose]() };
}

it("attaches another app's selection to the Cake Chat draft as a removable chip", async () => {
  using view = overlayFixture();
  const { fixture, draft } = view;
  await act(() =>
    receiveCakeChatOverlayContext(fixture.root, {
      selectedText: { text: "The quarterly numbers look off", application: "Safari" },
    }),
  );
  render(<Surface root={fixture.root} />, { wrapper: VirtuosoMockContext.Provider as never });
  expect(draft().attachments).toEqual([
    {
      kind: "text",
      name: "Selected text from Safari · 1 line",
      text: "The quarterly numbers look off",
    },
  ]);
  const chip = await screen.findByRole("button", { name: /^Selected text from Safari/ });
  expect(chip).toBeDefined();

  // Dropping down again over the same selection does not stack another chip.
  await act(() =>
    receiveCakeChatOverlayContext(fixture.root, {
      selectedText: { text: "The quarterly numbers look off", application: "Safari" },
    }),
  );
  expect(draft().attachments).toHaveLength(1);

  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: /^Remove Selected text from Safari/ }));
  await waitFor(() => expect(draft().attachments).toHaveLength(0));
});

it("explains a missing Accessibility permission without attaching anything", async () => {
  using view = overlayFixture();
  const { fixture, draft } = view;
  render(<Surface root={fixture.root} />);
  await act(() =>
    receiveCakeChatOverlayContext(fixture.root, {
      notice: "Allow Cake in System Settings → Privacy & Security → Accessibility.",
    }),
  );
  expect(await screen.findByText(/Privacy & Security → Accessibility/)).toBeDefined();
  await act(() => fixture.root.navigationStore.openCakeChat(CAKE_CHAT_SESSION_ID));
  expect(draft().attachments).toHaveLength(0);
});

it("routes overlay screenshots only to Cake Chat and attaches them to its draft", async () => {
  const startScreenCapture = vi.fn<Client["electron"]["startScreenCapture"]>(async (routing) => ({
    data: "c2NyZWVu",
    destination: routing.defaultDestination,
  }));
  using view = overlayFixture(startScreenCapture);
  const { fixture, draft } = view;
  await act(() => startCakeChatOverlay(fixture.root));
  await act(() => fixture.root.screenCaptureStore.capture());
  const routing = startScreenCapture.mock.calls[0]![0];
  expect(routing.projects).toEqual([]);
  expect(routing.defaultDestination).toEqual({
    kind: "cake-chat",
    sessionId: CAKE_CHAT_SESSION_ID,
  });
  expect(draft().attachments).toEqual([
    expect.objectContaining({ kind: "image", mimeType: "image/png", data: "c2NyZWVu" }),
  ]);
});

it("reports a denied Screen Recording permission from the overlay capture", async () => {
  const startScreenCapture = vi.fn<Client["electron"]["startScreenCapture"]>(async () => {
    throw new Error(
      "Allow Cake in System Settings → Privacy & Security → Screen & System Audio Recording, then restart Cake.",
    );
  });
  using view = overlayFixture(startScreenCapture);
  const { fixture, draft } = view;
  render(<Surface root={fixture.root} />);
  await act(() => startCakeChatOverlay(fixture.root));
  await act(() => fixture.root.screenCaptureStore.capture());
  expect(await screen.findByText(/Screen & System Audio Recording/)).toBeDefined();
  expect(draft().attachments).toHaveLength(0);
  expect(fixture.root.screenCaptureStore.busy).toBe(false);
});
