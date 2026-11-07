import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-durable-ai";
import {
  Harness,
  MemoryStorage,
  UserEntry,
  createRegistry,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import { cakeChatSideChatConversationId } from "../../../../src/contracts/cake-chats/cake-chat-identity";
import { createDurableSideChats } from "../../../../src/services/pi-durable/durable-side-chats";
import { durableAnswer, durableModel, durableModels } from "../../../fixtures/durable-chat";

it("creates distinct root forks from the last settled reply while root execution and queued input stay behind", async () => {
  const context = BACKGROUND_CONTEXT;
  const { models } = durableModels();
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
  const entered = Promise.withResolvers<void>();
  const stream = createAssistantMessageEventStream();
  let release = () => {};
  try {
    const root = await harness.root(context, {
      agent: { model: { provider: "fixture", modelId: "fixture" } },
    });
    await (
      await root.submit({ type: "input", content: "Settled root history" }, context)
    ).wait(context);
    vi.mocked(models.streamSimple).mockImplementationOnce(() => {
      const partial = durableAnswer("Partial in-flight answer");
      stream.push({ type: "start", partial });
      release = () =>
        stream.push({ type: "done", reason: "stop", message: durableAnswer("Later root answer") });
      entered.resolve();
      return stream;
    });
    const active = await root.submit(
      { type: "input", content: "Unfinished root request" },
      context,
    );
    await entered.promise;
    await root.submit(
      { type: "input", content: "Queued root request", whenBusy: "followUp" },
      context,
    );
    const chats = createDurableSideChats({
      harness,
      root,
      storage,
      sessionFile: "/chat.sqlite",
      catalog: { getModel: () => durableModel },
      settings: SettingsManager.inMemory(),
      models: () => [],
      fastMode: () => false,
    });
    const firstId = await chats.fork();
    const first = await chats.open({
      sessionId: firstId,
      cwd: "/fixture",
      agentDir: "/agent",
      sessionDir: "/sessions",
      requestUi: async () => undefined,
      onEvent: () => undefined,
    });
    try {
      const snapshot = await first.snapshot();
      expect(snapshot.streaming).toBe(false);
      expect(snapshot.parts.every((part) => part.originalHistory)).toBe(true);
      expect(JSON.stringify(snapshot.parts)).toContain("Settled root history");
      expect(JSON.stringify(snapshot.parts)).not.toMatch(
        /Unfinished root request|Partial in-flight answer|Queued root request/,
      );
      await first.prompt("Private side-chat dialogue", "prompt", []);
      const secondId = await chats.fork();
      expect(secondId).not.toBe(firstId);
      for (const id of [firstId, secondId]) {
        const conversationId = cakeChatSideChatConversationId(id) as ConversationId;
        expect((await storage.conversation(conversationId, context))?.parent?.conversationId).toBe(
          root.id,
        );
      }
      const second = await chats.preview(secondId);
      expect(JSON.stringify(second?.parts)).toContain("Settled root history");
      expect(JSON.stringify(second?.parts)).not.toContain("Private side-chat dialogue");
    } finally {
      await first.dispose();
    }
    release();
    await active.wait(context);
    expect(JSON.stringify((await chats.preview(firstId))?.parts)).not.toMatch(
      /Later root answer|Queued root request/,
    );
  } finally {
    release();
    await harness.close(context);
  }
});

it("pages the complete inherited original transcript without mixing in later main history", async () => {
  const context = BACKGROUND_CONTEXT;
  const { models } = durableModels();
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
  try {
    const root = await harness.root(context, {
      agent: { model: { provider: "fixture", modelId: "fixture" } },
    });
    await root.commit(async (tx) => {
      for (let index = 0; index < 205; index++)
        await tx.appendEntry(UserEntry, root.id, {
          model: [{ role: "user", content: `Original ${index}`, timestamp: index }],
        });
    }, context);
    await (
      await root.submit({ type: "input", content: "Finish this exchange" }, context)
    ).wait(context);
    const chats = createDurableSideChats({
      harness,
      root,
      storage,
      sessionFile: "/chat.sqlite",
      catalog: { getModel: () => durableModel },
      settings: SettingsManager.inMemory(),
      models: () => [],
      fastMode: () => false,
    });
    const sessionId = await chats.fork();
    const runtime = await chats.open({
      sessionId,
      cwd: "/fixture",
      agentDir: "/agent",
      sessionDir: "/sessions",
      requestUi: async () => undefined,
      onEvent: () => undefined,
    });
    try {
      const snapshot = await runtime.snapshot();
      if (!snapshot.historyCursor || !runtime.history)
        throw new Error("Expected pageable Durable history");
      const history = await runtime.history(snapshot.historyCursor);
      const parts = [...history.parts, ...snapshot.parts];
      expect(parts.filter((part) => part.kind === "text")).toHaveLength(207);
      expect(parts.every((part) => part.originalHistory)).toBe(true);
      expect(history.cursor).toBeUndefined();
      expect(JSON.stringify(history.parts)).toContain("Original 0");
    } finally {
      await runtime.dispose();
    }
  } finally {
    await harness.close(context);
  }
});

it("does not create an empty replacement when no settled reply exists", async () => {
  const context = BACKGROUND_CONTEXT;
  const { models } = durableModels();
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
  try {
    const chats = createDurableSideChats({
      harness,
      root: await harness.root(context),
      storage,
      sessionFile: "/chat.sqlite",
      catalog: { getModel: () => durableModel },
      settings: SettingsManager.inMemory(),
      models: () => [],
      fastMode: () => false,
    });
    await expect(chats.fork()).rejects.toThrow(/reply|response|exchange/i);
  } finally {
    await harness.close(context);
  }
});
