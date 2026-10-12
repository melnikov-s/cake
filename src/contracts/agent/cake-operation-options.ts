import type { CakeArtifactOperationOptions } from "../artifacts/artifact-agent-control";
import type { MessageBoardControl } from "../artifacts/message-board-control";
import type { BrowserControl } from "../browser/browser-agent-control";
import type { ChatConfiguration } from "../conversations/session-contract";
import type { CrossSessionContextSnapshot } from "../conversations/cross-session-message";
import type {
  PiPendingMessages,
  PiPendingMessageReorder,
} from "../conversations/pending-message-data";
import type { CakeDrawControl } from "../draw/draw-agent-control";
import type { VscodeControl } from "../editor/vscode-agent-control";
import type { InterviewRecord } from "../interviews/interview";
import type { CakeModelPresetCatalog } from "../model-presets/cake-model-selection";
import type { NonChatModelPreferences } from "../models/non-chat-model-data";
import type { SessionPluginControl } from "../application/session-plugin-agent-control";
import type { ParallelSubagentInput, SubagentTaskInput } from "../subagents/subagent-data";
import type { ProjectSessionAgentPolicy } from "../project-sessions/project-session-agent-policy";
import type { JsonObject, JsonValue } from "../serialization/json-contract";
import type { WorkflowControl } from "../workflows/workflow-agent-control";
import type { WorktreeLandingControl } from "../worktrees/worktree-agent-control";
import type { GlobalControlTool } from "./cake-operation-control";

/** Live policy queries do not authorize a later mutation. */
export interface ProjectSessionLivePolicyControl {
  readPolicy(): Promise<ProjectSessionAgentPolicy>;
  resolveDeferredStandalone(): Promise<void>;
}

interface CurrentSessionControl extends ProjectSessionLivePolicyControl {
  resolved(): boolean;
  canResolve?(): boolean;
  setResolved(resolved: boolean): Promise<void>;
  createSession?(
    input: {
      name: string;
      initialPrompt: string;
      model: ChatConfiguration;
      worktreeName?: string;
    },
    signal: AbortSignal,
  ): Promise<JsonValue>;
  createDraftSession?(
    input: {
      name: string;
      initialPrompt: string;
      model?: ChatConfiguration;
    },
    signal: AbortSignal,
  ): Promise<JsonValue>;
  createChildSession?(
    input: {
      requestId: string;
      title: string;
      initialPrompt: string;
      model: ChatConfiguration;
      placement: "none" | "right" | "down";
      worktreeName?: string;
      senderContext: CrossSessionContextSnapshot;
    },
    signal: AbortSignal,
  ): Promise<JsonValue>;
  forkSession?(input: {
    entryId: string;
    prompt?: string;
    title?: string;
    resolveSource: boolean;
    placement: "none" | "right" | "down";
    destinationWorkingDirectory?: string;
  }): Promise<JsonValue>;
  routeFamilyMessage?(
    command: "sessions.send" | "sessions.reply",
    input: JsonObject,
    signal: AbortSignal,
    senderContext?: CrossSessionContextSnapshot,
  ): Promise<JsonValue | undefined>;
  mergeSession?(targetSessionId: string | undefined, signal: AbortSignal): Promise<JsonValue>;
  discardSession?(
    targetSessionId: string | undefined,
    keepBranch: boolean,
    signal: AbortSignal,
  ): Promise<JsonValue>;
  invokeAppControl?(command: string, input: JsonObject, signal: AbortSignal): Promise<JsonValue>;
  pendingMessages?(sessionId: string, signal: AbortSignal): Promise<PiPendingMessages>;
  reorderPendingMessage?(
    sessionId: string,
    input: PiPendingMessageReorder,
    signal: AbortSignal,
  ): Promise<PiPendingMessages>;
}

export interface GlobalOperationControl {
  tools: readonly GlobalControlTool[];
  invoke(input: { name: string; arguments: JsonValue }, signal: AbortSignal): Promise<JsonValue>;
}

export interface AgentOperationControl {
  run(
    input: SubagentTaskInput,
    parentSessionId: string,
    signal: AbortSignal,
    onUpdate?: (value: JsonValue) => void,
    anchorPartId?: string,
  ): Promise<JsonValue>;
  start(
    input: SubagentTaskInput,
    parentSessionId: string,
    signal: AbortSignal,
    anchorPartId?: string,
  ): Promise<JsonValue>;
  parallel(
    input: ParallelSubagentInput,
    parentSessionId: string,
    signal: AbortSignal,
    onUpdate?: (value: JsonValue) => void,
    anchorPartId?: string,
  ): Promise<JsonValue>;
  prompt(
    input: { handleId: string; text: string; delivery: "prompt" | "follow-up" },
    parentSessionId: string,
    signal: AbortSignal,
  ): Promise<JsonValue>;
  wait(
    handleId: string,
    parentSessionId: string,
    signal: AbortSignal,
    onUpdate?: (value: JsonValue) => void,
  ): Promise<JsonValue>;
  abort(handleId: string, parentSessionId: string): Promise<JsonValue>;
  close(handleId: string, parentSessionId: string): Promise<JsonValue>;
}

/** Product operation inputs and capabilities, independent of engine acquisition and SDK tools. */
export interface CakeOperationOptions extends Partial<CakeArtifactOperationOptions> {
  cwd: string;
  allowedCakeOperations?: readonly string[];
  tools?: string[];
  auxiliary?: boolean;
  workflowControl?: WorkflowControl;
  messageBoardControl?: MessageBoardControl;
  requestInterview?(record: InterviewRecord, signal: AbortSignal): Promise<JsonValue | undefined>;
  sessionPluginControl?: Omit<SessionPluginControl, "generate">;
  modelPresets?(): CakeModelPresetCatalog;
  nonChatModelPreferences?(): NonChatModelPreferences;
  currentSessionControl?: CurrentSessionControl;
  vscodeControl?: VscodeControl;
  browserControl?: BrowserControl;
  drawControl?: CakeDrawControl;
  worktreeLandingControl?: WorktreeLandingControl;
  globalControl?: GlobalOperationControl;
  /** Parent Project Session gateway granted to an auxiliary runtime, not coordinator authority. */
  sessionControl?: GlobalOperationControl;
  agentControl?: AgentOperationControl;
}
