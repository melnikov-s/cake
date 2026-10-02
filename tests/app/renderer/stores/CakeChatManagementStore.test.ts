// Migration backlog: late tool-compaction completion needs a real transcript action.
// Resolution serialization is covered in ../cake-chat-management-workflow.test.tsx.
import { createStore } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import { CakeChatCatalog } from "../../../../src/renderer/models/CakeChatCatalog";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import { CakeChatCollectionStore } from "../../../../src/renderer/stores/CakeChatCollectionStore";
import { mountWithClient } from "../mount-with-client";

const mountCollection = (client: Client) => {
  const catalog = CakeChatCatalog.create({ loaded: true, sessions: [] });
  const models = RootProjection.create();
  const mounted = mountWithClient(
    createStore(CakeChatCollectionStore, {
      catalog,
      sessionModel: (sessionId) => models.cakeChatConversation(sessionId),
      controlsModel: (sessionId) => models.controlsForCakeChat(sessionId),
      tools: () => [],
    }),
    client,
  );
  return { ...mounted, catalog, models };
};

describe("CakeChatManagementStore", () => {
  it("ignores a late toolCompact result after disposal", async () => {
    let finishToolCompact!: () => void;
    const toolCompact = vi.fn(
      () =>
        new Promise<{ sessionId: string }>((resolve) => {
          finishToolCompact = () => resolve({ sessionId: "late-session" });
        }),
    );
    const {
      root,
      subject: collection,
      catalog,
      models,
    } = mountCollection({
      cakeChats: { toolCompact },
    } as unknown as Client);

    const result = collection.management.toolCompact(collection.sessionId!, "entry-1");
    root[Symbol.dispose]();
    finishToolCompact();

    await expect(result).resolves.toBe(false);
    catalog[Symbol.dispose]();
    models[Symbol.dispose]();
  });
});
