import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConversationSnapshot } from "../../../src/ipc/conversation-data";
import type { UiPart } from "../../../src/ipc/session-contract";
import { Chat } from "../../../src/renderer/components/chat";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

type CacheResponse = NonNullable<Extract<UiPart, { kind: "text" }>["response"]>;
export const cacheSessionId = "cache-session";
export const cacheNow = new Date("2026-01-01T12:00:00Z").getTime();

export function cacheResponse(
  response: Pick<CacheResponse, "provider" | "modelId" | "requestedAt"> & Partial<CacheResponse>,
  id = "assistant-response",
): Extract<UiPart, { kind: "text" }> & { response: CacheResponse } {
  return {
    id,
    entryId: `${id}-entry`,
    kind: "text",
    role: "assistant",
    text: "Completed response",
    status: "complete",
    response: {
      retention: "short",
      inputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      ...response,
    },
  };
}

export function renderPromptCache(response: CacheResponse, client: TestClientOverrides = {}) {
  const fixture = createRendererStoreFixture({
    client,
    projects: [projectRecord({ path: "/project", name: "Project" })],
    sessions: [sessionSummary({ sessionId: cacheSessionId, projectPath: "/project" })],
  });
  const session = fixture.root.sessionRegistry.load(cacheSessionId, "/project");
  fixture.root.appShellStore.selectProjectSession(cacheSessionId);
  fixture.root.projectWorkbenchStore.showLoadedSession(cacheSessionId);
  let revision = 0;
  function publish(parts: readonly UiPart[]) {
    const input = response.inputTokens;
    const cacheRead = response.cacheReadTokens;
    const cacheWrite = response.cacheWriteTokens;
    const totalInput = input + cacheRead + cacheWrite;
    const snapshot: ConversationSnapshot = {
      sessionId: cacheSessionId,
      sessionFile: "/project/cache-session.jsonl",
      parts,
      model: { provider: response.provider, id: response.modelId, name: response.modelId },
      models: [
        {
          provider: response.provider,
          providerName: response.provider,
          id: response.modelId,
          name: response.modelId,
          reasoning: false,
          availableThinkingLevels: ["off"],
          fastMode: false,
          input: ["text"],
          authenticated: true,
          authTypes: [],
        },
      ],
      usage: {
        tokens: { input, output: 10, cacheRead, cacheWrite, total: totalInput + 10 },
        cost: 0,
        context: { tokens: totalInput, contextWindow: 200_000, percent: totalInput / 2_000 },
      },
      thinkingLevel: "off",
      availableThinkingLevels: ["off"],
      streaming: false,
      diagnostics: [],
      commands: [],
      compatibility: { resources: [], diagnostics: [] },
      extensionUi: { statuses: [] },
      tree: [],
    };
    applyConversationUpdate(session.model, { _tag: "Snapshot", revision: ++revision, snapshot });
  }
  publish([cacheResponse(response)]);
  const view = render(
    <Chat
      store={session.conversationSessionStore.chatStore}
      embedded
      composerFocusEnabled={false}
    />,
  );
  return {
    user: userEvent.setup(),
    publish(parts: readonly UiPart[]) {
      act(() => publish(parts));
    },
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}
