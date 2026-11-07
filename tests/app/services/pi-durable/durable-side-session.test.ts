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
import { Schema } from "effect";
import {
  MessageListResult,
  MessageReadResult,
} from "../../../../src/contracts/conversations/message-reference";
import { inspectDurableSideChatMessages } from "../../../../src/services/pi-durable/durable-side-chat-messages";
import { createDurableSideChats } from "../../../../src/services/pi-durable/durable-side-chats";
import {
  SideSessionDoc,
  sideSessionExecutionEnv,
} from "../../../../src/services/pi-durable/durable-side-session";
import { readDurableOriginalPage } from "../../../../src/services/pi-durable/durable-chat-history";
import { cakeChatSideChatConversationId } from "../../../../src/contracts/cake-chats/cake-chat-identity";
import { durableAnswer, durableModel, durableModels } from "../../../fixtures/durable-chat";

it.each([undefined, `project-chat:${"a".repeat(64)}`])(
  "forks real parent reasoning, keeps source unchanged and scopes investigation read-only (%s)",
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
        await runtime.prompt(
          "Investigate that small fix read-only",
          "prompt",
          [],
          false,
          "task-turn",
        );
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
        const effectiveInput = JSON.stringify(requests.at(-1)?.messages);
        for (const rule of [
          "read-only investigation context fork",
          "not an implementation Project Session",
          "Never mutate this worktree or the source checkout",
          "handoff to a fresh independent Project Session via sessions.create",
          "never silently expand research into coding",
          "no duplicate completion message",
        ])
          expect(effectiveInput).toContain(rule);
        expect(effectiveInput).not.toContain("Make code changes only there");
        expect(executedIn).toBe("/managed/task");
        const originals = Schema.decodeUnknownSync(MessageListResult)(
          await chats.inspectMessages(fork.sessionId, { kind: "messages-list" }),
        );
        const answer = originals.messages.findLast((message) => message.role === "assistant");
        expect(answer).toBeDefined();
        // The cold-reader path needs only persisted SDK storage, never an executable runtime.
        const original = Schema.decodeUnknownSync(MessageReadResult)(
          await inspectDurableSideChatMessages(storage, fork.sessionId, {
            kind: "messages-read",
            entryId: answer?.entryId,
          }),
        );
        expect(original.text).toBe("Task done");
        expect(original.message.ref).toBe(answer?.ref);
        await expect(
          inspectDurableSideChatMessages(storage, fork.sessionId, {
            kind: "messages-read",
            entryId: "999999",
          }),
        ).rejects.toThrow("does not exist");
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
