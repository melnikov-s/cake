import { createStore, observable } from "r-state-tree";
import { vi } from "vitest";
import type { ConversationSnapshot } from "../../../src/domain/conversations/conversation-data";
import type {
  ChatConfiguration,
  ModelOption,
  ModelPreset,
} from "../../../src/ipc/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { RootProjection } from "../../../src/renderer/models/RootProjection";
import { applyConversationSnapshot } from "../../../src/renderer/reducers/ConversationReducer";
import { ChatConfigurationStore } from "../../../src/renderer/stores/ChatConfigurationStore";
import { mountWithClient } from "./mount-with-client";

function pickerModel(
  provider: string,
  id: string,
  name: string,
  availableThinkingLevels: ModelOption["availableThinkingLevels"],
  fastMode = false,
  authenticated = true,
): ModelOption {
  return {
    provider,
    providerName: provider === "openai" ? "OpenAI" : "Anthropic",
    id,
    name,
    reasoning: availableThinkingLevels.some((level) => level !== "off"),
    availableThinkingLevels,
    fastMode,
    input: ["text"],
    authenticated,
    authTypes: [],
  };
}

export function configurationFixture(deferred = false) {
  const current = pickerModel("openai", "gpt-5", "GPT-5", ["off", "medium", "high"]);
  const next = pickerModel(
    "anthropic",
    "claude-opus",
    "Claude Opus",
    ["low", "high", "xhigh", "max"],
    true,
  );
  const disconnected = pickerModel(
    "anthropic",
    "locked",
    "Disconnected model",
    ["off"],
    false,
    false,
  );
  const projection = RootProjection.create();
  const first = projection.projectConversation("first", "/project");
  const second = projection.projectConversation("second", "/project");
  const snapshot = {
    sessionId: "first",
    sessionFile: "/project/first.jsonl",
    parts: [],
    model: { provider: current.provider, id: current.id, name: current.name },
    models: [current, next, disconnected],
    thinkingLevel: "medium",
    availableThinkingLevels: current.availableThinkingLevels,
    fastMode: false,
    fastModeAvailable: false,
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  } satisfies ConversationSnapshot;
  applyConversationSnapshot(first, snapshot);
  applyConversationSnapshot(second, {
    ...snapshot,
    sessionId: "second",
    sessionFile: "/project/second.jsonl",
    model: { provider: next.provider, id: next.id, name: next.name },
    models: [{ ...next, availableThinkingLevels: ["low", "high"], fastMode: false }],
    thinkingLevel: "high",
    availableThinkingLevels: ["low", "high"],
  });
  const preset: ModelPreset = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Deep review",
    provider: next.provider,
    modelId: next.id,
    thinkingLevel: "max",
    fastMode: true,
  };
  const state = observable({
    session: deferred ? undefined : first,
    deferred,
    pending: undefined as ChatConfiguration | undefined,
  });
  const presets = observable([preset]);
  const list = vi.fn<Client["models"]["list"]>(async () => [current, next, disconnected]);
  const setConfiguration = vi.fn<(configuration: ChatConfiguration) => Promise<void>>(
    async () => undefined,
  );
  const setThinkingLevel = vi.fn<(level: string) => Promise<void>>(async () => undefined);
  const operations = {
    start: vi.fn(() => "operation"),
    finish: vi.fn(),
    includes: () => false,
    active: () => [],
    reset: () => undefined,
  };
  const mounted = mountWithClient(
    createStore(ChatConfigurationStore, {
      session: () => state.session,
      operations,
      presets: () => presets,
      deferredNewSession: () => state.deferred,
      effectiveConfiguration: () => state.pending,
      setPendingConfiguration: (configuration) => {
        state.pending = configuration;
      },
      setConfiguration,
      setModel: async () => undefined,
      setThinkingLevel,
      setFastMode: async () => undefined,
    }),
    { models: { list } } as unknown as Client,
  );
  return {
    ...mounted,
    projection,
    first,
    second,
    snapshot,
    state,
    preset,
    presets,
    list,
    setConfiguration,
    setThinkingLevel,
    dispose() {
      mounted.root[Symbol.dispose]();
      projection[Symbol.dispose]();
    },
  };
}
