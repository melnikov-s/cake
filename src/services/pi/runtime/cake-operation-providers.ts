import type {
  CakeModelSelection,
  ExplicitCakeModelSelection,
} from "../../../contracts/model-presets/cake-model-selection";
import type { JsonObject, JsonValue } from "../../../contracts/serialization/json-contract";
import type { PiPendingMessages, PiPendingMessageReorder } from "../conversation-data";
import type { ProjectSessionCreateInput } from "../../../contracts/project-sessions/agent-session-create";
import type { CakeOperationHost } from "../../../contracts/agent/cake-operation-context";
import type { NonChatModelType } from "../../../contracts/models/non-chat-model-data";
import type { CakeOperationDefinition } from "./cake-operation-registry";
import type { CakeSessionRuntimeOptions } from "./cake-session-runtime";

export interface RuntimeOperationApi {
  info(): Promise<JsonValue>;
  usage(): JsonValue;
  contextStatus(): JsonValue;
  compact(instructions?: string): Promise<JsonValue>;
  rename(title: string): Promise<JsonValue>;
  createSession(input: ProjectSessionCreateInput, signal: AbortSignal): Promise<JsonValue>;
  createDraftSession(
    input: { name: string; initialPrompt: string; model?: CakeModelSelection },
    signal: AbortSignal,
  ): Promise<JsonValue>;
  createChildSession(
    input: {
      title: string;
      initialPrompt: string;
      model?: CakeModelSelection;
      placement: "none" | "right" | "down";
      worktreeName?: string;
    },
    requestId: string,
    signal: AbortSignal,
  ): Promise<JsonValue>;
  forkSession(input: {
    entryId?: string;
    prompt?: string;
    title?: string;
    resolveSource: boolean;
    placement: "none" | "right" | "down";
    destinationWorkingDirectory?: string;
  }): Promise<JsonValue>;
  invokeAppControl(command: string, input: JsonObject, signal: AbortSignal): Promise<JsonValue>;
  pendingMessages(sessionId: string, signal: AbortSignal): Promise<PiPendingMessages>;
  reorderPendingMessage(
    sessionId: string,
    input: typeof PiPendingMessageReorder.Type,
    signal: AbortSignal,
  ): Promise<PiPendingMessages>;
  mergeSession(targetSessionId: string | undefined, signal: AbortSignal): Promise<JsonValue>;
  discardSession(
    targetSessionId: string | undefined,
    keepBranch: boolean,
    signal: AbortSignal,
  ): Promise<JsonValue>;
  resolveModelSelection(selection: CakeModelSelection | undefined): ExplicitCakeModelSelection;
  setModel(model: CakeModelSelection): Promise<JsonValue>;
  setResolved(resolved: boolean): Promise<JsonValue>;
}

/** Backend composition supplies product operations; the Pi adapter supplies only live capabilities. */
export interface CakeOperationProviders {
  project(
    options: CakeSessionRuntimeOptions,
    bridge: {
      host: CakeOperationHost;
      api(): RuntimeOperationApi;
      sessionId(): string | undefined;
      getAvailableOfType(
        type: NonChatModelType,
        filter: undefined,
        options: { signal: AbortSignal },
      ): Promise<ReadonlyArray<{ provider: string; id: string }>>;
    },
  ): CakeOperationDefinition[];
  coordinator(
    options: CakeSessionRuntimeOptions,
    bridge: {
      sessionId: string;
      resolveModel(selection: CakeModelSelection | undefined): ExplicitCakeModelSelection;
      info(): Promise<JsonValue>;
      usage(): Promise<JsonValue>;
      contextStatus(): Promise<JsonValue>;
      compact(): Promise<JsonValue>;
      setModel(model: ExplicitCakeModelSelection): Promise<void>;
    },
  ): CakeOperationDefinition[];
}
