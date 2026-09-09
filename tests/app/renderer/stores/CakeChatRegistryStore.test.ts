import { applySnapshot, createStore } from "r-state-tree";
import { describe, expect, it } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import { CakeChatCatalog } from "../../../../src/renderer/models/CakeChatCatalog";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import { CakeChatCollectionStore } from "../../../../src/renderer/stores/CakeChatCollectionStore";
import { mountWithClient } from "../mount-with-client";

const createCollection = () => {
  const catalog = CakeChatCatalog.create({ loaded: true, sessions: [] });
  const models = RootProjection.create();
  const mounted = mountWithClient(
    createStore(CakeChatCollectionStore, {
      catalog,
      sessionModel: (sessionId) => models.cakeChat(sessionId),
      tools: () => [],
    }),
    {} as Client,
  );
  return { ...mounted, catalog, models };
};

describe("CakeChatRegistryStore", () => {
  it("preserves keyed Store identity across lookup and authoritative reconciliation", () => {
    const { root, subject: collection, catalog, models } = createCollection();
    const sessionId = collection.sessionId!;
    const session = collection.registry.find(sessionId)!;
    const conversation = session.conversationSessionStore;
    const composer = conversation.composerStore;
    const configuration = conversation.configurationStore;
    const chat = conversation.chatStore;

    expect(collection.registry.load(sessionId)).toBe(session);
    expect(session.conversationSessionStore).toBe(conversation);
    expect(conversation.composerStore).toBe(composer);
    expect(conversation.configurationStore).toBe(configuration);
    expect(conversation.chatStore).toBe(chat);
    collection.pendingSessions.markMaterialized(sessionId);
    applySnapshot(catalog, {
      loaded: true,
      sessions: [
        {
          sessionId,
          title: "Materialized",
          createdAt: "2026-09-02T10:00:00.000Z",
          modifiedAt: "2026-09-02T10:01:00.000Z",
          messageCount: 1,
          resolved: false,
        },
      ],
    });

    expect(collection.registry.find(sessionId)).toBe(session);
    expect(session.conversationSessionStore).toBe(conversation);
    expect(collection.pendingSessions.isPending(sessionId)).toBe(false);
    expect(collection.registry.observationTargets).toEqual([{ sessionId, tools: [] }]);

    root[Symbol.dispose]();
    catalog[Symbol.dispose]();
    models[Symbol.dispose]();
  });

  it("removes keyed identities explicitly", () => {
    const { root, subject: collection, catalog, models } = createCollection();
    const sessionId = collection.sessionId!;
    collection.registry.remove(sessionId);

    expect(collection.registry.find(sessionId)).toBeUndefined();
    expect(collection.registry.targets).not.toContain(sessionId);

    root[Symbol.dispose]();
    catalog[Symbol.dispose]();
    models[Symbol.dispose]();
  });
});
