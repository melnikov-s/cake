import { afterEach, expect, it, vi } from "vitest";
import {
  CAKE_CHAT_SESSION_ID,
  cakeChatSideChatSessionId,
} from "../../../src/contracts/cake-chats/cake-chat-identity";
import { applyDiscussionCatalogUpdate } from "../../../src/renderer/reducers/DiscussionReducer";
import { createRendererStoreFixture } from "./renderer-store-fixture";

// Exercise cold owner routing without opening/focusing a real window.
afterEach(() => vi.restoreAllMocks());

it("loads the saved Side Chat owner before resolving a cold discussion navigation target", async () => {
  const sessionId = cakeChatSideChatSessionId(7);
  const lookup = vi.fn(async () => ({
    sessionId,
    parentSessionId: CAKE_CHAT_SESSION_ID,
    workingDirectory: "/home",
    threadId: "cold-thread",
    executionDirectory: "/managed/task",
    resolved: false,
  }));
  using fixture = createRendererStoreFixture({ client: { discussionSessions: { lookup } } });
  const discussions = fixture.root.discussionNavigationStore;
  expect(discussions.targetForSession(sessionId)).toBeUndefined();
  const openPrimary = vi.spyOn(discussions.props, "openPrimary").mockImplementation(async () => {
    applyDiscussionCatalogUpdate(
      fixture.models.discussionCatalog(CAKE_CHAT_SESSION_ID),
      CAKE_CHAT_SESSION_ID,
      {
        _tag: "Snapshot",
        revision: 1,
        parentSessionId: CAKE_CHAT_SESSION_ID,
        threads: [
          {
            id: "cold-thread",
            parentSessionId: CAKE_CHAT_SESSION_ID,
            workingDirectory: "/home",
            sidecarSessionId: sessionId,
            status: "open",
            createdAt: "2026-01-01",
            updatedAt: "2026-01-01",
            parts: [],
            anchor: {
              path: "Task",
              start: { diffLine: 0 },
              end: { diffLine: 0 },
              selectedText: "Task",
              contextBefore: "",
              contextAfter: "",
              diff: "",
            },
          },
        ],
      },
    );
  });
  const open = vi.spyOn(discussions, "open").mockResolvedValue(undefined);
  await discussions.openBySessionId(sessionId);
  expect(lookup).toHaveBeenCalledExactlyOnceWith(
    { sessionId },
    { signal: expect.any(AbortSignal) },
  );
  expect(openPrimary).toHaveBeenCalledExactlyOnceWith({
    kind: "cake-chat",
    sessionId: CAKE_CHAT_SESSION_ID,
  });
  expect(open).toHaveBeenCalledExactlyOnceWith({
    kind: "side-chat",
    sessionId,
    parentSessionId: CAKE_CHAT_SESSION_ID,
    threadId: "cold-thread",
  });
  expect(fixture.root.sessionCatalogStore.find(sessionId)).toBeUndefined();
});

it("does not open a Project Session fallback when a native Side Chat ownership lookup fails", async () => {
  const lookup = vi.fn(async () => {
    throw new Error("Cake could not find Side Chat");
  });
  using fixture = createRendererStoreFixture({ client: { discussionSessions: { lookup } } });
  const discussions = fixture.root.discussionNavigationStore;
  const primary = vi.spyOn(discussions.props, "openPrimary");
  await expect(discussions.openBySessionId(cakeChatSideChatSessionId(99))).rejects.toThrow(
    "could not find Side Chat",
  );
  expect(primary).not.toHaveBeenCalled();
});
