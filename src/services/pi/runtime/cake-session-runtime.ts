import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { observeMessageBoardRequests } from "./message-board-extension";
import { createTurnResultCapture } from "./turn-result-capture";
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
import { Option, Schema } from "effect";
import {
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
import { crossSessionContextSnapshot } from "../../../contracts/conversations/cross-session-message";
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
import { piBuiltinSlashCommands } from "../../../contracts/conversations/session-contract";
import { SubagentResult as subagentResultSchema } from "../../../contracts/subagents/subagent-data";
import { subagentFinalAnswer } from "../../../contracts/subagents/subagent-report";
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
  textFromContent,
  userMessagePresentationEntrySchema,
  userMessagePresentationEntryType,
  turnHandoffEntryType,
  turnStopEntryType,
  type AbortPresentation,
  type ReviewRunEntry,
} from "./session-projection";
import {
  activeCompactionNotice,
  createCakeSessionRuntimeEventProjection,
} from "./cake-session-runtime-event-projection";
import { projectCakeSessionRuntimeSnapshot } from "./cake-session-runtime-snapshot";
import { createCakeSessionRuntimeTurnController } from "./cake-session-runtime-turn-controller";
import { createCakeSessionRuntimeRecovery } from "./cake-session-runtime-recovery";
import type { RuntimeRecoveryInput } from "../../storage/RuntimeRecoveryStorage";
import {
  recoveryInputEntryType,
  restartDecision,
  restartResumePrompt,
  RestartRecoveryBlockedError,
} from "./restart-recovery";
import {
  createCakeSessionRuntimeResourceLifecycle,
  shutdownCakeSessionExtensions,
} from "./cake-session-runtime-resources";
import { createCakeMcpExtensions } from "./mcp-integration";
import { stripPresentationModeReminder } from "../../../contracts/conversations/presentation-mode-reminders";
import {
  stripResponseModeReminder,
  type ConversationResponseMode,
} from "../../../contracts/conversations/response-mode-reminders";
import { createCakeSessionRuntimeCapabilities } from "./cake-session-runtime-capabilities";
import type {
  ProjectCakeOperations,
  CoordinatorCakeOperations,
} from "../../../contracts/agent/cake-operation-api";
import { createPromptCacheLineage } from "./prompt-cache-lineage";
import { projectCakeOperationRuntime } from "./cake-operation-context";
import {
  createCakeSessionRuntimeConfiguration,
  createCakeSessionRuntimeConfigurationState,
} from "./cake-session-runtime-configuration";
import { createCakeSessionRuntimeContinuations } from "./cake-session-runtime-continuations";
import type { RuntimeUiRequest } from "./runtime-ui-request";
import type { ReviewParentContext } from "./sidecar-runtime";

export const piRuntimeVersion = "1.0.0" as const;

const SUBAGENT_REPORT_LIMIT = 16_000;

/** Formats the parent-facing report without copying verbose child tool activity into model context. */
export function subagentCompletionMessage(value: JsonValue): string {
  const decoded = Schema.decodeUnknownOption(subagentResultSchema)(value);
  if (Option.isNone(decoded)) return "A background subagent finished, but its report was invalid.";

  const result = decoded.value;
  const finalAnswer = subagentFinalAnswer(result)?.trim();
  const heading = `Background subagent ${result.status}: ${result.task.slice(0, 500)}`;
  const report = finalAnswer || result.error?.trim() || "No final report was produced.";
  const available = Math.max(0, SUBAGENT_REPORT_LIMIT - heading.length - 2);
  const bounded =
    report.length > available ? `${report.slice(0, Math.max(0, available - 2))}…` : report;
  return `${heading}\n\n${bounded}`;
}

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
  trusted: boolean;
  agentDir: string;
  sessionDir: string;
  /** Dedicated session directories (such as Discussion threads) have no workspace subdirectory. */
  directSessionDir?: boolean;
  newSession?: boolean;
  sessionId?: string;
  sessionFile?: string;
  additionalSystemPrompt?: string;
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
  /** Subset of builtin slash command names to advertise; defaults to all of them. */
  slashCommands?: readonly string[];
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

export interface CakeSessionRuntime {
  readonly sessionId: string;
  readonly sessionFile: string;
  /** Returns Pi's live turn state without assembling a ConversationSnapshot. */
  readonly streaming: boolean;
  executingTurnIds?(): ReadonlyArray<string>;
  recoverInput?(input: RuntimeRecoveryInput): Promise<void>;
  restoreInput?(input: RuntimeRecoveryInput): Promise<void>;
  checkRecovery?(inputs: ReadonlyArray<RuntimeRecoveryInput>): void;
  hasConsumedInput?(turnId: string): boolean;
  acknowledgeRecovery?(): Promise<void>;
  pendingRecoveryInputs?(): ReadonlyArray<{ turnId: string; delivery: "steer" | "follow-up" }>;
  getReviewParentContext?(): ReviewParentContext;
  recordReviewRun(run: ReviewRunEntry): void;
  snapshot(): Promise<ConversationSnapshot>;
  history?(cursor: string): Promise<{ parts: UiPart[]; cursor?: string }>;
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
  ): Promise<void>;
  listQueuedMessages(): Promise<{ steering: string[]; followUp: string[] }>;
  pendingMessages(): Promise<PiPendingMessages>;
  reorderPendingMessage(input: PiPendingMessageReorder): Promise<PiPendingMessages>;
  clearQueue(): Promise<{ steering: string[]; followUp: string[] }>;
  cancelSteering(): Promise<{ steering: string[]; followUp: string[] }>;
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
    projectTrusted: options.trusted,
  });
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
  const resolveTarget = (reference: string, signal: AbortSignal) => {
    if (options.sessionReferences) return options.sessionReferences.resolve(reference, signal);
    if (/^s:/i.test(reference))
      return Promise.reject(
        new Error("Session reference resolution is unavailable in this runtime"),
      );
    return Promise.resolve(reference);
  };
  const cakeSessionId = session.sessionManager.getSessionId();
  configurationState.attachModel(session.model);
  capabilities.setSessionId(cakeSessionId);
  // Ancestors of a Working Directory fork live under sibling workspace session
  // directories, so lineage resolution is bounded by the shared session root.
  await promptCacheLineage.attach({
    sessionManager: session.sessionManager,
    sessionRoots: [resolve(options.sessionDir)],
  });
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  const completionReceipts = new AbortController();
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

  async function makeSnapshot(
    onCaptured?: (snapshot: ConversationSnapshot) => void,
  ): Promise<ConversationSnapshot> {
    const [sessionFile, models] = await Promise.all([
      options.auxiliary
        ? Promise.resolve(undefined)
        : findSessionFile(options.cwd, cakeSessionId, options.sessionDir, options.directSessionDir),
      options.auxiliary ? Promise.resolve([]) : configuration.modelOptions(),
    ]);

    const snapshot = projectCakeSessionRuntimeSnapshot({
      workspacePath: options.cwd,
      sessionId: cakeSessionId,
      sessionListed: sessionFile !== undefined,
      auxiliary: Boolean(options.auxiliary),
      session,
      settingsManager,
      models,
      queuedParts: projection.queuedParts(),
      transientParts: [
        ...(session.isCompacting ? [activeCompactionNotice()] : []),
        ...recovery.transientParts(),
      ],
      fastMode: configurationState.enabledFastMode(),
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

  let initialTranscriptPublished = !options.newSession;
  let automaticTitleForNextMessage = true;
  const captureTurnResult = createTurnResultCapture(
    () => turnController.executingTurnIds(),
    (turnId, result) => options.onTurnResult?.(turnId, result),
    () =>
      session.sessionManager
        .getBranch()
        .findLast((entry) => entry.type === "message" && entry.message.role === "assistant")?.id,
  );
  const unsubscribe = session.subscribe((event) => {
    if (disposed) return;
    captureTurnResult(event);
    if (
      event.type === "message_end" &&
      event.message.role === "assistant" &&
      event.message.stopReason === "aborted"
    ) {
      const presentation = abortPresentation();
      if (presentation.kind === "handoff")
        session.sessionManager.appendCustomEntry(turnHandoffEntryType, {
          timestamp: event.message.timestamp,
        });
      else if (presentation.kind === "stopped")
        session.sessionManager.appendCustomEntry(turnStopEntryType, {
          timestamp: event.message.timestamp,
          stop: presentation.stop,
        });
    }
    projection.projectEvent(event);
    if (event.type === "session_info_changed" && event.name)
      void options.sessionTitleChanged?.(cakeSessionId, event.name).catch(() => undefined);
    if (event.type === "compaction_end") {
      if (!event.aborted && !event.errorMessage) emitSnapshotInBackground();
      turnController.compactionEnded(event.willRetry);
    }
    if (
      !initialTranscriptPublished &&
      event.type === "message_end" &&
      (event.message.role === "user" || event.message.role === "assistant")
    ) {
      // Pi notifies public listeners before synchronously appending the message.
      // Do not release catalog publication from inside that pre-persistence event.
      queueMicrotask(() => {
        if (disposed || initialTranscriptPublished || !session.sessionFile) return;
        if (!existsSync(session.sessionFile)) return;
        initialTranscriptPublished = true;
        options.onInitialTranscriptPersisted?.();
      });
    }
    if (event.type === "message_end" && event.message.role === "user") {
      const content = textFromContent(event.message.content);
      const consumedTurnId = turnController.consumeUserMessage(content);
      if (consumedTurnId && !options.ephemeral)
        session.sessionManager.appendCustomEntry(recoveryInputEntryType, {
          turnId: consumedTurnId,
          timestamp: event.message.timestamp,
        });
      const presentation = projection.consumeUserPresentation(content);
      if (presentation?.renderUserMessageAsMarkdown)
        queueMicrotask(() => {
          if (disposed) return;
          const target = session.sessionManager
            .getEntries()
            .findLast((entry) => entry.type === "message" && entry.message === event.message);
          if (!target) return;
          session.sessionManager.appendCustomEntry(userMessagePresentationEntryType, {
            targetId: target.id,
            renderAs: "markdown",
          });
          emitSnapshotInBackground();
        });
      const automaticTitle = automaticTitleForNextMessage;
      automaticTitleForNextMessage = true;
      if (!options.auxiliary)
        void continuations.initializeSessionFromFirstMessage(
          textFromContent(event.message.content),
          automaticTitle,
        );
    }
    if (event.type === "agent_settled") {
      turnController.settleTurn();
      void continuations.finishSettledTurn();
    }
  });

  const currentContextSnapshot = () =>
    crossSessionContextSnapshot(session.getSessionStats().contextUsage);

  capabilities.operationApi.current = {
    resolveModelSelection: configuration.resolveModelSelection,
    async info() {
      const firstUserMessage = session.sessionManager
        .getBranch()
        .flatMap((entry) =>
          entry.type === "message" && entry.message.role === "user"
            ? [
                stripResponseModeReminder(
                  stripPresentationModeReminder(textFromContent(entry.message.content)),
                ).trim(),
              ]
            : [],
        )
        .find(Boolean);
      const info: JsonObject = {
        sessionId: cakeSessionId,
        title: continuations.activeSessionTitle(),
        sessionFile: session.sessionFile ?? "",
        ...(firstUserMessage ? { firstUserMessage } : null),
        workspacePath: options.cwd,
        resolved: options.currentSessionControl?.resolved() ?? false,
        model: {
          provider: session.model?.provider ?? "unknown",
          id: session.model?.id ?? "unknown",
          reasoning: session.thinkingLevel,
        },
      };
      const family = (await options.currentSessionControl?.readPolicy())?.family;
      return Schema.decodeUnknownSync(jsonValueSchema)(
        family === undefined ? info : { ...info, family },
      );
    },
    usage() {
      const stats = session.getSessionStats();
      return Schema.decodeUnknownSync(jsonValueSchema)({
        inputTokens: stats.tokens.input,
        outputTokens: stats.tokens.output,
        cacheReadTokens: stats.tokens.cacheRead,
        cacheWriteTokens: stats.tokens.cacheWrite,
        reportedCostUsd: stats.cost,
        pricingCoverage: options.partialPricingCoverage
          ? "partial"
          : session.model
            ? "complete"
            : "unknown",
      });
    },
    contextStatus() {
      const { usedTokens: tokens, windowTokens: limit } = currentContextSnapshot();
      return Schema.decodeUnknownSync(jsonValueSchema)({
        tokens,
        limit,
        remaining: tokens === null || limit === null ? null : Math.max(0, limit - tokens),
        utilization: tokens === null || limit === null ? null : tokens / limit,
        measurement: "estimated",
      });
    },
    async compact(instructions) {
      await turnController.compact(instructions);
      await capabilities.reportAgentAction("compact");
      return { status: "compacted" };
    },
    async rename(title) {
      const committedTitle = await continuations.rename(title, true);
      return { sessionId: cakeSessionId, title: committedTitle };
    },
    async createSession(input, signal) {
      if (!options.currentSessionControl?.createSession)
        throw new Error("This Cake runtime cannot create project sessions");
      return options.currentSessionControl.createSession(
        { ...input, model: configuration.resolveModelSelection(input.model) },
        signal,
      );
    },
    async createDraftSession(input, signal) {
      if (!options.currentSessionControl?.createDraftSession)
        throw new Error("This Cake runtime cannot create project draft sessions");
      return options.currentSessionControl.createDraftSession(
        { ...input, model: configuration.resolveModelSelection(input.model) },
        signal,
      );
    },
    async createChildSession(input, requestId, signal) {
      if (!options.currentSessionControl?.createChildSession)
        throw new Error("This Project Session cannot create child sessions");
      return options.currentSessionControl.createChildSession(
        {
          requestId,
          title: input.title,
          initialPrompt: input.initialPrompt,
          resultDelivery: input.resultDelivery,
          placement: input.placement,
          model: configuration.resolveModelSelection(input.model),
          ...(input.worktreeName === undefined ? null : { worktreeName: input.worktreeName }),
          senderContext: currentContextSnapshot(),
        },
        signal,
      );
    },
    async forkSession(input) {
      return continuations.scheduleFork(input);
    },
    async pendingMessages(sessionId, signal) {
      const pending = options.currentSessionControl?.pendingMessages;
      if (!pending) throw new Error("Project Session queues are unavailable in this runtime");
      return pending(await resolveTarget(sessionId, signal), signal);
    },
    async reorderPendingMessage(sessionId, input, signal) {
      const reorder = options.currentSessionControl?.reorderPendingMessage;
      if (!reorder) throw new Error("Project Session queues are unavailable in this runtime");
      return reorder(await resolveTarget(sessionId, signal), input, signal);
    },
    async mergeSession(targetSessionId, signal) {
      const merge = options.currentSessionControl?.mergeSession;
      if (!merge) throw new Error("Managed Worktree merge is unavailable in this runtime");
      return merge(
        targetSessionId === undefined ? undefined : await resolveTarget(targetSessionId, signal),
        signal,
      );
    },
    async discardSession(targetSessionId, keepBranch, signal) {
      const discard = options.currentSessionControl?.discardSession;
      if (!discard) throw new Error("Managed Worktree discard is unavailable in this runtime");
      return discard(
        targetSessionId === undefined ? undefined : await resolveTarget(targetSessionId, signal),
        keepBranch,
        signal,
      );
    },
    async invokeAppControl(command, input, signal) {
      if (typeof input.sessionId === "string")
        input = { ...input, sessionId: await resolveTarget(input.sessionId, signal) };
      const familyResult =
        command === "sessions.send" || command === "sessions.reply"
          ? await options.currentSessionControl?.routeFamilyMessage?.(
              command,
              input,
              signal,
              currentContextSnapshot(),
            )
          : undefined;
      let result = familyResult;
      if (result === undefined) {
        const invoke = options.currentSessionControl?.invokeAppControl;
        if (!invoke) throw new Error("Cross-session Cake controls are unavailable in this runtime");
        result = await invoke(command, input, signal);
      }
      return capabilities.recordAppControlResult(result, session);
    },
    setResolved: continuations.setResolved,
    setModel: configuration.setOperationModel,
  };

  return {
    sessionId: cakeSessionId,
    get sessionFile() {
      return session.sessionFile ?? "";
    },
    get streaming() {
      return session.isStreaming;
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
    snapshot: () => makeSnapshot(),
    restoreInput: (input) =>
      turnController.restorePending({ ...input, attachments: [...input.attachments] }),
    async acknowledgeRecovery() {
      await session.sendCustomMessage(
        {
          customType: "cake.restart-review",
          display: false,
          content:
            "The user sent a new message after Cake's interrupted-work warning. A prior tool may have executed without a saved result. Inspect current state before further mutations; do not automatically replay unfinished tool calls or already-sent reports.",
        },
        { triggerTurn: false },
      );
    },
    pendingRecoveryInputs: turnController.pendingRecoveryInputs,
    hasConsumedInput(turnId) {
      return restartDecision(session.sessionManager.getEntries(), turnId).kind !== "pending";
    },
    checkRecovery(inputs) {
      for (const input of inputs) {
        const decision = restartDecision(session.sessionManager.getBranch(), input.turnId);
        if (decision.kind === "blocked") throw new RestartRecoveryBlockedError(decision.issue);
        if (decision.kind === "pending" && /^[!/]/.test(input.text))
          throw new RestartRecoveryBlockedError(
            "An interrupted command needs review before it can be run again.",
          );
      }
    },
    async recoverInput(input) {
      const decision = restartDecision(session.sessionManager.getBranch(), input.turnId);
      if (decision.kind === "blocked") {
        emitPart({
          id: "restart-recovery",
          kind: "notice",
          tone: "error",
          title: "Recovery needs your review",
          detail: decision.issue,
        });
        throw new RestartRecoveryBlockedError(decision.issue);
      }
      if (decision.kind === "settled") {
        options.onTurnResult?.(input.turnId, decision.result);
        return;
      }
      if (decision.kind === "pending") {
        // Extension commands and user shell commands can mutate before a user
        // message is committed. They cannot be replayed on an uncertain handoff.
        if (/^[!/]/.test(input.text))
          throw new RestartRecoveryBlockedError(
            "An interrupted command needs review before it can be run again.",
          );
        await turnController.prompt(
          input.text,
          input.delivery,
          [...input.attachments],
          input.markdown,
          input.turnId,
          input.presentationMode,
          input.responseMode,
        );
        return;
      }
      emitPart({
        id: "restart-recovery",
        kind: "notice",
        tone: "info",
        title: "Recovering interrupted work",
      });
      try {
        await turnController.resume(input.turnId, restartResumePrompt);
        const settled = restartDecision(session.sessionManager.getBranch(), input.turnId);
        if (settled.kind === "settled") options.onTurnResult?.(input.turnId, settled.result);
      } finally {
        removePart("restart-recovery");
      }
    },
    async notifySubagentCompletion(result, completionId) {
      if (disposed) throw new Error("The Cake runtime has been disposed");
      const receiptSchema = Schema.Struct({ completionId: Schema.String });
      const matchesReceipt = (details: unknown) => {
        const receipt = Schema.decodeUnknownOption(receiptSchema)(details);
        return Option.isSome(receipt) && receipt.value.completionId === completionId;
      };
      const persistedReceiptSchema = Schema.fromJsonString(
        Schema.Struct({
          type: Schema.Literal("custom_message"),
          customType: Schema.Literal("cake.subagent-completion"),
          details: receiptSchema,
        }),
      );
      const hasReceipt = async () => {
        const file = session.sessionFile;
        if (completionId === undefined || !file || !existsSync(file)) return false;
        if (
          !session.sessionManager
            .getEntries()
            .some(
              (entry) =>
                entry.type === "custom_message" &&
                entry.customType === "cake.subagent-completion" &&
                matchesReceipt(entry.details),
            )
        )
          return false;
        // Pi updates its entry index before writing. An index entry alone is
        // not proof of receipt if the transcript append failed.
        const transcript = await readFile(file, "utf8");
        return transcript.split("\n").some((line) => {
          if (!line.includes("cake.subagent-completion")) return false;
          const receipt = Schema.decodeUnknownOption(persistedReceiptSchema)(line);
          return Option.isSome(receipt) && receipt.value.details.completionId === completionId;
        });
      };
      if (await hasReceipt()) return;
      const parsed = Schema.decodeUnknownOption(subagentResultSchema)(result);
      const message = {
        customType: "cake.subagent-completion",
        content: subagentCompletionMessage(result),
        display: false,
        details: completionId && Option.isSome(parsed) ? { ...parsed.value, completionId } : result,
      };
      if (!completionId) {
        await session.sendCustomMessage(message, { triggerTurn: true, deliverAs: "followUp" });
        return;
      }
      let unsubscribe = () => {};
      let onDispose = () => {};
      const receipt = new Promise<void>((resolve, reject) => {
        let observed = false;
        onDispose = () => reject(new Error("Cake stopped before the worker report was persisted"));
        if (completionReceipts.signal.aborted) {
          onDispose();
          return;
        }
        completionReceipts.signal.addEventListener("abort", onDispose, { once: true });
        unsubscribe = session.subscribe((event) => {
          if (event.type !== "message_end") return;
          if (
            event.message.role === "custom" &&
            event.message.customType === "cake.subagent-completion" &&
            matchesReceipt(event.message.details)
          )
            observed = true;
          if (!observed) return;
          // Pi emits message_end before its synchronous transcript append. Wait
          // until after that append; accepting an in-memory follow-up is not a receipt.
          queueMicrotask(() => {
            void hasReceipt().then((persisted) => {
              if (persisted) {
                unsubscribe();
                resolve();
              }
            }, reject);
          });
        });
      });
      void receipt.catch(() => undefined);
      try {
        await session.sendCustomMessage(message, { triggerTurn: true, deliverAs: "followUp" });
        await receipt;
      } finally {
        unsubscribe();
        completionReceipts.signal.removeEventListener("abort", onDispose);
      }
    },
    compact: turnController.compact,
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
          commands: [...piBuiltinSlashCommands, ...resources.commandCatalog()].map((command) => ({
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
    prompt(
      text,
      delivery,
      attachments,
      markdown,
      turnId,
      presentationMode,
      automaticTitle = true,
      responseMode,
    ) {
      automaticTitleForNextMessage = automaticTitle;
      return turnController.prompt(
        text,
        delivery,
        attachments,
        markdown,
        turnId,
        presentationMode,
        responseMode,
      );
    },
    listQueuedMessages: turnController.listQueuedMessages,
    pendingMessages: turnController.pendingMessages,
    reorderPendingMessage: turnController.reorderPendingMessage,
    clearQueue: turnController.clearQueue,
    cancelSteering: turnController.cancelSteering,
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
      try {
        await turnController.abort();
      } finally {
        pendingStop = undefined;
      }
    },
    setModel: configuration.setModel,
    setThinkingLevel: configuration.setThinkingLevel,
    applyConfiguration: configuration.applyConfiguration,
    setFastMode: configuration.setFastMode,
    syncFastMode: configuration.syncFastMode,
    setPiSetting: configuration.setPiSetting,
    reload: resources.requestReload,
    async callCakeOperation(command, input, signal) {
      if (disposed) throw new Error("The Cake runtime has been disposed");
      const registry = capabilities.operationRegistry.current;
      if (!registry) throw new Error("Cake operations are unavailable");
      const result = await registry.invoke(
        { command, input },
        {
          signal,
          toolCallId: `session-plugin:${crypto.randomUUID()}`,
          runtime: projectCakeOperationRuntime(session, `cake-operation-${command}`),
        },
      );
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
    toolCompact: continuations.toolCompact,
    async navigate(entryId, options) {
      const result = await session.navigateTree(entryId, options);
      if (result.cancelled) throw new Error("Session tree navigation was cancelled");
      await emitSnapshot();
    },
    dispose() {
      if (disposed) return disposePromise;
      disposed = true;
      completionReceipts.abort();
      turnController.dispose();
      continuations.dispose();
      projection.dispose();
      recovery.dispose();
      resources.dispose();
      unsubscribe();
      disposePromise = (async () => {
        try {
          await session.abort();
          // An already-running reload owns its own shutdown. Let it retire
          // before shutting down the final extension runtime.
          await resources.drainReloads();
        } finally {
          try {
            await shutdownCakeSessionExtensions(session);
          } finally {
            session.dispose();
            await settingsManager.flush();
          }
        }
      })();
      return disposePromise;
    },
  };
}
