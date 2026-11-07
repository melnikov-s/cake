import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  AgentDoc,
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
import {
  SideSessionDoc,
  sideSessionExecutionEnv,
} from "../../../../src/services/pi-durable/durable-side-session";
import { readDurableOriginalPage } from "../../../../src/services/pi-durable/durable-chat-history";
import { cakeChatSideChatConversationId } from "../../../../src/contracts/cake-chats/cake-chat-identity";
import { durableAnswer, durableModel, durableModels } from "../../../fixtures/durable-chat";

it.each([undefined, `project-chat:${"a".repeat(64)}`])(
  "forks real parent reasoning, keeps source unchanged and isolates task execution (%s)",
  async (parentSessionId) => {
    const { models, requests } = durableModels((_request, index) =>
      durableAnswer(
        index === 1 ? "Use the small fix" : "Task done",
        index === 1
          ? [
              { type: "thinking", thinking: "The large rewrite loses the user's constraints." },
              { type: "text", text: "Use the small fix" },
            ]
          : index === 2
            ? [{ type: "toolCall", id: "where", name: "allowed", arguments: {} }]
            : undefined,
      ),
    );
    const storage = new MemoryStorage();
    const registry = createRegistry();
    let executedIn: string | undefined;
    const allowed = defineTool({
      name: "allowed",
      description: "Originating capability",
      parameters: Type.Object({}),
      execute: async (_args, api) => {
        executedIn = api.env?.cwd;
        return {};
      },
    });
    const forbidden = defineTool({
      name: "forbidden",
      description: "Not granted",
      parameters: Type.Object({}),
      execute: async () => ({}),
    });
    registry.install(
      defineExtension({
        name: "fixture",
        tools: [allowed, forbidden, createEditTool(), createWriteTool()],
      }),
    );
    const harness = await Harness.open(
      storage,
      { models, registry, env: sideSessionExecutionEnv("/scratch") },
      context,
    );
    try {
      const root = await harness.root(context, {
        agent: {
          model: { provider: "fixture", modelId: "fixture" },
          tools: [allowed],
          instructions: "Work only on the authorized project.",
        },
      });
      const rootEnv = await sideSessionExecutionEnv("/scratch")!(
        { conversationId: root.id, cwd: "/source", read: harness },
        context,
      );
      expect(rootEnv?.cwd).toBe("/scratch");
      const chats = createDurableSideChats({
        parentSessionId,
        root,
        harness,
        storage,
        sessionFile: "/chat.sqlite",
        catalog: { getModel: () => durableModel },
        settings: SettingsManager.inMemory(),
        models: () => [],
        fastMode: () => false,
      });
      await expect(chats.forkTask("/worktree")).rejects.toThrow("no completed reply");
      await (
        await root.submit(
          { type: "input", content: "Keep the simple design, because our users need it." },
          context,
        )
      ).wait(context);
      const before = await readDurableOriginalPage(root);
      const agentBefore = await root.agent(context);
      const configurationBefore = await harness.snapshot(AgentDoc, root.id, context);
      const fork = await chats.forkTask("/managed/task");
      const id = cakeChatSideChatConversationId(fork.sessionId)!;
      const conversation = await harness.conversation(id as typeof root.id, context);
      expect(conversation).toBeDefined();
      const record = await storage.conversation(id as typeof root.id, context);
      expect(record?.parent).toEqual({ conversationId: root.id, at: Number(fork.entryId) });
      const taskAgent = await conversation!.agent(context);
      expect(taskAgent.tools.map((tool) => tool.name)).toEqual(["allowed", "edit", "write"]);
      expect(taskAgent.instructions).toBe(agentBefore.instructions);
      expect(taskAgent.model).toEqual(agentBefore.model);
      expect(await harness.snapshot(SideSessionDoc, root.id, context)).toBeUndefined();
      expect(await harness.snapshot(SideSessionDoc, conversation!.id, context)).toEqual({
        workingDirectory: "/managed/task",
      });
      const results: unknown[] = [];
      const runtime = await chats.open({
        sessionId: fork.sessionId,
        cwd: "/source",
        agentDir: "/agent",
        sessionDir: "/sessions",
        requestUi: async () => undefined,
        onEvent: () => undefined,
        onTurnResult: (turnId, result) => results.push({ turnId, result }),
      });
      try {
        expect((await runtime.snapshot()).workspacePath).toBe("/managed/task");
        await runtime.prompt("Implement that small fix", "prompt", [], false, "task-turn");
        expect(results).toEqual([
          {
            turnId: "task-turn",
            result: expect.objectContaining({
              stopReason: "stop",
              text: "Task done",
              entryId: expect.any(String),
            }),
          },
        ]);
        expect(JSON.stringify(requests.at(-1)?.messages)).toContain("The large rewrite loses");
        expect(JSON.stringify(requests.at(-1)?.messages)).toContain("because our users need it");
        expect(executedIn).toBe("/managed/task");
        expect(await readDurableOriginalPage(root)).toEqual(before);
        expect(await harness.snapshot(AgentDoc, root.id, context)).toEqual(configurationBefore);
      } finally {
        await runtime.dispose();
      }
    } finally {
      await harness.close(context);
    }
  },
);
