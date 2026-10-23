import { createRoot } from "react-dom/client";
import { StoreProvider } from "r-state-tree/react";
import { Chat } from "../../src/renderer/components/chat";
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-identity";
import {
  builtinSlashCommands,
  type ConversationSnapshot,
} from "../../src/contracts/conversations/session-contract";
import { applyConversationSnapshot } from "../../src/renderer/reducers/ConversationReducer";
import { createRendererStoreFixture } from "../app/renderer/renderer-store-fixture";
import { projectRecord, sessionSummary } from "../app/renderer/fixtures/catalog-fixtures";

export type ContextTooltipScope = "global" | "project-chat" | "project-session";

// Real Chat/Models/Stores; only the external Client and snapshot delivery are fake.
// No model, provider, or live application is involved.
const fixture = createRendererStoreFixture({
  projects: [projectRecord({ path: "/project" })],
  sessions: [sessionSummary({ sessionId: "tooltip-session", projectPath: "/project" })],
});
const scope = new URLSearchParams(location.search).get("scope");
const isSession = scope === "project-session";
const sessionId = isSession
  ? "tooltip-session"
  : scope === "project-chat"
    ? new URLSearchParams(location.search).get("projectChatId")!
    : CAKE_CHAT_SESSION_ID;
const owner = isSession
  ? fixture.root.sessionRegistry.load(sessionId, "/project")
  : fixture.root.cakeChatCollectionStore.registry.load(sessionId);
if (isSession) {
  fixture.root.navigationStore.selectProjectSession(sessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(sessionId);
}
const snapshot: ConversationSnapshot = {
  sessionId,
  workspacePath: scope === "global" ? "/fixture/global" : "/project",
  sessionFile: "/fixture/history",
  parts: isSession
    ? [
        {
          id: "response",
          kind: "text",
          role: "assistant",
          text: "Completed response",
          status: "complete",
          response: {
            provider: "openai-codex",
            modelId: "gpt-5.6",
            requestedAt: Date.now(),
            retention: "short",
            inputTokens: 51_500,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
      ]
    : [],
  model: { provider: "openai-codex", id: "gpt-5.6", name: "GPT-5.6" },
  models: [
    {
      provider: "openai-codex",
      providerName: "OpenAI Codex",
      id: "gpt-5.6",
      name: "GPT-5.6",
      reasoning: false,
      availableThinkingLevels: ["off"],
      fastMode: false,
      input: ["text"],
      authenticated: true,
      authTypes: [],
    },
  ],
  thinkingLevel: "off",
  availableThinkingLevels: ["off"],
  streaming: false,
  diagnostics: [],
  commands: builtinSlashCommands,
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  tree: [],
  usage: {
    tokens: { input: 51_500, output: 10, cacheRead: 0, cacheWrite: 0, total: 51_510 },
    cost: 0,
    ...(isSession
      ? { context: { tokens: 51_500, contextWindow: 255_600, percent: 20 } }
      : {
          cakeChatContext: {
            systemTokens: 4_500,
            memoryTokens: 18_600,
            messageTokens: 28_400,
            totalTokens: 51_500,
            configuredLimitTokens: 255_600,
            modelLimitTokens: 255_600,
            limitTokens: 255_600,
            cache: {
              provider: "openai-codex",
              modelId: "gpt-5.6",
              requestedAt: Date.now(),
              inputTokens: 51_500,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          },
        }),
  },
};
applyConversationSnapshot(owner.model, snapshot);
createRoot(document.getElementById("root")!).render(
  <StoreProvider store={fixture.root.fullscreenSurfaceStore}>
    <Chat store={owner.conversationSessionStore.chatStore} embedded composerFocusEnabled={false} />
  </StoreProvider>,
);
