/** @vitest-environment jsdom */
import { act, cleanup, screen } from "@testing-library/react";
import type { Client } from "../../../src/renderer/client/Client";
import { afterEach, expect, it, vi } from "vitest";
import { applySnapshot, toSnapshot } from "r-state-tree";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import type { CakeChatSummary } from "../../../src/contracts/cake-chats/cake-chat-data";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { renderAppShellNavigation } from "./app-shell-navigation-fixture";

const summary: CakeChatSummary = {
  sessionId: CAKE_CHAT_SESSION_ID,
  title: "Cake Chat",
  createdAt: "2026-01-01T00:00:00Z",
  modifiedAt: "2026-01-01T00:00:00Z",
  messageCount: 1,
  running: false,
  resolved: false,
  unread: false,
};
afterEach(cleanup);

it("opens the selected chat once and accepts unsent edits before passive catalog hydration", async () => {
  const lookup = vi.fn(async () => summary);
  const open = vi.fn<Client["cakeChats"]["open"]>(async () => {});
  using fixture = renderAppShellNavigation(
    { cakeChats: { lookup, open } },
    { cakeChatCatalogLoaded: false },
  );
  const collection = fixture.root.cakeChatCollectionStore;
  const first = collection.initialize();
  expect(collection.initialize()).toBe(first);
  await act(async () => first);
  expect(fixture.models.cakeChatCatalog.loaded).toBe(false);
  expect(collection.hydrated).toBe(true);
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledTimes(1);
  const input = await screen.findByRole("combobox", { name: "Message Cake Chat" });
  await fixture.user.type(input, "Keep this unsent text");
  expect(input).toHaveProperty("value", "Keep this unsent text");
  await act(async () => {
    fixture.models.cakeChatCatalog.loaded = true;
  });
  expect(input).toHaveProperty("value", "Keep this unsent text");
  expect(open).toHaveBeenCalledTimes(1);
});

it("reconciles accepted turns for a restored pending global chat without catalog hydration or losing unsent edits", async () => {
  using original = createRendererStoreFixture({ client: { cakeChats: { open: async () => {} } } });
  await original.root.cakeChatCollectionStore.initialize();
  const collection = original.root.cakeChatCollectionStore;
  collection.pendingSessions.create(CAKE_CHAT_SESSION_ID);
  collection.activeSession?.conversationSessionStore.chatStore.setDraft("Unsent across restart");
  using restored = createRendererStoreFixture({
    snapshot: toSnapshot(original.root),
    client: { cakeChats: { lookup: async () => summary, open: async () => {} } },
  });
  await restored.root.cakeChatCollectionStore.initialize();
  expect(restored.models.cakeChatCatalog.loaded).toBe(false);
  expect(
    restored.root.cakeChatCollectionStore.pendingSessions.isPending(CAKE_CHAT_SESSION_ID),
  ).toBe(false);
  expect(
    restored.root.cakeChatCollectionStore.registry.observationTargets.map((item) => item.sessionId),
  ).toContain(CAKE_CHAT_SESSION_ID);
  expect(
    restored.root.cakeChatCollectionStore.activeSession?.conversationSessionStore.chatStore.draft,
  ).toBe("Unsent across restart");
});

it("preserves current-first catalog facts when an older exact response arrives later", async () => {
  let release: (value: CakeChatSummary) => void = () => {
    throw new Error("Missing lookup");
  };
  const setUnread = vi.fn<Client["cakeChats"]["setUnread"]>(async () => {});
  using fixture = createRendererStoreFixture({
    client: {
      cakeChats: {
        lookup: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
        setUnread,
      },
    },
  });
  applySnapshot(fixture.models.cakeChatCatalog, {
    loaded: true,
    sessions: [{ ...summary, title: "Newer catalog facts", unread: true, messageCount: 2 }],
  });
  release(summary);
  await fixture.root.cakeChatCollectionStore.initialize();
  expect(fixture.models.cakeChatCatalog.find(CAKE_CHAT_SESSION_ID)).toMatchObject({
    title: "Newer catalog facts",
    unread: true,
    messageCount: 2,
  });
  expect(setUnread).toHaveBeenCalledWith(
    { sessionId: CAKE_CHAT_SESSION_ID, unread: false },
    expect.anything(),
  );
});

it("does not reinterpret a live snapshot as an unstarted chat when an older absent-storage lookup completes", async () => {
  let release: (value: CakeChatSummary) => void = () => {
    throw new Error("Missing lookup");
  };
  using fixture = createRendererStoreFixture({
    client: {
      cakeChats: {
        lookup: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      },
    },
  });
  const collection = fixture.root.cakeChatCollectionStore;
  const model = fixture.models.cakeChatConversation(CAKE_CHAT_SESSION_ID);
  model.sessionFile = "/chat.sqlite";
  model.observedSnapshotRevision = 1;
  release({ ...summary, unstarted: true, messageCount: 0 });
  await collection.initialize();
  expect(collection.pendingSessions.isPending(CAKE_CHAT_SESSION_ID)).toBe(false);
  expect(collection.registry.observationTargets.map((item) => item.sessionId)).toContain(
    CAKE_CHAT_SESSION_ID,
  );
});

it("preserves unstarted global configuration and unsent text across exact initialization", async () => {
  using original = createRendererStoreFixture();
  await original.root.cakeChatCollectionStore.initialize();
  const pending =
    original.root.cakeChatCollectionStore.pendingSessions.conversation(CAKE_CHAT_SESSION_ID);
  if (!pending) throw new Error("Expected unstarted global chat");
  pending.setConfiguration({
    provider: "fixture",
    modelId: "kept",
    thinkingLevel: "off",
    fastMode: false,
  });
  original.root.cakeChatCollectionStore.activeSession?.conversationSessionStore.chatStore.setDraft(
    "Not submitted",
  );
  using restored = createRendererStoreFixture({ snapshot: toSnapshot(original.root) });
  await restored.root.cakeChatCollectionStore.initialize();
  expect(
    restored.root.cakeChatCollectionStore.pendingSessions.configuration(CAKE_CHAT_SESSION_ID),
  ).toMatchObject({ modelId: "kept" });
  expect(
    restored.root.cakeChatCollectionStore.activeSession?.conversationSessionStore.chatStore.draft,
  ).toBe("Not submitted");
});

it("a late exact lookup cannot reopen the startup chat after another selection", async () => {
  let release: (summary: CakeChatSummary) => void = () => {
    throw new Error("Missing lookup");
  };
  const open = vi.fn<Client["cakeChats"]["open"]>(async () => {});
  using fixture = createRendererStoreFixture({
    client: {
      cakeChats: {
        lookup: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
        open,
      },
    },
  });
  const collection = fixture.root.cakeChatCollectionStore;
  const initialization = collection.initialize();
  await collection.open("another-chat");
  release(summary);
  await initialization;
  expect(collection.sessionId).toBe("another-chat");
  expect(open).toHaveBeenCalledTimes(1);
  expect(open.mock.calls[0]?.[0]).toMatchObject({ sessionId: "another-chat" });
});

it("disposal aborts the exact lookup and prevents late catalog or selection commits", async () => {
  let release: (summary: CakeChatSummary) => void = () => {
    throw new Error("Missing lookup");
  };
  let signal: AbortSignal | undefined;
  const open = vi.fn(async () => {});
  const fixture = createRendererStoreFixture({
    client: {
      cakeChats: {
        lookup: (_query, options) => {
          signal = options?.signal;
          return new Promise((resolve) => {
            release = resolve;
          });
        },
        open,
      },
    },
  });
  const collection = fixture.root.cakeChatCollectionStore;
  const initialization = collection.initialize();
  fixture.root[Symbol.dispose]();
  expect(signal?.aborted).toBe(true);
  release(summary);
  await initialization;
  expect(fixture.models.cakeChatCatalog.sessions).toHaveLength(0);
  expect(open).not.toHaveBeenCalled();
  fixture.models[Symbol.dispose]();
});
