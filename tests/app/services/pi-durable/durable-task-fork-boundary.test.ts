import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-durable-ai";
import { createEditTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { expect, it } from "vitest";
import { createDurableSideChats } from "../../../../src/services/pi-durable/durable-side-chats";
import { readDurableOriginalPage } from "../../../../src/services/pi-durable/durable-chat-history";
import { cakeChatSideChatConversationId } from "../../../../src/contracts/cake-chats/cake-chat-identity";
import { durableAnswer, durableModel, durableModels } from "../../../fixtures/durable-chat";

it("forks at the latest settled reply while the current exchange is unfinished", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { models } = durableModels((_request, index) =>
    durableAnswer(
      index === 1 ? "First settled reply" : index === 2 ? "Latest settled reply" : "Done",
      index === 3
        ? [{ type: "toolCall", id: "fork-call", name: "hold", arguments: {} }]
        : undefined,
    ),
  );
  const hold = defineTool({
    name: "hold",
    description: "Keep this exchange unfinished",
    parameters: Type.Object({}),
    execute: async () => {
      entered.resolve();
      await release.promise;
      return {};
    },
  });
  const registry = createRegistry();
  registry.install(
    defineExtension({ name: "fixture", tools: [hold, createEditTool(), createWriteTool()] }),
  );
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models, registry }, context);
  try {
    const root = await harness.root(context, {
      agent: {
        model: { provider: "fixture", modelId: "fixture" },
        tools: [hold],
      },
    });
    const chats = createDurableSideChats({
      root,
      harness,
      storage,
      sessionFile: "/chat.sqlite",
      catalog: { getModel: () => durableModel },
      settings: SettingsManager.inMemory(),
      models: () => [],
      fastMode: () => false,
    });
    for (const content of ["First decision", "Latest decision"])
      await (await root.submit({ type: "input", content }, context)).wait(context);
    const ongoing = await root.submit(
      { type: "input", content: "Unfinished exchange details" },
      context,
    );
    await entered.promise;
    try {
      const before = await readDurableOriginalPage(root);
      const fork = await chats.forkTask("/managed/task");
      const id = cakeChatSideChatConversationId(fork.sessionId)! as typeof root.id;
      expect(id).not.toBe(root.id);
      const conversation = await harness.conversation(id, context);
      const inherited = JSON.stringify(await conversation!.context(context));
      expect(inherited).toContain("First decision");
      expect(inherited).toContain("Latest decision");
      expect(inherited).toContain("Latest settled reply");
      expect(inherited).not.toContain("Unfinished exchange details");
      expect(inherited).not.toContain("fork-call");
      expect((await storage.conversation(id, context))?.parent).toEqual({
        conversationId: root.id,
        at: Number(fork.entryId),
      });
      expect(await readDurableOriginalPage(root)).toEqual(before);
      const explicit = await chats.forkTask("/managed/explicit", fork.entryId);
      expect(explicit.entryId).toBe(fork.entryId);
      await expect(chats.forkTask("/managed/invalid", "999999999")).rejects.toThrow(
        "no longer available",
      );
    } finally {
      release.resolve();
      await ongoing.wait(context);
    }
  } finally {
    release.resolve();
    await harness.close(context);
  }
});
