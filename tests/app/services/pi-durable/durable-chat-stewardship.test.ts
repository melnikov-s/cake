import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { getCurrentSystemMessage } from "@earendil-works/pi-durable-ai/utils/transcript";
import { expect, it } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../../src/contracts/cake-chats/cake-chat-identity";
import { coordinatorSystemPrompt } from "../../../../src/services/pi-durable/coordinator-system-prompt";
import { createDurableSideChats } from "../../../../src/services/pi-durable/durable-side-chats";
import { durableModel, durableModels } from "../../../fixtures/durable-chat";

it.each([
  { role: "global Cake Chat", sessionId: CAKE_CHAT_SESSION_ID },
  { role: "first Project Chat", sessionId: `project-chat:${"a".repeat(64)}` },
  { role: "another Project Chat", sessionId: `project-chat:${"b".repeat(64)}` },
])(
  "delivers scoped stewardship to $role without promoting its human Side Chat",
  async ({ sessionId }) => {
    const context = BACKGROUND_CONTEXT;
    const { models, requests } = durableModels();
    const storage = new MemoryStorage();
    const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
    try {
      // Stewardship is shared; only the Global identity gets non-project execution.
      // Project-local instructions are appended separately by cakeChatRuntime.
      const instructions = coordinatorSystemPrompt(
        "",
        "/cake/docs",
        false,
        "",
        sessionId === CAKE_CHAT_SESSION_ID,
      );
      const root = await harness.root(context, {
        agent: { model: { provider: "fixture", modelId: "fixture" }, instructions },
      });
      await (
        await root.submit({ type: "input", content: "Review incoming work" }, context)
      ).wait(context);
      const parentSystem = getCurrentSystemMessage(requests[0]!.messages);
      if (!parentSystem?.sections) throw new Error("Expected a coordinator system message");
      expect(parentSystem?.sections.instructions).toContain(instructions);
      expect(instructions).toContain("## Execution stewardship");
      const chats = createDurableSideChats({
        parentSessionId: sessionId,
        harness,
        root,
        storage,
        sessionFile: "/chat.sqlite",
        catalog: { getModel: () => durableModel },
        settings: SettingsManager.inMemory(),
        models: () => [],
        fastMode: () => false,
      });
      const side = await chats.open({
        sessionId: await chats.fork(),
        cwd: "/fixture",
        agentDir: "/agent",
        sessionDir: "/sessions",
        requestUi: async () => undefined,
        onEvent: () => undefined,
      });
      try {
        await side.prompt("Discuss this separately", "prompt", []);
        const sideRequest = requests[1]!;
        // Native forks intentionally preserve the parent's exact system prefix.
        // Exclusion must be explicit in that inherited policy, not a new role grant.
        expect(getCurrentSystemMessage(sideRequest.messages)).toEqual(parentSystem);
        expect(JSON.stringify(sideRequest.messages)).toContain("<cake-side-chat>");
      } finally {
        await side.dispose();
      }
    } finally {
      await harness.close(context);
    }
  },
);
