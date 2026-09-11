import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { Schema } from "effect";
import type {
  Attachment,
  ChatConfiguration,
  PiSettingUpdate,
  ExtensionUiEvent,
  ExtensionUiIntent,
  SessionSnapshot,
  SessionUsage,
  ThinkingLevel,
  UiPart,
  UtilityModel,
} from "../../../ipc/session-contract";
import type { CakeModelPresetCatalog } from "../../../domain/model-presets/cake-model-selection";
import type {
  ParallelSubagentInput as DomainParallelSubagentInput,
  SubagentTaskInput as DomainSubagentTaskInput,
} from "../../../domain/subagents/subagent-data";
import { jsonValueSchema, type JsonObject, type JsonValue } from "../../../ipc/json-contract";
import type {
  ArtifactRecord,
  ArtifactPointer,
  CakeArtifactV1,
} from "../../../ipc/artifact-contract";
import type { VscodeControl } from "./cake-vscode-operations";
import type { WorktreeLandingControl } from "./cake-worktree-operations";
import { assertSessionPath } from "./session-path";
import { cakeWorkspaceSessionDirectory, findSessionFile } from "./session-discovery";
import {
  formatUnknown,
  projectArtifactPointers,
  reviewRunEntrySchema,
  reviewRunEntryType,
  reviewRunPart,
  textFromContent,
  userMessagePresentationEntrySchema,
  userMessagePresentationEntryType,
  type ReviewRunEntry,
} from "./session-projection";
import {
  activeCompactionNotice,
  createCakeRuntimeEventProjection,
} from "./cake-runtime-event-projection";
import { projectCakeRuntimeSnapshot } from "./cake-runtime-snapshot";
import { createCakeRuntimeTurnController } from "./cake-runtime-turn-controller";
import { createCakeRuntimeRecovery } from "./cake-runtime-recovery";
import { createCakeRuntimeResourceLifecycle } from "./cake-runtime-resources";
import { createCakeRuntimeCapabilities, type GlobalControlTool } from "./cake-runtime-capabilities";
import {
  createCakeRuntimeConfiguration,
  createCakeRuntimeConfigurationState,
} from "./cake-runtime-configuration";
import { createCakeRuntimeContinuations } from "./cake-runtime-continuations";
import type { RuntimeUiRequest } from "./runtime-ui-request";
import type {
  InlineWidgetGenerationRequest,
  InlineWidgetGenerationResult,
  ReviewParentContext,
} from "./sidecar-runtime";

export {
  createAgentControlOperations,
  createGlobalControlOperations,
  projectSessionCreateInputSchema,
} from "./cake-runtime-capabilities";

export const piRuntimeVersion = "0.84.0" as const;

export type CakeRuntimeEvent =
  | { type: "snapshot"; requestId?: string; snapshot: SessionSnapshot }
  | { type: "part-updated"; sessionId: string; part: UiPart }
  | { type: "part-removed"; sessionId: string; partId: string }
  | { type: "streaming"; sessionId: string; streaming: boolean }
  | { type: "usage-updated"; sessionId: string; usage: SessionUsage }
  | { type: "extension-ui"; sessionId: string; event: ExtensionUiEvent };

export interface CakeRuntimeOptions {
  cwd: string;
  trusted: boolean;
  agentDir: string;
  sessionDir: string;
  resolvedSessionDir?: string;
  newSession?: boolean;
  sessionId?: string;
  sessionFile?: string;
  additionalSystemPrompt?: string;
  /** Replaces Pi's normal prompt and disables context-file loading for an isolated runtime. */
  isolatedSystemPrompt?: string;
  tools?: string[];
  auxiliary?: boolean;
  /** Subset of builtin slash command names to advertise; defaults to all of them. */
  slashCommands?: readonly string[];
  requestUi(request: RuntimeUiRequest): Promise<string | undefined>;
  emitExtensionUiIntent?(intent: ExtensionUiIntent): void;
  persistArtifact?(artifact: CakeArtifactV1): Promise<ArtifactRecord>;
  requestArtifact?(record: ArtifactRecord, signal: AbortSignal): Promise<JsonValue | undefined>;
  generateInlineWidget?(
    input: InlineWidgetGenerationRequest,
  ): Promise<InlineWidgetGenerationResult>;
  listArtifacts?(pointers: ArtifactPointer[]): Promise<ArtifactRecord[]>;
  openExternal?(url: string): Promise<void>;
  reviewContextPath?(sessionId: string): string;
  utilityModel?(): UtilityModel | undefined;
  modelPresets?(): CakeModelPresetCatalog;
  fastMode?: {
    get(): boolean;
    set(enabled: boolean): Promise<void>;
  };
  generateSessionTitle?(input: {
    utilityModel: UtilityModel;
    firstUserMessage: string;
    signal?: AbortSignal;
  }): Promise<string>;
  sessionTitleChanged?(sessionId: string, title: string): Promise<void>;
  currentSessionControl?: {
    resolved(): boolean;
    canResolve?(): boolean;
    familyInfo?(): JsonValue;
    deferResolution?: boolean;
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
      input: { name: string; initialPrompt: string; model?: ChatConfiguration },
      signal: AbortSignal,
    ): Promise<JsonValue>;
    createChildSession?(
      input: {
        requestId: string;
        title: string;
        initialPrompt: string;
        model: ChatConfiguration;
        placement: "none" | "right" | "down";
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
    routeFamilyMessage?(input: JsonObject, signal: AbortSignal): Promise<JsonValue | undefined>;
    invokeAppControl?(command: string, input: JsonObject, signal: AbortSignal): Promise<JsonValue>;
  };
  vscodeControl?: VscodeControl;
  worktreeLandingControl?: WorktreeLandingControl;
  globalControl?: {
    tools: readonly GlobalControlTool[];
    invoke(input: { name: string; arguments: JsonValue }, signal: AbortSignal): Promise<JsonValue>;
  };
  agentControl?: {
    run(
      input: DomainSubagentTaskInput,
      parentSessionId: string,
      signal: AbortSignal,
      onUpdate?: (value: JsonValue) => void,
      anchorPartId?: string,
    ): Promise<JsonValue>;
    start(
      input: DomainSubagentTaskInput,
      parentSessionId: string,
      signal: AbortSignal,
      anchorPartId?: string,
    ): Promise<JsonValue>;
    parallel(
      input: DomainParallelSubagentInput,
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
  };
  onEvent(event: CakeRuntimeEvent): void;
}

export interface CakeRuntime {
  readonly sessionId: string;
  readonly sessionFile: string;
  /** Returns Pi's live turn state without assembling a SessionSnapshot. */
  readonly streaming: boolean;
  executingTurnIds?(): ReadonlyArray<string>;
  getReviewParentContext?(): ReviewParentContext;
  recordReviewRun(run: ReviewRunEntry): void;
  snapshot(): Promise<SessionSnapshot>;
  notifySubagentCompletion?(result: JsonValue): Promise<void>;
  prompt(
    text: string,
    delivery: "prompt" | "steer" | "follow-up",
    attachments: Attachment[],
    renderUserMessageAsMarkdown?: boolean,
    turnId?: string,
  ): Promise<void>;
  listQueuedMessages(): Promise<{ steering: string[]; followUp: string[] }>;
  clearQueue(): Promise<{ steering: string[]; followUp: string[] }>;
  cancelSteering(): Promise<{ steering: string[]; followUp: string[] }>;
  editMessage?(
    entryId: string,
    text: string,
    attachments: Attachment[],
    renderUserMessageAsMarkdown: boolean,
  ): Promise<void>;
  setUserMessageMarkdown(entryId: string, renderAsMarkdown: boolean): Promise<void>;
  compact(instructions?: string): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  /** Applies a full chat configuration atomically, emitting a single snapshot. */
  applyConfiguration(configuration: ChatConfiguration): Promise<void>;
  setFastMode?(enabled: boolean): Promise<void>;
  syncFastMode?(): Promise<void>;
  setPiSetting(update: PiSettingUpdate): Promise<void>;
  reload?(): Promise<void>;
  refreshModels?(): Promise<void>;
  login(provider: string, authType: "api_key" | "oauth"): Promise<void>;
  logout(provider: string): Promise<void>;
  rename(name: string): Promise<void>;
  fork(entryId: string, title: string): Promise<{ sessionId: string; sessionFile: string }>;
  toolCompact(entryId: string): Promise<{ sessionId: string; sessionFile: string }>;
  navigate(
    entryId: string,
    options: { summarize: boolean; customInstructions?: string },
  ): Promise<void>;
  dispose(): void | Promise<void>;
}

export async function createCakeRuntime(options: CakeRuntimeOptions): Promise<CakeRuntime> {
  const agentDir = options.agentDir;
  const settingsManager = SettingsManager.create(options.cwd, agentDir, {
    projectTrusted: options.trusted,
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: `${agentDir}/auth.json`,
    modelsPath: `${agentDir}/models.json`,
    modelsStorePath: `${agentDir}/models-cache.json`,
  });
  const configurationState = createCakeRuntimeConfigurationState(options.fastMode);
  const capabilities = await createCakeRuntimeCapabilities({
    options,
    agentDir,
    settingsManager,
    fastModeExtension: configurationState.fastModeExtension,
  });
  const sessionDir = options.globalControl
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
          Boolean(options.globalControl),
        )
      : undefined;
  if (options.sessionId && !options.newSession && !requestedSessionFile && !directSession)
    throw new Error("That session is no longer available");
  const sessionManager = options.newSession
    ? SessionManager.create(
        options.cwd,
        sessionDir,
        options.sessionId ? { id: options.sessionId } : undefined,
      )
    : (directSession ??
      (requestedSessionFile
        ? SessionManager.open(requestedSessionFile, sessionDir, options.cwd)
        : SessionManager.continueRecent(options.cwd, sessionDir)));
  const agentSessionOptions = {
    cwd: options.cwd,
    agentDir,
    modelRuntime,
    resourceLoader: capabilities.resourceLoader,
    settingsManager,
    sessionManager,
  };
  const { session, extensionsResult, modelFallbackMessage } = await createAgentSession(
    options.tools ? { ...agentSessionOptions, tools: options.tools } : agentSessionOptions,
  );
  const cakeSessionId = session.sessionManager.getSessionId();
  configurationState.attachModel(session.model);
  capabilities.setSessionId(cakeSessionId);
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  const emitPart = (part: UiPart) =>
    options.onEvent({ type: "part-updated", sessionId: cakeSessionId, part });
  const removePart = (partId: string) =>
    options.onEvent({ type: "part-removed", sessionId: cakeSessionId, partId });
  const recovery = createCakeRuntimeRecovery({
    session,
    retryEnabled: () => settingsManager.getRetryEnabled(),
    isDisposed: () => disposed,
    emitPart,
    removePart,
  });
  const resources = await createCakeRuntimeResourceLifecycle({
    resourceLoader: capabilities.resourceLoader,
    settingsManager,
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
  const projection = createCakeRuntimeEventProjection({
    session,
    sessionId: cakeSessionId,
    emit: options.onEvent,
    compactionQueuedMessages: () => compactionQueuedMessages(),
    isDisposed: () => disposed,
  });
  const configuration = createCakeRuntimeConfiguration({
    options,
    modelRuntime,
    settingsManager,
    session,
    state: configurationState,
    requestUi: options.requestUi,
    emitSnapshot: () => emitSnapshot(),
    emitAuthNotice: (tone, title, detail) =>
      emitPart({ id: "auth-status", kind: "notice", tone, title, detail }),
    cancelResponseRetries: recovery.cancelResponseRetries,
    reportAgentAction: capabilities.reportAgentAction,
  });

  async function makeSnapshot(
    onCaptured?: (snapshot: SessionSnapshot) => void,
  ): Promise<SessionSnapshot> {
    const [sessionFile, models, artifacts] = await Promise.all([
      options.auxiliary
        ? Promise.resolve(undefined)
        : findSessionFile(
            options.cwd,
            cakeSessionId,
            options.sessionDir,
            Boolean(options.globalControl),
          ),
      options.auxiliary ? Promise.resolve([]) : configuration.modelOptions(),
      options.auxiliary
        ? Promise.resolve([])
        : (options.listArtifacts?.(projectArtifactPointers(session.sessionManager)) ??
          Promise.resolve([])),
    ]);

    const snapshot = projectCakeRuntimeSnapshot({
      workspacePath: options.cwd,
      sessionId: cakeSessionId,
      sessionListed: sessionFile !== undefined,
      auxiliary: Boolean(options.auxiliary),
      session,
      settingsManager,
      models,
      artifacts,
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

  const turnController = createCakeRuntimeTurnController({
    session,
    isDisposed: () => disposed,
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
  });
  compactionQueuedMessages = turnController.compactionQueuedMessages;

  const continuations = createCakeRuntimeContinuations({
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

  const unsubscribe = session.subscribe((event) => {
    if (disposed) return;
    projection.projectEvent(event);
    if (event.type === "session_info_changed" && event.name)
      void options.sessionTitleChanged?.(cakeSessionId, event.name).catch(() => undefined);
    if (event.type === "compaction_end") {
      if (!event.aborted && !event.errorMessage) emitSnapshotInBackground();
      turnController.compactionEnded(event.willRetry);
    }
    if (event.type === "message_end" && event.message.role === "user") {
      const content = textFromContent(event.message.content);
      turnController.consumeUserMessage(content);
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
      if (!options.auxiliary)
        void continuations.nameSessionFromFirstMessage(textFromContent(event.message.content));
    }
    if (event.type === "agent_settled") {
      turnController.settleTurn();
      void continuations.finishSettledTurn();
    }
  });
  void recovery.resumeInterruptedTurn();

  capabilities.operationApi.current = {
    resolveModelSelection: configuration.resolveModelSelection,
    info() {
      const info: JsonObject = {
        sessionId: cakeSessionId,
        title: continuations.activeSessionTitle(),
        workspacePath: options.cwd,
        resolved: options.currentSessionControl?.resolved() ?? false,
        model: {
          provider: session.model?.provider ?? "unknown",
          id: session.model?.id ?? "unknown",
          reasoning: session.thinkingLevel,
        },
      };
      const family = options.currentSessionControl?.familyInfo?.();
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
        pricingCoverage: options.agentControl ? "partial" : session.model ? "complete" : "unknown",
      });
    },
    contextStatus() {
      const context = session.getSessionStats().contextUsage;
      const tokens = context?.tokens ?? 0;
      const limit = context?.contextWindow ?? 1;
      return Schema.decodeUnknownSync(jsonValueSchema)({
        tokens,
        limit,
        remaining: Math.max(0, limit - tokens),
        utilization: tokens / limit,
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
      if (!session.model) throw new Error("The calling session does not have a model to inherit");
      return options.currentSessionControl.createChildSession(
        {
          requestId,
          title: input.title,
          initialPrompt: input.initialPrompt,
          placement: input.placement,
          model: configuration.resolveModelSelection(input.model),
        },
        signal,
      );
    },
    async forkSession(input) {
      return continuations.scheduleFork(input);
    },
    async invokeAppControl(command, input, signal) {
      const familyResult =
        command === "sessions.send"
          ? await options.currentSessionControl?.routeFamilyMessage?.(input, signal)
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
    async notifySubagentCompletion(result) {
      if (disposed) throw new Error("The Cake runtime has been disposed");
      await session.sendCustomMessage(
        {
          customType: "cake.subagent-completion",
          content: `A background subagent completed. Use this result to continue the user's work:\n\n${formatUnknown(result, 24_000)}`,
          display: false,
          details: result,
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    },
    compact: turnController.compact,
    executingTurnIds: turnController.executingTurnIds,
    prompt: turnController.prompt,
    listQueuedMessages: turnController.listQueuedMessages,
    clearQueue: turnController.clearQueue,
    cancelSteering: turnController.cancelSteering,
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
    abort: turnController.abort,
    setModel: configuration.setModel,
    setThinkingLevel: configuration.setThinkingLevel,
    applyConfiguration: configuration.applyConfiguration,
    setFastMode: configuration.setFastMode,
    syncFastMode: configuration.syncFastMode,
    setPiSetting: configuration.setPiSetting,
    reload: resources.requestReload,
    refreshModels: configuration.refreshModels,
    login: configuration.login,
    logout: configuration.logout,
    async rename(name) {
      await continuations.rename(name);
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
      turnController.dispose();
      continuations.dispose();
      projection.dispose();
      recovery.dispose();
      resources.dispose();
      unsubscribe();
      const finish = async () => {
        session.dispose();
        await settingsManager.flush();
      };
      disposePromise = session.isStreaming
        ? session
            .abort()
            .catch(() => undefined)
            .then(finish)
        : finish();
      return disposePromise;
    },
  };
}
