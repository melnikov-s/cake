import { SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { projectCakeSessionRuntimeSnapshot } from "../../../src/services/pi/runtime/cake-session-runtime-snapshot";
import { boundedProjectionKey } from "../../../src/services/pi/runtime/tool-projection";

it("keeps a pending interview linked to its tool row while live tool progress replaces it", () => {
  const manager = SessionManager.inMemory("/project");
  manager.appendMessage({ role: "user", content: "Interview me", timestamp: 1 });
  const assistantEntryId = manager.appendMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call_interview",
        name: "cake",
        arguments: { command: "interview.open", input: {} },
      },
    ],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 2,
  });
  const request = {
    protocol: "cake.request/v1",
    id: "fixture-interview",
    title: "Fixture interview",
    responseSchema: { type: "object", properties: { name: { type: "string" } } },
    view: { type: "form", fields: [{ id: "name", label: "Project name", type: "text" }] },
    fallback: { markdown: "Name the project." },
  };
  manager.appendCustomEntry("cake.interview/v1", {
    id: "call_interview",
    sessionId: "session",
    request,
    origin: { assistantEntryId, toolCallId: "call_interview" },
  });
  const session = {
    sessionManager: manager,
    systemPrompt: "",
    agent: { state: { tools: [] } },
    isStreaming: true,
    thinkingLevel: "off",
    getAvailableThinkingLevels: () => ["off"],
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
  };
  const snapshot = projectCakeSessionRuntimeSnapshot({
    workspacePath: "/project",
    sessionId: "session",
    sessionListed: true,
    auxiliary: false,
    session: session as unknown as AgentSession,
    settingsManager: SettingsManager.inMemory(),
    models: [],
    // The live event projection's running tool row carries no interview metadata.
    streamingParts: [
      {
        id: boundedProjectionKey("tool-call_interview"),
        kind: "tool",
        name: "cake",
        command: "interview.open",
        input: "",
        state: "running",
      },
    ],
    queuedParts: [],
    transientParts: [],
    fastMode: false,
    commands: [],
    slashCommands: undefined,
    usage: undefined,
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    diagnostics: [],
    reloadPending: false,
  });
  const tool = snapshot.parts.filter((part) => part.kind === "tool");
  expect(tool).toHaveLength(1);
  expect(tool[0]).toMatchObject({
    state: "running",
    interview: { id: "call_interview", sessionId: "session" },
  });
});
