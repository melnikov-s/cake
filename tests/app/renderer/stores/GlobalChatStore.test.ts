import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { GlobalChatStore } from "../../../../src/renderer/stores/GlobalChatStore";
import { SessionRegistryStore } from "../../../../src/renderer/stores/SessionRegistryStore";
import type { SessionSnapshot } from "../../../../src/ipc/session-contract";
import type { DesktopClient } from "../../../../src/renderer/desktop-client";
import type { SessionOperationCoordinator } from "../../../../src/renderer/stores/SessionOperationCoordinator";
import type { ReviewsStore } from "../../../../src/renderer/stores/ReviewsStore";
import type { PluginCommandStore } from "../../../../src/renderer/stores/PluginCommandStore";

const snapshot: SessionSnapshot = {
  workspacePath: "/home/user",
  sessionId: "global-1",
  sessionFile: "/global-1.jsonl",
  parts: [{ id: "old", kind: "text", role: "assistant", text: "The PDF task is task-7.", status: "complete" }],
  model: { provider: "openai", id: "gpt", name: "GPT" },
  models: [{ provider: "openai", providerName: "OpenAI", id: "gpt", name: "GPT", reasoning: true, input: ["text"], authenticated: true, authTypes: [] }],
  thinkingLevel: "medium",
  availableThinkingLevels: ["off", "medium", "high"],
  streaming: false,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  sessions: [],
  tree: []
};

function createTestStore() {
  const port = {
    open: vi.fn(async () => undefined),
    prompt: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined)
  };
  const sessions = mount(createStore(SessionRegistryStore, {
    client: {} as DesktopClient,
    operations: {} as SessionOperationCoordinator,
    reviews: () => ({} as ReviewsStore),
    pluginCommands: () => ({} as PluginCommandStore),
    canSubmit: () => false,
    isActive: () => false,
    openCommandPane: async () => undefined,
    persist: () => undefined,
    projectName: () => "Project",
    abort: async () => undefined
  }));
  const configurationPort = {
    setModel: vi.fn(async (input: { operationId: string; provider: string; modelId: string }) => { void input; }),
    setThinkingLevel: vi.fn(async (input: { operationId: string; level: SessionSnapshot["thinkingLevel"] }) => { void input; })
  };
  const store = mount(createStore(GlobalChatStore, {
    port,
    tools: () => [{ name: "get_app_state", description: "Read app state", parameters: { type: "object", properties: {} } }],
    sessions: () => sessions,
    setModel: (operationId, provider, modelId) => configurationPort.setModel({ operationId, provider, modelId }),
    setThinkingLevel: (operationId, level) => configurationPort.setThinkingLevel({ operationId, level })
  }));
  const configuration = store.configurationStore;
  return { store, port, sessions, configuration, configurationPort };
}

describe("GlobalChatStore", () => {
  it("hydrates the persistent transcript and submits a follow-up", async () => {
    const { store, port, sessions, configuration, configurationPort } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());
    store.receive({
      type: "global-chat-snapshot-received",
      snapshot
    });

    store.chatStore.setDraft("Open it");
    await store.chatStore.submit();

    expect(store.parts.map((part) => part.kind === "text" ? part.text : "")).toEqual(["The PDF task is task-7.", "Open it"]);
    expect(port.prompt).toHaveBeenCalledWith(expect.objectContaining({ text: "Open it" }));
    await configuration.selectModel("openai/gpt");
    await configuration.selectThinkingLevel("high");
    expect(configurationPort.setModel).toHaveBeenCalledWith(expect.objectContaining({ provider: "openai", modelId: "gpt" }));
    expect(configurationPort.setThinkingLevel).toHaveBeenCalledWith(expect.objectContaining({ level: "high" }));
    store[Symbol.dispose]();
    sessions[Symbol.dispose]();
  });

  it("starts a new hidden session when cleared", async () => {
    const { store, port, sessions } = createTestStore();
    await vi.waitFor(() => expect(port.open).toHaveBeenCalledOnce());

    await store.clear();

    expect(port.clear).toHaveBeenCalledWith(expect.objectContaining({ tools: [{ name: "get_app_state", description: "Read app state", parameters: { type: "object", properties: {} } }] }));
    store[Symbol.dispose]();
    sessions[Symbol.dispose]();
  });
});
