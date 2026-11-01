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
  "native side chats inherit controls, deliver parent messages visibly and retain their sender identity (%s)",
  async (parentSessionId) => {
    const context = BACKGROUND_CONTEXT;
    const registry = createRegistry();
    let sideChats: DurableSideChats;
    let lists = 0;
    const senders: string[] = [];
    const tool = defineTool({
      name: "cake",
      description: "Cake controls",
      parameters: Type.Any(),
      replay: "unsafe",
      execute: (input, api, context) => sideChats.executeCake(input, api, context),
    });
    registry.install(defineExtension({ name: "cake", tools: [tool] }));
    const commands: Record<number, string> = {
      2: "todos.list",
      4: "sessions.send",
      7: "todos.list.help",
    };
    const { models, requests } = durableModels((_request, index) => {
      const command = commands[index];
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
      const inheritedOperations = new CakeOperationRegistry([
        {
          command: "sessions.send",
          topic: "sessions",
          summary: "Message the parent",
          inputSchema: Schema.Struct({}),
          examples: [],
          result: "Accepted",
          execute: async (_input, context) => {
            const sender = context.runtime?.sessionId;
            if (!sender) throw new Error("Missing sender");
            senders.push(sender);
            await (
              await root.submit(
                { type: "input", content: `Side-chat message from ${sender}` },
                BACKGROUND_CONTEXT,
              )
            ).wait(BACKGROUND_CONTEXT);
            return { ok: true };
          },
        },
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
      ]);
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
      });
      const sessionId = await sideChats.fork(entry);
      const runtime = await sideChats.open({
        sessionId,
        cwd: "/fixture",
        agentDir: "/agent",
        sessionDir: "/sessions",
        trusted: true,
        requestUi: async () => undefined,
        coordinator: { operations: () => inheritedOperations.definitions() },
        onEvent: () => undefined,
      });
      try {
        await runtime.prompt("Read our to-dos", "prompt", []);
        expect(lists).toBe(1);
        expect(JSON.stringify((await runtime.snapshot()).parts)).toContain("Shared design");
        expect(JSON.stringify(requests)).toContain("Current parent to-do: Shared design");
        expect(await readDurableOriginalPage(root)).toEqual(parentHistory);
        await runtime.prompt("Message the parent", "prompt", []);
        expect(senders).toEqual([sessionId]);
        const parentMessages = await readDurableOriginalPage(root);
        expect(JSON.stringify(parentMessages.parts)).toContain(
          `Side-chat message from ${sessionId}`,
        );
        expect(
          parentMessages.parts.filter((part) => part.kind === "text" && part.role === "assistant"),
        ).toHaveLength(2);
        await runtime.prompt("Show to-do help", "prompt", []);
        expect(JSON.stringify((await runtime.snapshot()).parts)).toContain("List parent to-dos");
        expect(lists).toBe(1);
        const displayed = JSON.stringify((await runtime.snapshot()).parts);
        expect(displayed).not.toContain("Current parent to-do:");
        const id = "cd06817e-b37a-44f6-84bb-76c380a42e79";
        const notice = {
          id,
          text: "Quiet parent evidence",
          crossSession: {
            version: 1 as const,
            messageId: id,
            threadId: id,
            sequence: 1,
            expectsResponse: false,
            resultDelivery: "ignore" as const,
            sender: { sessionId: parentSessionId, title: "Parent", kind: "cake-chat" as const },
          },
        };
        await runtime.prompt(
          "Continue with updates",
          "prompt",
          [],
          false,
          undefined,
          undefined,
          undefined,
          undefined,
          {
            _tag: "UserWithReminders",
            text: "Continue with updates",
            userText: "Continue with updates",
            notices: [notice],
          },
        );
        const parts = (await runtime.snapshot()).parts;
        expect(parts).toContainEqual(
          expect.objectContaining({
            kind: "text",
            text: "Quiet parent evidence",
            crossSession: expect.objectContaining({
              sender: expect.objectContaining({ sessionId: parentSessionId }),
            }),
          }),
        );
        expect(parts).toContainEqual(
          expect.objectContaining({ kind: "text", role: "user", text: "Continue with updates" }),
        );
      } finally {
        await runtime.dispose();
      }
    } finally {
      await harness.close(context);
    }
  },
);
