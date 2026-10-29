import type { JsonObject } from "../../../src/contracts/serialization/json-contract";
import type { AgentControlSource } from "../../../src/renderer/app-control/app-control-data";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import type { TestClientOverrides } from "./test-client";

export const commandClientSource = {
  kind: "project-session",
  sessionId: "calling",
  title: "Planner",
  projectPath: "/project",
  workingDirectory: "/project",
} satisfies AgentControlSource;

export function createCommandClientFinishFixture(
  client: TestClientOverrides = {},
  flushWindowState: () => Promise<void> = async () => undefined,
) {
  const fixture = createRendererStoreFixture({
    client,
    flushWindowState,
    projects: [projectRecord({ path: "/project" }), projectRecord({ path: "/other" })],
    sessions: [
      sessionSummary({ sessionId: "calling", title: "Planner", projectPath: "/project" }),
      sessionSummary({
        sessionId: "target",
        title: "Other work",
        projectPath: "/other",
        running: true,
      }),
    ],
  });
  for (const [sessionId, workingDirectory] of [
    ["calling", "/project"],
    ["target", "/other"],
  ]) {
    if (!sessionId || !workingDirectory) throw new Error("Missing command fixture identity");
    const session = fixture.root.sessionRegistry.load(sessionId, workingDirectory);
    applyConversationUpdate(session.model, {
      _tag: "Snapshot",
      revision: 1,
      snapshot: {
        sessionId,
        sessionFile: `${workingDirectory}/${sessionId}.jsonl`,
        parts: [
          {
            id: `${sessionId}-message`,
            kind: "text",
            role: "assistant",
            text: sessionId === "calling" ? "Conversation: Planner" : "Conversation: Other work",
            status: "complete",
          },
        ],
        models: [],
        thinkingLevel: "off",
        availableThinkingLevels: ["off"],
        streaming: sessionId === "target",
        diagnostics: [],
        commands: [],
        compatibility: { resources: [], diagnostics: [] },
        extensionUi: { statuses: [] },
        tree: [],
      },
    });
    session.conversationSessionStore.chatStore.transcriptInteraction.setTranscriptScrollPosition({
      kind: "top",
    });
  }
  fixture.root.navigationStore.showLoadedProjectSession("calling");
  return {
    ...fixture,
    // Incoming agent commands have no honest user-facing initiation control.
    // Keep the real public gateway, Root host, Stores and Models under test.
    invoke(name: string, args: JsonObject = {}, source: AgentControlSource = commandClientSource) {
      return fixture.root.applicationControlStore.invoke({ name, arguments: args }, source);
    },
  };
}
