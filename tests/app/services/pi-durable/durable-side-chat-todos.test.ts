import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-durable-ai";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../../src/contracts/cake-chats/cake-chat-identity";
import { projectChatSessionId } from "../../../../src/domain/cake-chats/cakeChatLocations";
import { CakeOperationRegistry } from "../../../../src/services/pi/runtime/cake-operation-registry";
import {
  createDurableSideChats,
  type DurableSideChats,
} from "../../../../src/services/pi-durable/durable-side-chats";
import { readDurableOriginalPage } from "../../../../src/services/pi-durable/durable-chat-history";
import { durableAnswer, durableModel, durableModels } from "../../../fixtures/durable-chat";

it.each([CAKE_CHAT_SESSION_ID, projectChatSessionId("/project")])(
  "native side chats use parent-scoped to-do discovery and controls without writing parent history (%s)",
  async (parentSessionId) => {
    const context = BACKGROUND_CONTEXT;
    const registry = createRegistry();
    let sideChats: DurableSideChats;
    let lists = 0;
    const tool = defineTool({
      name: "cake",
      description: "Cake controls",
      parameters: Type.Any(),
      replay: "unsafe",
      execute: (input, api, context) => sideChats.executeTodo(input, api, context),
    });
    registry.install(defineExtension({ name: "cake", tools: [tool] }));
    const commands = ["todos.list", "sessions.send", "todos.list.help"];
    const { models, requests } = durableModels((_request, index) => {
      const command = index % 2 === 0 ? commands[index / 2 - 1] : undefined;
      return command
        ? durableAnswer("", [
            {
              type: "toolCall",
              id: `call-${index}`,
              name: "cake",
              arguments: { command, input: {} },
            },
          ])
        : durableAnswer("Done");
    });
    const storage = new MemoryStorage();
    const harness = await Harness.open(storage, { models, registry }, context);
    try {
      const root = await harness.root(context, {
        agent: { model: { provider: "fixture", modelId: "fixture" }, tools: [tool] },
      });
      await (
        await root.submit({ type: "input", content: "Parent question" }, context)
      ).wait(context);
      const parentHistory = await readDurableOriginalPage(root);
      const reply = parentHistory.parts.find(
        (part) => part.kind === "text" && part.role === "assistant",
      );
      const entry = reply?.kind === "text" ? reply.entryId : undefined;
      if (!entry) throw new Error("Missing branch point");
      sideChats = createDurableSideChats({
        parentSessionId,
        harness,
        root,
        storage,
        sessionFile: "/fixture/chat.sqlite",
        catalog: { getModel: () => durableModel },
        settings: SettingsManager.inMemory(),
        models: () => [],
        fastMode: () => false,
        todoContext: () => "Current parent to-do: Shared design",
        todoOperations: new CakeOperationRegistry([
          {
            command: "todos.list",
            topic: "todos",
            summary: "List parent to-dos",
            inputSchema: Schema.Struct({}),
            examples: [],
            result: "Parent list",
            outputSchema: Schema.Struct({ title: Schema.String }),
            execute: async () => {
              lists++;
              return { title: "Shared design" };
            },
          },
        ]),
      });
      const sessionId = await sideChats.fork(entry);
      const runtime = await sideChats.open({
        sessionId,
        cwd: "/fixture",
        agentDir: "/agent",
        sessionDir: "/sessions",
        trusted: true,
        requestUi: async () => undefined,
        onEvent: () => undefined,
      });
      try {
        await runtime.prompt("Read our to-dos", "prompt", []);
        expect(lists).toBe(1);
        expect(JSON.stringify((await runtime.snapshot()).parts)).toContain("Shared design");
        expect(JSON.stringify(requests)).toContain("Current parent to-do: Shared design");
        await runtime.prompt("Try an unrelated control", "prompt", []);
        expect(JSON.stringify((await runtime.snapshot()).parts)).toContain(
          "Unknown Cake command: sessions.send",
        );
        await runtime.prompt("Show to-do help", "prompt", []);
        expect(JSON.stringify((await runtime.snapshot()).parts)).toContain("List parent to-dos");
        expect(lists).toBe(1);
        expect(await readDurableOriginalPage(root)).toEqual(parentHistory);
        const displayed = JSON.stringify((await runtime.snapshot()).parts);
        expect(displayed).not.toContain("Current parent to-do:");
      } finally {
        await runtime.dispose();
      }
    } finally {
      await harness.close(context);
    }
  },
);
