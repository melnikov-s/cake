import { describe, expect, it, vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../../src/contracts/cake-chats/cake-chat-data";
import type { Client } from "../../../../src/renderer/client/Client";
import { createRendererStoreFixture } from "../renderer-store-fixture";

// Shared delivery/queue/configuration/stop/edit paths now run through real Chat composition
// in conversation-session-workflow.test.tsx, composer-workflow.test.tsx, and
// prompt-queue-workflow.test.tsx. Child identity checks were implementation-only.
// Retained native boundary: a real composer selection/context-menu replacement requires
// Electron. This checks only profile-specific service routing, not DOM selection or focus.
describe("Conversation session native reword boundary", () => {
  it.each(["project", "cake-chat"] as const)(
    "routes selected composer text with the correct workspace context for %s",
    async (profile) => {
      const rewordComposerSelection = vi.fn<Client["workspaces"]["rewordComposerSelection"]>(
        async () => "Reworded",
      );
      using fixture = createRendererStoreFixture({
        client: { workspaces: { rewordComposerSelection } },
      });
      const session =
        profile === "project"
          ? fixture.root.sessionRegistry.load("session-1", "/project")
          : fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
      await expect(
        session.conversationSessionStore.chatStore.rewordComposerSelection("Rough wording"),
      ).resolves.toBe("Reworded");
      expect(rewordComposerSelection).toHaveBeenCalledWith(
        profile === "project"
          ? { selection: "Rough wording", prompt: undefined, workingDirectory: "/project" }
          : { selection: "Rough wording", prompt: undefined },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    },
  );
});
