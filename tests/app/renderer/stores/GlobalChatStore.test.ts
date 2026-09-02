import { createStore } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { RendererClient } from "../../../../src/renderer/client/RendererClient";
import { CakeChatCatalog } from "../../../../src/renderer/models/CakeChatCatalog";
import { GlobalChatStore } from "../../../../src/renderer/stores/GlobalChatStore";
import { mountWithRendererClient } from "../mount-with-renderer-client";

describe("GlobalChatStore", () => {
  it("omits unset optional fields from a new Cake Chat prompt", async () => {
    const prompt = vi.fn(async () => "turn-1");
    const catalog = CakeChatCatalog.create({ loaded: false, sessions: [] });
    const { root, subject: store } = mountWithRendererClient(
      createStore(GlobalChatStore, { catalog, tools: () => [] }),
      { cakeChats: { prompt } } as unknown as RendererClient,
    );

    const initialization = store.initialize();
    catalog.loaded = true;
    await initialization;
    const session = store.activeSession;
    expect(session).toBeDefined();

    await session!.submit("Hello Cake");

    expect(prompt).toHaveBeenCalledWith(
      {
        sessionId: session!.sessionId,
        text: "Hello Cake",
        renderUserMessageAsMarkdown: false,
        attachments: [],
        newSession: { tools: [] },
      },
      expect.any(Object),
    );
    root[Symbol.dispose]();
  });
});
