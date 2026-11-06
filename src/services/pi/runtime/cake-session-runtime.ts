import type { InternalInput } from "../../../contracts/conversations/internal-input";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createCakeSessionRuntimeSubscription } from "./cake-session-runtime-subscription";
import { shutdownDiagnostics, shutdownResource } from "../../diagnostics/shutdown-diagnostics";
import type { ProjectTodo } from "../../../contracts/projects/project-todos";
import type { IdleCompactionResult } from "../../../contracts/project-sessions/session-compaction";

import { resolve } from "node:path";
import { observeMessageBoardRequests } from "./message-board-extension";

import { keepAutoCompactionEnabled } from "./settings-translation";

import type { PiTurnResult } from "../../../contracts/pi/turn-result-data";
import type {
  CurrentSessionControl,
  SessionReferenceControl,
} from "../../../contracts/agent/cake-operation-options";
import type { CakeArtifactOperationOptions } from "../../../contracts/artifacts/artifact-agent-control";
import type { ArtifactExtensionOptions } from "./artifact-extension";
import type { MessageBoardControl } from "../../../contracts/artifacts/message-board-control";
import type { CakeModelPresetCatalog } from "../../../contracts/model-presets/cake-model-selection";
import type { CakeChatMemoryOptions } from "../cake-chat-memory-options";
import { Schema } from "effect";
import { createCakeSessionRuntimeOperationApi } from "./cake-session-runtime-operation-api";
import {
  assertInitialModelRegistered,
  registerAgentDirectoryExtensionProviders,
  registerPendingExtensionProviders,
} from "./extension-providers";
import {
  type Attachment,
  type ChatConfiguration,
  type PiSettingUpdate,
  type ExtensionUiEvent,
  type ExtensionUiIntent,
  type ConversationSnapshot,
  type SessionUsage,
  type ThinkingLevel,
  type UiPart,
  type UtilityModel,
} from "../../../contracts/conversations/session-contract";
import type {
  CakeModelSelection,
  ExplicitCakeModelSelection,
  CakeModelLaunch,
} from "../../../contracts/model-presets/cake-model-selection";

import type {
  PiPendingMessageReorder,
  PiPendingMessages,
} from "../../../contracts/conversations/pending-message-data";
import type {
  SessionInspectionQuery,
  QueuedSessionCommandReceipt,
} from "../../../contracts/conversations/session-query-data";
import { inspectSessionHistory } from "./session-inspection";
import { projectContextInspection, projectMemoryDetail } from "./project-context-inspection";
import { runtimeSystemTools } from "./system-context-projection";
import { listMessageReferences, readMessageReference } from "./message-references";
import { builtinSlashCommands } from "../../../contracts/conversations/session-contract";
import {
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "../../../contracts/serialization/json-contract";
import type { TurnStop } from "../../../contracts/conversations/turn-stop";
import type { ArtifactPointer } from "../../../contracts/artifacts/artifact-contract";
import type { ProjectSessionPresentationMode } from "../../../contracts/project-sessions/project-session-presentation";
import { assertSessionPath } from "./session-path";
import { cakeWorkspaceSessionDirectory, findSessionFile } from "./session-discovery";
import {
  reviewRunEntrySchema,
  reviewRunEntryType,
  reviewRunPart,
  userMessagePresentationEntrySchema,
  userMessagePresentationEntryType,
  type ReviewRunEntry,
} from "./session-projection";
import { type AbortPresentation } from "./message-projection";
import {
  activeCompactionNotice,
  createCakeSessionRuntimeEventProjection,
} from "./cake-session-runtime-event-projection";
import { projectCakeSessionRuntimeSnapshot } from "./cake-session-runtime-snapshot";
import { createCakeSessionRuntimeTurnController } from "./cake-session-runtime-turn-controller";
import { createCakeSessionRuntimeRecovery } from "./cake-session-runtime-recovery";
import type { RuntimeRecoveryInput } from "../../storage/RuntimeRecoveryStorage";
import { restartDecision, restartResumePrompt, unfinishedTools } from "./restart-recovery";
import {
  createCakeSessionRuntimeResourceLifecycle,
  shutdownCakeSessionExtensions,
} from "./cake-session-runtime-resources";
import { createCakeMcpExtensions } from "./mcp-integration";

import { type ConversationResponseMode } from "../../../contracts/conversations/response-mode-reminders";
import { createCakeSessionRuntimeCapabilities } from "./cake-session-runtime-capabilities";
import type {
  ProjectCakeOperations,
  CoordinatorCakeOperations,
} from "../../../contracts/agent/cake-operation-api";
import type { CakeOperationHost } from "../../../contracts/agent/cake-operation-context";
import type {
  CakeOperationDefinition,
  CakeOperationInvocation,
} from "../../../contracts/agent/cake-operation";
import { createPromptCacheLineage } from "./prompt-cache-lineage";
import { emptyToolErrorExtension } from "./tool-error-text";
import { projectCakeOperationRuntime } from "./cake-operation-context";
import {
  createCakeSessionRuntimeConfiguration,
  createCakeSessionRuntimeConfigurationState,
} from "./cake-session-runtime-configuration";
import { createCakeSessionRuntimeContinuations } from "./cake-session-runtime-continuations";
import type { RuntimeUiRequest } from "./runtime-ui-request";
import type { ReviewParentContext } from "./sidecar-runtime";

export const piRuntimeVersion = "1.0.0" as const;

export type CakeSessionRuntimeEvent =
  | { type: "snapshot"; requestId?: string; snapshot: ConversationSnapshot }
  | { type: "part-updated"; sessionId: string; part: UiPart }
  | { type: "part-removed"; sessionId: string; partId: string }
  | { type: "streaming"; sessionId: string; streaming: boolean }
  | { type: "usage-updated"; sessionId: string; usage: SessionUsage }
  | { type: "extension-ui"; sessionId: string; event: ExtensionUiEvent };

export interface CakeSessionRuntimeOptions {
  /** Called only after Pi has written the first conversation message to its JSONL. */
  onInitialTranscriptPersisted?(): void;
  cwd: string;
  tools?: string[];
  auxiliary?: boolean;
  operations?: ProjectCakeOperations;
  coordinator?: {
    operations: CoordinatorCakeOperations;
    modelPresets?(): CakeModelPresetCatalog;
  };
  /** Live hooks used by Pi-backed continuation and metadata operations. */
  currentSessionControl?: CurrentSessionControl;
  sessionReferences?: SessionReferenceControl;
  persistArtifact?: CakeArtifactOperationOptions["persistArtifact"];
  /** Provider-free compilation and retention for built-in artifact diagnostics. */
  compileArtifactBrowser?: ArtifactExtensionOptions["compileArtifactBrowser"];
  messageBoardControl?: MessageBoardControl;
  /** Child runtimes report their own costs separately. */
  partialPricingCoverage?: boolean;
  agentDir: string;
  sessionDir: string;
  /** Dedicated session directories (such as Discussion threads) have no workspace subdirectory. */
  directSessionDir?: boolean;
  newSession?: boolean;
  sessionId?: string;
  sessionFile?: string;
  additionalSystemPrompt?: string;
  /** How this Project lands Managed Worktree work; `pull-request` never merges through Cake. */
  worktreeLanding?: "merge" | "pull-request";
  /** Permanent chats reread project-owned guidance at each message; never used by coding runtimes. */
  cakeChatSystemPrompt?(): string;
  /** Live list for presentation-only background turn attribution. */
  cakeChatTodos?(): readonly ProjectTodo[];
  /** Durable calls this only for committed, consumed input, never send preparation or queued rows. */
  onCakeChatInputConsumed?(text: string, signal: AbortSignal): Promise<void>;
  cakeChatMemory?: CakeChatMemoryOptions;
  /** Replaces Pi's normal prompt and disables context-file loading for an isolated runtime. */
  isolatedSystemPrompt?: string;
  /** Explicit SDK tools available only to this runtime. */
  customTools?: ToolDefinition[];
  /** In-memory Pi history; never creates or resumes a persisted session. */
  ephemeral?: boolean;
  /** Fresh project resources/MCP with investigation-only instructions and no edit/write tools. */
  projectInvestigation?: boolean;
  /** Project investigators only: replace the investigation-only policy with scoped mutation mode. */
  allowMutations?: boolean;
  /** Workflow workers load project context/skills, but not Cake controls or project-chat prompts. */
  auxiliaryProjectResources?: boolean;
  /**
   * Unattended runtimes compact near their context window even when the user's Pi
   * auto-compact setting is off: nobody can compact them by hand mid-run.
   */
  alwaysAutoCompact?: boolean;
  /** Subset of builtin slash command names to advertise; defaults to all of them. */
  slashCommands?: readonly string[];
  /** Composition supplies only Discussion-authorized interview operations to Durable. */
  interviewOperations?(bridge: {
    host: CakeOperationHost;
    publishSnapshot(): Promise<void>;
  }): CakeOperationDefinition[];
  requestUi(request: RuntimeUiRequest): Promise<string | undefined>;
  emitExtensionUiIntent?(intent: ExtensionUiIntent): void;
  reviewContextPath?(sessionId: string): string;
  utilityModel?(): UtilityModel | undefined;
  /**
   * Cake policy is supplied by composition; Pi only applies concrete configurations. `caller`
   * is the calling session's current configuration; `launch` says whether a session or a
   * subagent is being launched, which decides what an omitted selection resolves to.
   */
  resolveModelSelection?(
    selection: CakeModelSelection | undefined,
    caller: ExplicitCakeModelSelection | undefined,
    launch?: CakeModelLaunch,
  ): ExplicitCakeModelSelection;
  fastMode?: {
    get(): boolean;
    set(enabled: boolean): Promise<void>;
  };
  generateSessionTitle?(input: {
    utilityModel: UtilityModel;
    firstUserMessage: string;
    signal?: AbortSignal;
  }): Promise<string>;
  autoLabelSession?(input: {
    utilityModel: UtilityModel;
    firstUserMessage: string;
    signal?: AbortSignal;
  }): Promise<void>;
  sessionTitleChanged?(sessionId: string, title: string): Promise<void>;
  onEvent(event: CakeSessionRuntimeEvent): void;
  onTurnResult?(turnId: string, result: PiTurnResult): void;
}

import type { SideChatHistory, SideChatHistoryImport } from "../side-chat-history";
import { exportRegularSideChatHistory } from "./side-chat-history";

export interface CakeSessionRuntime {
  exportSideChatHistory?(): Promise<SideChatHistory>;
  importSideChatHistory?(input: SideChatHistoryImport): Promise<{ importedMessages: number }>;
  readonly sessionId: string;
  readonly sessionFile: string;
  /** Returns Pi's live turn state without assembling a ConversationSnapshot. */
  readonly streaming: boolean;
  executingTurnIds?(): ReadonlyArray<string>;
  recoverInput?(input: RuntimeRecoveryInput): Promise<void>;
  restoreInput?(input: RuntimeRecoveryInput): Promise<void>;
  hasConsumedInput?(turnId: string): boolean;
  pendingRecoveryInputs?(): ReadonlyArray<{
    turnId: string;
    delivery: "steer" | "follow-up";
    text: string;
    internal?: InternalInput;
  }>;
  getReviewParentContext?(): ReviewParentContext;
  recordReviewRun(run: ReviewRunEntry): void;
  snapshot(): Promise<ConversationSnapshot>;
  history?(cursor: string): Promise<{ parts: UiPart[]; cursor?: string }>;
  /** Runtimes with their own durable inbox; others admit worker reports as ordinary input. */
  notifySubagentCompletion?(result: JsonValue, completionId?: string): Promise<void>;
  prompt(
    text: string,
    delivery: "prompt" | "steer" | "follow-up",
    attachments: Attachment[],
    renderUserMessageAsMarkdown?: boolean,
    turnId?: string,
    presentationMode?: ProjectSessionPresentationMode,
    automaticTitle?: boolean,
    responseMode?: ConversationResponseMode,
    internal?: RuntimeRecoveryInput["internal"],
  ): Promise<void>;
  listQueuedMessages(): Promise<{ steering: string[]; followUp: string[] }>;
  pendingMessages(): Promise<PiPendingMessages>;
  reorderPendingMessage(input: PiPendingMessageReorder): Promise<PiPendingMessages>;
  clearQueue(): Promise<{ steering: string[]; followUp: string[] }>;
  cancelSteering(): Promise<{ steering: string[]; followUp: string[] }>;
  updateQueuedMessage(
    partId: string,
    text: string,
  ): Promise<{ steering: string[]; followUp: string[] }>;
  removeQueuedMessage(partId: string): Promise<{ steering: string[]; followUp: string[] }>;
  steerQueuedMessage(partId: string): Promise<{ steering: string[]; followUp: string[] }>;
  sendQueuedMessageNow(partId?: string): Promise<{
    queued: { steering: string[]; followUp: string[] };
    abortedTurnIds: string[];
  }>;
  editMessage?(
    entryId: string,
    text: string,
    attachments: Attachment[],
    renderUserMessageAsMarkdown: boolean,
    presentationMode?: ProjectSessionPresentationMode,
    responseMode?: ConversationResponseMode,
  ): Promise<void>;
  setUserMessageMarkdown(entryId: string, renderAsMarkdown: boolean): Promise<void>;
  compact(instructions?: string): Promise<void>;
  compactMemory?(): Promise<void>;
  compactIfIdle?(instructions?: string): Promise<IdleCompactionResult>;
  toolCompactIfIdle?(): Promise<IdleCompactionResult>;
  queueCommand(command: string, onSettled?: () => void): Promise<QueuedSessionCommandReceipt>;
  inspectSession(query: SessionInspectionQuery): Promise<JsonValue>;
  /** `stop` attributes a deliberate stop; omitted, the abort reads as an interruption. */
  abort(stop?: TurnStop): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  /** Applies a full chat configuration atomically, emitting a single snapshot. */
  applyConfiguration(configuration: ChatConfiguration): Promise<void>;
  setFastMode?(enabled: boolean): Promise<void>;
  syncFastMode?(): Promise<void>;
  setPiSetting(update: PiSettingUpdate): Promise<void>;
  reload?(): Promise<void>;
  callCakeOperation?(command: string, input: JsonObject, signal: AbortSignal): Promise<JsonValue>;
  callCakeTool?(
    command: string,
    input: JsonObject,
    signal: AbortSignal,
  ): Promise<CakeOperationInvocation>;
  dispatchExtensionCompanionAction?(id: string, action: string, value: JsonValue): Promise<void>;
  refreshModels?(): Promise<void>;
  rename(name: string, onlyIfUnnamed?: boolean): Promise<void>;
  fork(
    entryId: string,
    title: string,
  ): Promise<{
    sessionId: string;
    sessionFile: string;
    artifactPointers: ReadonlyArray<ArtifactPointer>;
  }>;
  toolCompact(entryId: string): Promise<{ sessionId: string; sessionFile: string }>;
  navigate(
    entryId: string,
    options: { summarize: boolean; customInstructions?: string },
  ): Promise<void>;
  dispose(): void | Promise<void>;
}

export async function createCakeSessionRuntime(
  options: CakeSessionRuntimeOptions,
): Promise<CakeSessionRuntime> {
  if (options.coordinator) throw new Error("Cake Chat is owned by the Durable coordinator service");
  const agentDir = options.agentDir;
  // Check the backend root before acquiring any Pi resources.
  const mcpExtensions = createCakeMcpExtensions({ runtime: options });
  const settingsManager = SettingsManager.create(options.cwd, agentDir, {
    projectTrusted: true,
  });
  if (options.alwaysAutoCompact) keepAutoCompactionEnabled(settingsManager);
  const modelRuntime = await ModelRuntime.create({
    authPath: `${agentDir}/auth.json`,
    modelsPath: `${agentDir}/models.json`,
    modelsStorePath: `${agentDir}/models-cache.json`,
  });
  const configurationState = createCakeSessionRuntimeConfigurationState(options.fastMode);
  const promptCacheLineage = createPromptCacheLineage();
  const capabilities = await createCakeSessionRuntimeCapabilities({
    options,
    publishSnapshot: () => emitSnapshot(),
    agentDir,
    settingsManager,
    modelRuntime,
    requestExtensions: [
      configurationState.fastModeExtension,
      promptCacheLineage.extension,
      emptyToolErrorExtension,
      ...mcpExtensions,
    ],
  });
  if (options.projectInvestigation && !options.auxiliary)
    throw new Error("Project investigators require an auxiliary runtime");
  if (options.allowMutations && !options.projectInvestigation)
    throw new Error("Mutation mode applies only to project investigator runtimes");
  if (options.ephemeral && (!options.newSession || options.sessionFile))
    throw new Error("An ephemeral runtime must create a new in-memory session");
  const sessionDir = options.directSessionDir
    ? resolve(options.sessionDir)
    : cakeWorkspaceSessionDirectory(options.cwd, options.sessionDir);
  const allowedSessionRoot = sessionDir;
  let directSession: SessionManager | undefined;
  if (options.sessionFile) {
    assertSessionPath(options.sessionFile, allowedSessionRoot, "Session file");
    directSession = SessionManager.open(options.sessionFile, sessionDir, options.cwd);
  }
  const requestedSessionFile =
    options.sessionId && !options.newSession
      ? await findSessionFile(
          options.cwd,
          options.sessionId,
          options.sessionDir,
          options.directSessionDir,
        )
      : undefined;
  if (options.sessionId && !options.newSession && !requestedSessionFile && !directSession)
    throw new Error("That session is no longer available");
  const sessionManager = options.ephemeral
    ? SessionManager.inMemory(
        options.cwd,
        options.sessionId ? { id: options.sessionId } : undefined,
      )
    : options.newSession
      ? SessionManager.create(
          options.cwd,
          sessionDir,
          options.sessionId ? { id: options.sessionId } : undefined,
        )
      : (directSession ??
        (requestedSessionFile
          ? SessionManager.open(requestedSessionFile, sessionDir, options.cwd)
          : SessionManager.continueRecent(options.cwd, sessionDir)));
  // Extension providers must exist before createAgentSession resolves the
  // initial model, or a default or resumed model on one of them falls back.
  // Auxiliary sessions take the agent directory's providers directly because
  // their isolated resource loaders run with `noExtensions`.
  const providerErrors =
    options.auxiliary && !options.projectInvestigation
      ? await registerAgentDirectoryExtensionProviders(agentDir, modelRuntime)
      : await registerPendingExtensionProviders(capabilities.resourceLoader, modelRuntime);
  assertInitialModelRegistered(modelRuntime, settingsManager, sessionManager);
  const agentSessionOptions = {
    cwd: options.cwd,
    agentDir,
    modelRuntime,
    resourceLoader: capabilities.resourceLoader,
    settingsManager,
    sessionManager,
    ...(options.customTools ? { customTools: options.customTools } : null),
    ...(options.projectInvestigation ? { excludeTools: ["edit", "write"] } : null),
  };
  const { session, extensionsResult, modelFallbackMessage } = await createAgentSession(
    options.tools ? { ...agentSessionOptions, tools: options.tools } : agentSessionOptions,
  );
  if (options.messageBoardControl)
    observeMessageBoardRequests(session, options.messageBoardControl);
  const cakeSessionId = session.sessionManager.getSessionId();
  configurationState.attachModel(session.model);
  configurationState.attachSession(session.sessionManager);
  capabilities.setSessionId(cakeSessionId);
  // Ancestors of a Working Directory fork live under sibling workspace session
  // directories, so lineage resolution is bounded by the shared session root.
  await promptCacheLineage.attach({
    sessionManager: session.sessionManager,
    sessionRoots: [resolve(options.sessionDir)],
  });
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  const emitPart = (part: UiPart) =>
    options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part });
  const removePart = (partId: string) =>
    options.onEvent({ type: "part-removed", sessionId: cakeSessionId, partId });
  const recovery = createCakeSessionRuntimeRecovery({
    session,
    retryEnabled: () => settingsManager.getRetryEnabled(),
    isDisposed: () => disposed,
    emitPart,
    removePart,
  });
  const resources = await createCakeSessionRuntimeResourceLifecycle({
    resourceLoader: capabilities.resourceLoader,
    settingsManager,
    eventBus: capabilities.eventBus,
    loadCompanions: !options.auxiliary,
    workingDirectory: options.cwd,
    agentDirectory: agentDir,
    session,
    requestUi: (request) => options.requestUi(request),
    emitExtensionUiIntent: options.emitExtensionUiIntent,
    emitEvent: (event) =>
      options.onEvent({ type: "extension-ui", sessionId: cakeSessionId, event }),
    emitPart,
    removePart,
    emitSnapshot: () => emitSnapshot(),
  });

  let compactionQueuedMessages: () => readonly string[] = () => [];
  const queueProjection = { parts: (): UiPart[] => [], handoffActive: () => false };
  // Attribution for the deliberate stop in progress; the aborted message is marked with it.
  let pendingStop: TurnStop | undefined;
  const abortPresentation = (): AbortPresentation =>
    queueProjection.handoffActive()
      ? { kind: "handoff" }
      : pendingStop
        ? { kind: "stopped", stop: pendingStop }
        : { kind: "interrupted" };
  const projection = createCakeSessionRuntimeEventProjection({
    session,
    sessionId: cakeSessionId,
    emit: options.onEvent,
    compactionQueuedMessages: () => compactionQueuedMessages(),
    queuedParts: () => queueProjection.parts(),
    internalInput: (content) => turnController.internalInput(content),
    abortPresentation,
    isDisposed: () => disposed,
  });
  const configuration = createCakeSessionRuntimeConfiguration({
    options,
    modelRuntime,
    settingsManager,
    session,
    state: configurationState,
    emitSnapshot: () => emitSnapshot(),
    cancelResponseRetries: recovery.cancelResponseRetries,
    reportAgentAction: capabilities.reportAgentAction,
  });

  let stoppedParts: UiPart[] | undefined;
  let abortFailure: unknown;
  const cancellationNotice = (): UiPart => ({
    id: "abort-cleanup",
    kind: "notice",
    tone: abortFailure ? "error" : "info",
    title: abortFailure ? "Cancellation cleanup failed" : "Cancellation requested",
    detail: abortFailure
      ? "Cleanup did not finish. New input cannot run in this session."
      : "Provider or tool cleanup is still pending. New input will wait.",
  });

  function captureSnapshot(
    models: ConversationSnapshot["models"],
    sessionListed: boolean,
  ): ConversationSnapshot {
    const snapshot = projectCakeSessionRuntimeSnapshot({
      workspacePath: options.cwd,
      sessionId: cakeSessionId,
      sessionListed,
      auxiliary: Boolean(options.auxiliary),
      session,
      settingsManager,
      models: [...models],
      // SessionManager contains finalized entries; Pi owns the in-flight response.
      // Use its current message with the same part IDs as the streamed deltas.
      streamingParts: projection.streamingParts(),
      queuedParts: projection.queuedParts(),
      transientParts: [
        ...turnController.bashParts(),
        ...(session.isCompacting ? [activeCompactionNotice()] : []),
        ...recovery.transientParts(),
      ],
      fastMode: configurationState.enabledFastMode(),
      preset: configurationState.preset(),
      commands: options.auxiliary ? [] : resources.commandCatalog(),
      slashCommands: options.slashCommands,
      usage: projection.currentUsage(),
      compatibility: resources.compatibility,
      extensionUi: resources.extensionUi,
      diagnostics: [
        ...extensionsResult.errors.map((error) => `${error.path}: ${error.error}`),
        ...providerErrors,
        ...(modelFallbackMessage ? [modelFallbackMessage] : []),
      ],
      reloadPending: resources.reloadPending(),
    });
    if (stoppedParts) {
      return {
        ...snapshot,
        streaming: false,
        parts: [
          ...stoppedParts,
          ...projection.queuedParts(),
          ...(turnController.cancellationPending() ? [cancellationNotice()] : []),
        ],
      };
    }
    return snapshot;
  }

  async function makeSnapshot(
    onCaptured?: (snapshot: ConversationSnapshot) => void,
  ): Promise<ConversationSnapshot> {
    const [sessionFile, models] = await Promise.all([
      options.auxiliary
        ? Promise.resolve(undefined)
        : findSessionFile(options.cwd, cakeSessionId, options.sessionDir, options.directSessionDir),
      options.auxiliary ? Promise.resolve([]) : configuration.modelOptions(),
    ]);
    const snapshot = captureSnapshot(models, sessionFile !== undefined);
    onCaptured?.(snapshot);
    return snapshot;
  }

  async function emitSnapshot(requestId?: string) {
    if (disposed) return;
    await makeSnapshot((snapshot) => {
      if (!disposed) options.onEvent({ type: "snapshot", requestId, snapshot });
    });
  }

  function emitSnapshotInBackground() {
    void emitSnapshot().catch(() => undefined);
  }

  const turnController = createCakeSessionRuntimeTurnController({
    session,
    isDisposed: () => disposed,
    allowUserBash: true,
    onTurnStarted: () => {
      stoppedParts = undefined;
      projection.resume();
    },
    onAbortRequested: projection.stop,
    onAbortSignaled: () => {
      abortFailure = undefined;
      // Freeze the display after signaling Pi, without awaiting its cleanup.
      const queuedIds = new Set(projection.queuedParts().map((part) => part.id));
      stoppedParts = captureSnapshot([], false)
        .parts.filter(
          (part) =>
            !queuedIds.has(part.id) &&
            part.id !== "active-retry" &&
            part.id !== "active-compaction",
        )
        .map((part) =>
          part.kind === "text" && part.status === "streaming"
            ? { ...part, status: "complete" }
            : part.kind === "tool" && part.state === "running"
              ? { ...part, state: "interrupted" }
              : part,
        );
      emitPart(cancellationNotice());
    },
    onAbortSettled: (error) => {
      if (!error)
        stoppedParts = stoppedParts?.map((part) =>
          part.kind === "command" && part.state === "running" ? { ...part, state: "error" } : part,
        );
      abortFailure = error;
      pendingStop = undefined;
      if (error) emitPart(cancellationNotice());
      else removePart("abort-cleanup");
    },
    beforeIdleTurn: async () => {
      await resources.drainReloads();
    },
    withResponseRetries: recovery.withResponseRetries,
    cancelResponseRetries: recovery.cancelResponseRetries,
    recovery,
    deliverTrackedUserMessage: projection.deliverTrackedUserMessage,
    syncQueuedParts: projection.syncQueuedParts,
    emitPart,
    emitSnapshot: () => emitSnapshot(),
    emitSnapshotInBackground,
    reportQueuedCommandError: (command, error) => {
      session.sessionManager.appendCustomMessageEntry(
        "cake.queued-command-error",
        `Queued command failed (${command}): ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    },
    executeQueuedCommand: async (command) => {
      await resources.drainReloads();
      const name = command.slice(1).split(/\s/, 1)[0];
      if (name === "compact") {
        await turnController.compact(command.slice("/compact".length).trim() || undefined);
      } else if (name === "toolcompact") {
        await toolCompactLatest();
      } else {
        if (!resources.commandCatalog().some((item) => item.name === name))
          throw new Error(`Command /${name} is no longer available`);
        await recovery.withResponseRetries(() =>
          session.prompt(command, { source: "interactive" }),
        );
      }
    },
  });
  compactionQueuedMessages = turnController.compactionQueuedMessages;
  queueProjection.parts = turnController.queuedParts;
  queueProjection.handoffActive = turnController.handoffActive;

  const continuations = createCakeSessionRuntimeContinuations({
    options,
    session,
    sessionId: cakeSessionId,
    isDisposed: () => disposed,
    emitSnapshot: () => emitSnapshot(),
    emitNotice: emitPart,
    drainReloads: resources.drainReloads,
    handleSettledTurn: recovery.handleSettledTurn,
    reportAgentAction: capabilities.reportAgentAction,
  });

  const toolCompactLatest = async () => {
    const entry = session.sessionManager
      .getBranch()
      .findLast(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          entry.message.stopReason === "stop" &&
          entry.message.content.some((block) => block.type === "text" && block.text.trim()),
      );
    if (!entry) throw new Error("Tool compaction requires a completed assistant response");
    await continuations.toolCompact(entry.id);
  };

  const subscription = createCakeSessionRuntimeSubscription({
    options,
    session,
    turnController,
    projection,
    continuations,
    isDisposed: () => disposed,
    abortPresentation,
    emitSnapshotInBackground,
  });

  capabilities.operationApi.current = createCakeSessionRuntimeOperationApi({
    options,
    session,
    configuration,
    continuations,
    capabilities,
    turnController,
  });

  const callCakeTool = async (
    command: string,
    input: JsonObject,
    signal: AbortSignal,
  ): Promise<CakeOperationInvocation> => {
    if (disposed) throw new Error("The Cake runtime has been disposed");
    const registry = capabilities.operationRegistry.current;
    if (!registry) throw new Error("Cake operations are unavailable");
    return registry.invoke(
      { command, input },
      {
        signal,
        toolCallId: `cake-tool:${crypto.randomUUID()}`,
        runtime: projectCakeOperationRuntime(session, `cake-operation-${command}`),
      },
    );
  };

  return {
    callCakeTool,
    sessionId: cakeSessionId,
    get sessionFile() {
      return session.sessionFile ?? "";
    },
    get streaming() {
      return (
        !stoppedParts &&
        (session.isStreaming ||
          session.isCompacting ||
          turnController.idleCompactionActive() ||
          turnController.toolCompactionActive())
      );
    },
    getReviewParentContext() {
      if (!session.sessionFile) throw new Error("The parent session is not persisted");
      const leafId = session.sessionManager.getLeafId() ?? undefined;
      return {
        sessionId: cakeSessionId,
        sessionFile: session.sessionFile,
        leafId,
        systemPrompt: session.systemPrompt,
        activeTools: session.getActiveToolNames(),
        model: session.model
          ? { provider: session.model.provider, id: session.model.id }
          : undefined,
      };
    },
    recordReviewRun(run) {
      if (disposed) throw new Error("The Cake runtime has been disposed");
      const parsed = Schema.decodeUnknownSync(reviewRunEntrySchema)(run);
      session.sessionManager.appendCustomEntry(reviewRunEntryType, parsed);
      emitPart(reviewRunPart(parsed));
    },
    async exportSideChatHistory() {
      if (disposed) throw new Error("The Cake runtime has been disposed");
      if (
        session.isStreaming ||
        session.isCompacting ||
        turnController.idleCompactionActive() ||
        turnController.toolCompactionActive() ||
        session.getSteeringMessages().length ||
        session.getFollowUpMessages().length ||
        turnController.pendingRecoveryInputs().length
      )
        throw new Error("Wait for both chats to be idle before merging side-chat history");
      return exportRegularSideChatHistory(cakeSessionId, session.sessionManager.getBranch());
    },
    snapshot: () => makeSnapshot(),
    restoreInput: (input) =>
      turnController.restorePending({ ...input, attachments: [...input.attachments] }),
    pendingRecoveryInputs: turnController.pendingRecoveryInputs,
    hasConsumedInput(turnId) {
      return restartDecision(session.sessionManager.getEntries(), turnId).kind !== "pending";
    },
    async recoverInput(input) {
      const decision = restartDecision(session.sessionManager.getBranch(), input.turnId);
      if (decision.kind === "settled") {
        options.onTurnResult?.(input.turnId, decision.result);
        return;
      }
      if (decision.kind === "pending" && !/^[!/]/.test(input.text)) {
        await turnController.prompt(
          input.text,
          input.delivery,
          [...input.attachments],
          input.markdown,
          input.turnId,
          input.presentationMode,
          input.responseMode,
          input.internal,
        );
        return;
      }
      await turnController.resume(
        input.turnId,
        restartResumePrompt(
          decision.kind === "resume" ? decision.interruptedTools : [],
          decision.kind === "pending" ? input.text : undefined,
        ),
      );
      const settled = restartDecision(session.sessionManager.getBranch(), input.turnId);
      if (settled.kind === "settled") options.onTurnResult?.(input.turnId, settled.result);
    },
    compact: turnController.compact,
    compactIfIdle: turnController.compactIfIdle,
    toolCompactIfIdle: () => turnController.toolCompactIfIdle(toolCompactLatest),
    async queueCommand(command, onSettled) {
      const name = command.slice(1).split(/\s/, 1)[0];
      if (
        name !== "compact" &&
        name !== "toolcompact" &&
        !resources.commandCatalog().some((item) => item.name === name)
      )
        throw new Error(
          `Command /${name} cannot be queued. Inspect sessions.commands for available commands.`,
        );
      if (name === "toolcompact" && command.trim() !== "/toolcompact")
        throw new Error("Queued /toolcompact takes no arguments");
      return turnController.queueCommand(command, onSettled);
    },
    async inspectSession(query) {
      if (disposed) throw new Error("The Cake runtime has been disposed");
      if (query.kind === "context-outline")
        return Schema.decodeUnknownSync(jsonValueSchema)(
          projectContextInspection(session, options.cwd, runtimeSystemTools(session)),
        );
      if (query.kind === "memory-detail")
        return Schema.decodeUnknownSync(jsonValueSchema)(
          projectMemoryDetail(session.sessionManager, query.entryId ?? "", query.offset),
        );
      if (query.kind === "messages-list")
        return Schema.decodeUnknownSync(jsonValueSchema)(
          listMessageReferences(session.sessionManager, {
            ...query,
            roles: query.roles?.filter(
              (role): role is "user" | "assistant" | "toolResult" | "bashExecution" =>
                role === "user" ||
                role === "assistant" ||
                role === "toolResult" ||
                role === "bashExecution",
            ),
          }),
        );
      if (query.kind === "messages-read")
        return Schema.decodeUnknownSync(jsonValueSchema)(
          readMessageReference(session.sessionManager, query),
        );
      const api = capabilities.operationApi.current;
      if (!api) throw new Error("The Cake session is not ready");
      if (query.kind === "context") return api.contextStatus();
      if (query.kind === "usage") return api.usage();
      if (query.kind === "pending")
        return Schema.decodeUnknownSync(jsonValueSchema)(await turnController.pendingMessages());
      if (query.kind === "commands")
        return Schema.decodeUnknownSync(jsonValueSchema)({
          commands: [...builtinSlashCommands, ...resources.commandCatalog()].map((command) => ({
            name: command.name,
            description: command.description,
            source: command.source,
            queueable:
              command.name === "compact" ||
              command.name === "toolcompact" ||
              command.source !== "builtin",
          })),
        });
      return inspectSessionHistory(
        session.sessionManager,
        query.kind === "compactions"
          ? {
              ...query,
              branch: query.branch ?? (query.leafId ? "active" : "all"),
              types: ["compaction", "tool-compaction"],
            }
          : query.kind === "tree"
            ? {
                ...query,
                branch: query.branch ?? (query.leafId ? "active" : "all"),
                maxChars: query.maxChars ?? 200,
              }
            : query,
      );
    },
    executingTurnIds: turnController.executingTurnIds,
    async prompt(
      text,
      delivery,
      attachments,
      markdown,
      turnId,
      presentationMode,
      automaticTitle = true,
      responseMode,
      internal,
    ) {
      subscription.setAutomaticTitle(automaticTitle);
      // Manual Continue (including after an explicit stop) must inspect uncertain
      // effects too, without automatically resuming deliberately stopped work.
      const interruptedTools = !session.isStreaming
        ? unfinishedTools(session.sessionManager.getBranch())
        : [];
      if (interruptedTools.length)
        await session.sendCustomMessage(
          {
            customType: "cake.restart-recovery",
            content: restartResumePrompt(interruptedTools),
            display: false,
          },
          { triggerTurn: false },
        );
      return turnController.prompt(
        text,
        delivery,
        attachments,
        markdown,
        turnId,
        presentationMode,
        responseMode,
        internal,
      );
    },
    listQueuedMessages: turnController.listQueuedMessages,
    pendingMessages: turnController.pendingMessages,
    reorderPendingMessage: turnController.reorderPendingMessage,
    clearQueue: turnController.clearQueue,
    cancelSteering: turnController.cancelSteering,
    updateQueuedMessage: turnController.updateQueuedMessage,
    removeQueuedMessage: turnController.removeQueuedMessage,
    steerQueuedMessage: turnController.steerQueuedMessage,
    sendQueuedMessageNow: turnController.sendQueuedMessageNow,
    async setUserMessageMarkdown(entryId, renderAsMarkdown) {
      if (disposed) throw new Error("The Cake runtime has been disposed");
      const target = session.sessionManager
        .getBranch()
        .find(
          (entry) =>
            entry.type === "message" && entry.id === entryId && entry.message.role === "user",
        );
      if (!target) throw new Error("The user message is not in the active conversation");
      const presentation = Schema.decodeUnknownSync(userMessagePresentationEntrySchema)({
        targetId: entryId,
        renderAs: renderAsMarkdown ? "markdown" : "plain",
      });
      session.sessionManager.appendCustomEntry(userMessagePresentationEntryType, presentation);
      await emitSnapshot();
    },
    editMessage: turnController.editMessage,
    async abort(stop) {
      pendingStop = stop;
      await shutdownDiagnostics.promise("pi.turn.abort", shutdownResource(cakeSessionId), () =>
        turnController.abort(),
      );
    },
    setModel: configuration.setModel,
    setThinkingLevel: configuration.setThinkingLevel,
    applyConfiguration: configuration.applyConfiguration,
    setFastMode: configuration.setFastMode,
    syncFastMode: configuration.syncFastMode,
    setPiSetting: configuration.setPiSetting,
    reload: resources.requestReload,
    async callCakeOperation(command, input, signal) {
      const result = await callCakeTool(command, input, signal);
      if (
        typeof result.details === "object" &&
        result.details !== null &&
        !Array.isArray(result.details) &&
        "result" in result.details
      )
        return result.details.result;
      return result.details;
    },
    dispatchExtensionCompanionAction: resources.dispatchCompanionAction,
    refreshModels: configuration.refreshModels,
    async rename(name, onlyIfUnnamed = false) {
      await continuations.rename(name, false, onlyIfUnnamed);
    },
    fork: continuations.fork,
    toolCompact: (entryId) =>
      turnController.withToolCompaction(() => continuations.toolCompact(entryId)),
    async navigate(entryId, options) {
      const result = await session.navigateTree(entryId, options);
      if (result.cancelled) throw new Error("Session tree navigation was cancelled");
      await emitSnapshot();
    },
    dispose() {
      if (disposed) return disposePromise;
      disposed = true;
      const resource = shutdownResource(cakeSessionId);
      shutdownDiagnostics.sync("pi.localCleanup", resource, () => {
        turnController.dispose();
        continuations.dispose();
        projection.dispose();
        recovery.dispose();
        resources.dispose();
        subscription.dispose();
      });
      disposePromise = shutdownDiagnostics.promise("pi.dispose", resource, async () => {
        try {
          await shutdownDiagnostics.promise("pi.abort", resource, () => session.abort());
          // An already-running reload owns its own shutdown. Let it retire
          // before shutting down the final extension runtime.
          await shutdownDiagnostics.promise("pi.drainReloads", resource, () =>
            resources.drainReloads(),
          );
        } finally {
          try {
            await shutdownDiagnostics.promise("pi.extensions.shutdown", resource, () =>
              shutdownCakeSessionExtensions(session),
            );
          } finally {
            shutdownDiagnostics.sync("pi.session.dispose", resource, () => session.dispose());
            await shutdownDiagnostics.promise("pi.settings.flush", resource, () =>
              settingsManager.flush(),
            );
          }
        }
      });
      return disposePromise;
    },
  };
}
