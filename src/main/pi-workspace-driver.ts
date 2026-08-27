import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import {
  createCakeRuntime,
  type CakeRuntime,
  type CakeRuntimeEvent,
  type RuntimeUiRequest,
} from "../agent/cake-runtime";
import { supportsFastMode } from "../agent/fast-mode";
import { forkWorkspaceSession, loadPiChangelog } from "../agent/session-discovery";
import {
  runInlineWidgetGeneration,
  runInlineWidgetRepair,
  runReviewTurn,
  type InlineWidgetGenerationRequest,
} from "../agent/sidecar-runtime";
import {
  parallelSubagentSchema,
  subagentSpawnReceiptSchema,
  subagentSystemPrompt,
  subagentTaskSchema,
  toolsForSubagentProfile,
  type ParallelSubagentTasksInput,
  type SubagentProfile,
  type SubagentTask,
  type SubagentTaskInput,
} from "../agent/subagent-contract";
import type { DesktopEvent, DesktopRequest } from "../ipc/desktop-ipc";
import type { SourceLocation } from "../ipc/source-location";
import type { SessionUsage, UiPart, UtilityModel } from "../ipc/session-contract";
import { subagentActivitySchema } from "../ipc/subagent-activity-contract";
import type { JsonValue } from "../ipc/json-contract";
import { jsonValueSchema } from "../ipc/json-contract";
import type { AgentModelPreference, ResolvedAgentModel } from "../ipc/plugin-agent-contract";
import {
  parseArtifactInput,
  type ArtifactRecord,
  type CakeArtifactV1,
} from "../ipc/artifact-contract";
import { REVIEW_TEXT_MAX_LENGTH } from "../ipc/review-contract";
import type { ArtifactRepository } from "./artifact-repository";
import type { ReviewRepository } from "./review-repository";
import { compileInlineWidget, extractRepairedWidget } from "./inline-widget-service";

type ArtifactRepositoryPort = Pick<
  ArtifactRepository,
  "upsert" | "get" | "listSession" | "linkSession"
>;
type ReviewRepositoryPort = Pick<
  ReviewRepository,
  "claimPending" | "completeRun" | "failRun" | "recoverRunning" | "agentSessionDirectory"
> &
  Partial<Pick<ReviewRepository, "reviewContextPath">>;

const MAX_LIVE_PRIVATE_AGENT_RUNTIMES = 32;
const MAX_SUBAGENT_HANDLES_PER_PARENT = 8;
const MAX_ACTIVE_SUBAGENTS = 4;
const SUBAGENT_RESULT_TTL_MS = 5 * 60_000;

type PiCommandType =
  | "open-workspace"
  | "rename-session"
  | "fork-session"
  | "navigate-session"
  | "get-changelog"
  | "prompt"
  | "submit-review-thread"
  | "abort"
  | "compact-session"
  | "set-model"
  | "set-chat-configuration"
  | "set-thinking"
  | "set-fast-mode"
  | "set-pi-setting"
  | "reload-pi"
  | "refresh-models"
  | "login"
  | "logout"
  | "respond-ui"
  | "respond-artifact";

type PiCommandRequest = Extract<DesktopRequest, { type: PiCommandType }>;
export type PiWorkspaceCommand = PiCommandRequest;

interface PendingUi {
  operationId: string;
  settle(value: string | undefined): void;
}

interface PendingArtifact {
  operationId: string;
  record: ArtifactRecord;
  artifactRequestId: string;
  settle(value: JsonValue | undefined): void;
}

interface RuntimeReference {
  current?: CakeRuntime;
}

interface SubagentHandle {
  parentSessionId: string;
  anchorPartId: string;
  sessionId?: string;
  releaseRuntime: boolean;
  taskDescription: string;
  profile: SubagentProfile;
  resolvedModel: ResolvedAgentModel;
  fastMode: boolean;
  retain: boolean;
  status: "queued" | "running" | "complete" | "error" | "aborted";
  revision: number;
  controller: AbortController;
  task?: Promise<void>;
  error?: string;
  result?: JsonValue;
  usage?: SessionUsage;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  activityTimer?: ReturnType<typeof setTimeout>;
  liveParts: Map<string, UiPart>;
  liveStreaming: boolean;
  unsubscribe?: () => void;
  observers: Set<() => void>;
}

interface PreparedSubagentTask {
  input: SubagentTask;
  resolvedModel: ResolvedAgentModel;
  tools: string[];
  remainingSubagentDepth: number;
}

export interface PiWorkspaceDriverOptions {
  workspacePath: string;
  agentDir: string;
  sessionDir: string;
  resolvedSessionDir?: string;
  widgetSessionDir?: string;
  pluginAgentSessionDir?: string;
  emit(event: DesktopEvent): void;
  createRuntime?: typeof createCakeRuntime;
  runReviewTurn?: typeof runReviewTurn;
  runWidgetGeneration?: typeof runInlineWidgetGeneration;
  runWidgetRepair?: typeof runInlineWidgetRepair;
  compileWidget?: typeof compileInlineWidget;
  artifactRepository?: ArtifactRepositoryPort;
  reviewRepository?: ReviewRepositoryPort;
  openExternal?: (url: string) => Promise<void>;
  openInEditor?: (location: SourceLocation, signal: AbortSignal) => Promise<SourceLocation>;
  isTrusted?: () => boolean;
  utilityModel?: () => UtilityModel | undefined;
  fastMode?(sessionId: string): boolean;
  setFastMode?(sessionId: string, enabled: boolean): Promise<void>;
  sessionResolved?(sessionId: string): boolean;
  setSessionResolved?(sessionId: string, resolved: boolean): Promise<void>;
  pluginResources?: { skills: string[]; prompts: string[]; extensions: string[] };
  resolveAgentModel?: (
    preference: AgentModelPreference,
    snapshot: Awaited<ReturnType<CakeRuntime["snapshot"]>>,
  ) => ResolvedAgentModel;
}

export class PiWorkspaceDriver {
  readonly workspacePath: string;
  private readonly emitEvent: PiWorkspaceDriverOptions["emit"];
  private readonly agentDir: string;
  private readonly sessionDir: string;
  private readonly resolvedSessionDir: string | undefined;
  private readonly widgetSessionDir: string;
  private readonly pluginAgentSessionDir: string;
  private readonly createRuntimeImpl: typeof createCakeRuntime;
  private readonly runReviewTurnImpl: typeof runReviewTurn;
  private readonly runWidgetGeneration: typeof runInlineWidgetGeneration;
  private readonly runWidgetRepair: typeof runInlineWidgetRepair;
  private readonly compileWidget: typeof compileInlineWidget;
  private readonly artifactRepository: ArtifactRepositoryPort;
  private readonly reviewRepository: ReviewRepositoryPort;
  private readonly openExternal: NonNullable<PiWorkspaceDriverOptions["openExternal"]> | undefined;
  private readonly openInEditor: PiWorkspaceDriverOptions["openInEditor"];
  private readonly isTrusted: () => boolean;
  private readonly utilityModel: () => UtilityModel | undefined;
  private readonly fastMode: (sessionId: string) => boolean;
  private readonly setFastMode: (sessionId: string, enabled: boolean) => Promise<void>;
  private readonly sessionResolved: (sessionId: string) => boolean;
  private readonly setSessionResolved: (sessionId: string, resolved: boolean) => Promise<void>;
  private readonly pluginResources: { skills: string[]; prompts: string[]; extensions: string[] };
  private readonly runtimes = new Map<string, CakeRuntime>();
  private readonly runtimePromises = new Map<string, Promise<CakeRuntime>>();
  private readonly runtimeListeners = new Map<string, Set<(event: CakeRuntimeEvent) => void>>();
  private readonly privateRuntimeIds = new Set<string>();
  private readonly privateRuntimeLeases = new Map<string, number>();
  private privateRuntimeReservations = 0;
  private readonly activeAgentTurns = new Set<string>();
  private readonly subagentHandles = new Map<string, SubagentHandle>();
  private readonly runtimeSubagentDepth = new Map<string, number>();
  private activeSubagents = 0;
  private readonly subagentQueue: Array<() => void> = [];
  private readonly resolveAgentModel: NonNullable<PiWorkspaceDriverOptions["resolveAgentModel"]>;
  private readonly pendingUi = new Map<string, PendingUi>();
  private readonly pendingArtifacts = new Map<string, PendingArtifact>();
  private readonly operationContext = new AsyncLocalStorage<{
    operationId: string;
    sessionId?: string;
  }>();
  private readonly activeReviewRuns = new Map<string, AbortController>();
  private readonly reviewRecovery: Promise<void>;
  private trusted = false;
  private disposed = false;

  constructor(options: PiWorkspaceDriverOptions) {
    this.workspacePath = options.workspacePath;
    this.agentDir = options.agentDir;
    this.sessionDir = options.sessionDir;
    this.resolvedSessionDir = options.resolvedSessionDir;
    this.widgetSessionDir =
      options.widgetSessionDir ?? resolve(options.sessionDir, "..", "widget-sessions");
    this.pluginAgentSessionDir =
      options.pluginAgentSessionDir ?? resolve(options.sessionDir, "..", "plugin-agent-sessions");
    this.emitEvent = options.emit;
    this.createRuntimeImpl = options.createRuntime ?? createCakeRuntime;
    this.runReviewTurnImpl = options.runReviewTurn ?? runReviewTurn;
    this.runWidgetGeneration = options.runWidgetGeneration ?? runInlineWidgetGeneration;
    this.runWidgetRepair = options.runWidgetRepair ?? runInlineWidgetRepair;
    this.compileWidget = options.compileWidget ?? compileInlineWidget;
    this.openExternal = options.openExternal;
    this.openInEditor = options.openInEditor;
    this.isTrusted = options.isTrusted ?? (() => false);
    this.utilityModel = options.utilityModel ?? (() => undefined);
    this.fastMode = options.fastMode ?? (() => false);
    this.setFastMode = options.setFastMode ?? (async () => undefined);
    this.sessionResolved = options.sessionResolved ?? (() => false);
    this.setSessionResolved = options.setSessionResolved ?? (async () => undefined);
    this.pluginResources = options.pluginResources ?? { skills: [], prompts: [], extensions: [] };
    this.resolveAgentModel =
      options.resolveAgentModel ??
      ((preference, snapshot) => {
        if (preference.prefer === "exact")
          return {
            requested: "exact",
            source: "exact",
            provider: preference.provider,
            modelId: preference.modelId,
            thinkingLevel: preference.thinkingLevel ?? snapshot.thinkingLevel,
            fallbacks: [],
          };
        if (!snapshot.model) throw new Error("The calling session has no current model");
        return {
          requested: preference.prefer,
          source: "current",
          provider: snapshot.model.provider,
          modelId: snapshot.model.id,
          thinkingLevel: snapshot.thinkingLevel,
          fallbacks:
            preference.prefer === "current"
              ? []
              : [{ source: preference.prefer, reason: "not-configured" }],
        };
      });
    this.artifactRepository = options.artifactRepository ?? {
      async upsert(workspacePath, artifact) {
        const now = new Date().toISOString();
        return {
          artifact: parseArtifactInput(artifact),
          workspacePath,
          digest: "0".repeat(64),
          createdAt: now,
          updatedAt: now,
        };
      },
      async listSession() {
        return [];
      },
      async get() {
        return undefined;
      },
      async linkSession() {
        return undefined;
      },
    };
    this.reviewRepository = options.reviewRepository ?? {
      async claimPending() {
        return undefined;
      },
      async completeRun() {
        throw new Error("Review persistence is unavailable");
      },
      async failRun() {
        throw new Error("Review persistence is unavailable");
      },
      async recoverRunning() {},
      agentSessionDirectory() {
        throw new Error("Review persistence is unavailable");
      },
    };
    this.reviewRecovery = this.reviewRepository.recoverRunning(this.workspacePath);
    void this.reviewRecovery.catch(() => undefined);
  }

  dispatch(command: PiWorkspaceCommand) {
    if (this.disposed) throw new Error("The Pi workspace driver has been disposed");
    if (command.type === "respond-ui") {
      const pending = this.pendingUi.get(command.uiRequestId);
      if (pending?.operationId === command.requestId)
        pending.settle(command.cancelled ? undefined : command.value);
      return;
    }
    if (command.type === "respond-artifact") {
      const pending = this.pendingArtifacts.get(command.artifactRequestId);
      if (pending?.operationId === command.requestId)
        pending.settle(command.cancelled ? undefined : command.value);
      return;
    }
    if (command.type === "open-workspace") {
      void this.run(command.requestId, async () => {
        this.trusted ||= this.isTrusted();
        const existing = command.sessionId ? this.runtimes.get(command.sessionId) : undefined;
        const runtime =
          existing ?? (await this.createRuntime(command.newSession, command.sessionId));
        if (!existing && command.newSession && command.configuration)
          await runtime.applyConfiguration(command.configuration);
        this.emit({
          type: "session-snapshot",
          requestId: command.requestId,
          snapshot: await runtime.snapshot(command.requestId),
        });
        this.emitSessionBackgroundWork(runtime.sessionId);
        this.replayPendingArtifacts(runtime.sessionId);
      });
      return;
    }
    if (command.type === "get-changelog") {
      void this.run(
        command.requestId,
        async () => {
          this.runtimeFor(command.sessionId);
          this.emit({
            type: "changelog-snapshot",
            requestId: command.requestId,
            workspacePath: this.workspacePath,
            sessionId: command.sessionId,
            markdown: loadPiChangelog(),
          });
        },
        command.sessionId,
      );
      return;
    }
    if (command.type === "submit-review-thread") {
      void this.run(command.requestId, () => this.runReviewThread(command), command.sessionId);
      return;
    }
    void this.run(
      command.requestId,
      async () => {
        let runtime: CakeRuntime;
        if (command.type === "prompt" && command.newSession) {
          if (this.runtimes.has(command.sessionId))
            throw new Error("That temporary session has already been started");
          runtime = await this.createRuntime(true, command.sessionId);
          if (command.newSession.configuration)
            await runtime.applyConfiguration(command.newSession.configuration);
        } else {
          runtime =
            command.type === "rename-session" ||
            command.type === "prompt" ||
            command.type === "compact-session" ||
            command.type === "set-model" ||
            command.type === "set-chat-configuration"
              ? (this.runtimes.get(command.sessionId) ??
                (await this.createRuntime(false, command.sessionId)))
              : this.runtimeFor(command.sessionId);
        }
        if (command.type === "abort") await this.agentAbort(command.sessionId);
        else if (command.type === "prompt") {
          await runtime.prompt(command.text, command.delivery, command.attachments);
          this.emit({ type: "session-snapshot", snapshot: await runtime.snapshot() });
        } else if (command.type === "compact-session") {
          await runtime.compact(command.instructions);
          this.emit({ type: "session-snapshot", snapshot: await runtime.snapshot() });
        } else if (command.type === "set-model")
          await runtime.setModel(command.provider, command.modelId);
        else if (command.type === "set-chat-configuration")
          await runtime.applyConfiguration(command.configuration);
        else if (command.type === "set-thinking") await runtime.setThinkingLevel(command.level);
        else if (command.type === "set-fast-mode") {
          if (!runtime.setFastMode) throw new Error("This Pi runtime does not support Fast mode");
          await runtime.setFastMode(command.enabled);
        } else if (command.type === "set-pi-setting") {
          await runtime.setPiSetting(command.update);
          if (["packages", "extensions", "skills", "prompts"].includes(command.update.key)) {
            await Promise.all(
              [...this.runtimes.values()].map((activeRuntime) => this.reloadRuntime(activeRuntime)),
            );
          }
        } else if (command.type === "reload-pi") await this.reloadRuntime(runtime);
        else if (command.type === "refresh-models") await this.refreshModels(runtime);
        else if (command.type === "login") await runtime.login(command.provider, command.authType);
        else if (command.type === "logout") await runtime.logout(command.provider);
        else if (command.type === "rename-session") await runtime.rename(command.name);
        else if (command.type === "navigate-session") await runtime.navigate(command.entryId);
        else if (command.type === "fork-session") {
          const forked = await runtime.fork(command.entryId);
          const next = await this.createRuntime(false, forked.sessionId, forked.sessionFile);
          this.emit({
            type: "session-snapshot",
            requestId: command.requestId,
            snapshot: await next.snapshot(command.requestId),
          });
        }
      },
      command.sessionId,
    );
  }

  async releaseSessionForArchive(sessionId: string) {
    if (this.runtimePromises.has(sessionId))
      throw new Error("Cake cannot resolve a session while it is opening");
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    const snapshot = await runtime.snapshot();
    if (snapshot.streaming) throw new Error("Cake cannot resolve a session while it is running");
    if (!snapshot.sessionFile)
      throw new Error("Cake cannot resolve an empty session before it has been persisted");
    for (const [handleId, handle] of this.subagentHandles) {
      if (handle.parentSessionId !== sessionId) continue;
      this.removeSubagentHandle(handleId, handle);
      handle.controller.abort(new Error("Parent session resolved"));
      if (handle.cleanupTimer) clearTimeout(handle.cleanupTimer);
      if (handle.releaseRuntime && handle.sessionId) this.releaseAgent(handle.sessionId);
    }
    runtime.dispose();
    this.runtimes.delete(sessionId);
    this.runtimeListeners.delete(sessionId);
    this.runtimeSubagentDepth.delete(sessionId);
    this.activeAgentTurns.delete(sessionId);
  }

  [Symbol.dispose]() {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.activeReviewRuns.values()) controller.abort();
    this.activeReviewRuns.clear();
    for (const pending of this.pendingUi.values()) pending.settle(undefined);
    this.pendingUi.clear();
    this.cancelPendingRequests();
    for (const handle of this.subagentHandles.values()) {
      handle.controller.abort(new Error("Workspace driver disposed"));
      if (handle.cleanupTimer) clearTimeout(handle.cleanupTimer);
      if (handle.activityTimer) clearTimeout(handle.activityTimer);
    }
    for (const runtime of this.runtimes.values()) runtime.dispose();
    this.runtimes.clear();
    this.privateRuntimeIds.clear();
    this.privateRuntimeLeases.clear();
    this.subagentHandles.clear();
    this.runtimeSubagentDepth.clear();
  }

  cancelPendingRequests() {
    for (const pending of this.pendingArtifacts.values()) pending.settle(undefined);
    this.pendingArtifacts.clear();
  }

  async openAgent(input: {
    target:
      | { kind: "new"; visibility: "private" | "project" }
      | { kind: "attach"; sessionId: string }
      | { kind: "fork"; sessionId: string; entryId?: string; visibility: "private" | "project" };
    instructions?: string;
    tools?: string[];
    remainingSubagentDepth?: number;
    auxiliary?: boolean;
    fastMode?: boolean;
  }) {
    const createsPrivateRuntime =
      (input.target.kind === "new" || input.target.kind === "fork") &&
      input.target.visibility === "private";
    if (createsPrivateRuntime) {
      if (
        this.privateRuntimeIds.size + this.privateRuntimeReservations >=
        MAX_LIVE_PRIVATE_AGENT_RUNTIMES
      ) {
        throw new Error(
          `This workspace already has ${MAX_LIVE_PRIVATE_AGENT_RUNTIMES} live private agent runtimes. Close an unused private agent before opening another.`,
        );
      }
      this.privateRuntimeReservations += 1;
    }
    let runtime: CakeRuntime | undefined;
    let leaseAcquired = false;
    try {
      if (input.target.kind === "new") {
        runtime = await this.createRuntime(
          true,
          undefined,
          undefined,
          input.instructions,
          input.target.visibility === "private" ? this.pluginAgentSessionDir : this.sessionDir,
          {
            tools: input.tools,
            remainingSubagentDepth: input.remainingSubagentDepth,
            auxiliary: input.auxiliary,
            fastMode: input.fastMode,
          },
        );
        if (input.target.visibility === "private") this.privateRuntimeIds.add(runtime.sessionId);
      } else if (input.target.kind === "attach") {
        runtime =
          this.runtimes.get(input.target.sessionId) ??
          (await this.createRuntime(false, input.target.sessionId));
      } else {
        const source =
          this.runtimes.get(input.target.sessionId) ??
          (await this.createRuntime(false, input.target.sessionId));
        const sourceSnapshot = await source.snapshot();
        const entryId =
          input.target.entryId ??
          [...sourceSnapshot.parts]
            .reverse()
            .flatMap((part) => ("entryId" in part && part.entryId ? [part.entryId] : []))[0];
        if (!entryId) throw new Error("The source session has no branch leaf to fork");
        if (!sourceSnapshot.sessionFile) throw new Error("The source session is not persisted");
        const targetRoot =
          input.target.visibility === "private" ? this.pluginAgentSessionDir : this.sessionDir;
        const forked = forkWorkspaceSession(
          sourceSnapshot.sessionFile,
          this.workspacePath,
          targetRoot,
        );
        runtime = await this.createRuntime(
          false,
          forked.sessionId,
          forked.sessionFile,
          input.instructions,
          targetRoot,
          {
            tools: input.tools,
            remainingSubagentDepth: input.remainingSubagentDepth,
            auxiliary: input.auxiliary,
            fastMode: input.fastMode,
          },
        );
        await runtime.navigate(entryId);
        if (input.target.visibility === "private") this.privateRuntimeIds.add(runtime.sessionId);
      }
      if (this.privateRuntimeIds.has(runtime.sessionId)) {
        this.privateRuntimeLeases.set(
          runtime.sessionId,
          (this.privateRuntimeLeases.get(runtime.sessionId) ?? 0) + 1,
        );
        leaseAcquired = true;
      }
      if (input.remainingSubagentDepth !== undefined)
        this.runtimeSubagentDepth.set(runtime.sessionId, input.remainingSubagentDepth);
      return await runtime.snapshot();
    } catch (error) {
      if (leaseAcquired && runtime) this.releaseAgent(runtime.sessionId);
      else if (createsPrivateRuntime && runtime) {
        runtime.dispose();
        this.runtimes.delete(runtime.sessionId);
        this.privateRuntimeIds.delete(runtime.sessionId);
        this.privateRuntimeLeases.delete(runtime.sessionId);
      }
      throw error;
    } finally {
      if (createsPrivateRuntime) this.privateRuntimeReservations -= 1;
    }
  }

  releaseAgent(sessionId: string) {
    if (!this.privateRuntimeIds.has(sessionId)) return;
    const remaining = (this.privateRuntimeLeases.get(sessionId) ?? 1) - 1;
    if (remaining > 0) {
      this.privateRuntimeLeases.set(sessionId, remaining);
      return;
    }
    this.privateRuntimeLeases.delete(sessionId);
    for (const [handleId, handle] of this.subagentHandles) {
      if (handle.parentSessionId !== sessionId) continue;
      this.removeSubagentHandle(handleId, handle);
      handle.controller.abort(new Error("Parent subagent released"));
      if (handle.cleanupTimer) clearTimeout(handle.cleanupTimer);
      if (handle.releaseRuntime && handle.sessionId) this.releaseAgent(handle.sessionId);
    }
    this.runtimeListeners.delete(sessionId);
    this.activeAgentTurns.delete(sessionId);
    this.runtimes.get(sessionId)?.dispose();
    this.runtimes.delete(sessionId);
    this.privateRuntimeIds.delete(sessionId);
    this.runtimeSubagentDepth.delete(sessionId);
  }

  async agentSnapshot(sessionId: string) {
    return this.runtimeFor(sessionId).snapshot();
  }

  async agentPrompt(sessionId: string, text: string, delivery: "prompt" | "steer" | "follow-up") {
    const runtime = this.runtimeFor(sessionId);
    if (delivery === "prompt" && this.activeAgentTurns.has(sessionId))
      throw new Error("That agent session already has an active turn");
    if (delivery === "prompt") this.activeAgentTurns.add(sessionId);
    try {
      await runtime.prompt(text, delivery, []);
      return runtime.snapshot();
    } finally {
      if (delivery === "prompt") this.activeAgentTurns.delete(sessionId);
    }
  }

  async agentAbort(sessionId: string) {
    const runtime = this.runtimeFor(sessionId);
    const ownedHandles = [...this.subagentHandles.values()].filter(
      (handle) =>
        handle.parentSessionId === sessionId &&
        (handle.status === "queued" || handle.status === "running"),
    );
    for (const handle of ownedHandles) {
      handle.controller.abort(new Error("Parent session aborted"));
      handle.status = "aborted";
      const handleId = [...this.subagentHandles].find(([, candidate]) => candidate === handle)?.[0];
      if (handleId) this.emitSubagentActivity(handleId, handle);
      for (const observer of handle.observers) observer();
    }
    await Promise.all([
      runtime.abort(),
      ...ownedHandles.flatMap((handle) =>
        handle.sessionId && this.privateRuntimeIds.has(handle.sessionId)
          ? [this.agentAbort(handle.sessionId).then(() => undefined)]
          : [],
      ),
    ]);
    this.emitSessionBackgroundWork(sessionId);
    return runtime.snapshot();
  }

  async configureAgent(
    sessionId: string,
    provider: string,
    modelId: string,
    thinkingLevel: Parameters<CakeRuntime["setThinkingLevel"]>[0],
  ) {
    const runtime = this.runtimeFor(sessionId);
    await runtime.setModel(provider, modelId);
    await runtime.setThinkingLevel(thinkingLevel);
    return runtime.snapshot();
  }

  subscribeAgent(sessionId: string, listener: (event: CakeRuntimeEvent) => void) {
    const listeners = this.runtimeListeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.runtimeListeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.runtimeListeners.delete(sessionId);
    };
  }

  private emit(event: DesktopEvent) {
    if (!this.disposed) this.emitEvent(event);
  }

  private async run(operationId: string, operation: () => Promise<void>, sessionId?: string) {
    try {
      await this.operationContext.run({ operationId, sessionId }, operation);
      this.emit({ type: "complete", requestId: operationId });
    } catch (error) {
      const described = describeOperationError(error);
      console.error(
        `[cake] Pi workspace operation ${operationId}${sessionId ? ` (session ${sessionId})` : ""} failed:`,
        described.details ?? described.message,
      );
      this.emit({
        type: "fatal",
        requestId: operationId,
        message: described.message,
        details: described.details,
      });
    } finally {
      for (const pending of this.pendingUi.values()) {
        if (pending.operationId === operationId) pending.settle(undefined);
      }
      for (const pending of this.pendingArtifacts.values()) {
        if (pending.operationId === operationId) pending.settle(undefined);
      }
    }
  }

  private requestUi(request: RuntimeUiRequest) {
    const operationId = this.operationContext.getStore()?.operationId;
    if (!operationId) throw new Error("Pi requested UI without an active Cake operation");
    const uiRequestId = crypto.randomUUID();
    return new Promise<string | undefined>((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const settle = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        this.pendingUi.delete(uiRequestId);
        request.signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => settle(undefined);
      this.pendingUi.set(uiRequestId, { operationId, settle });
      request.signal?.addEventListener("abort", onAbort, { once: true });
      if (request.timeout) timeout = setTimeout(() => settle(undefined), request.timeout);
      this.emit({
        type: "ui-request",
        requestId: operationId,
        uiRequestId,
        kind: request.kind,
        title: request.title,
        message: request.message,
        placeholder: request.placeholder,
        initialValue: request.initialValue,
        multiline: request.multiline,
        options: request.options,
      });
    });
  }

  private async persistArtifact(artifact: CakeArtifactV1) {
    const persistedArtifact =
      artifact.kind === "request"
        ? {
            ...artifact,
            revision:
              ((
                await this.artifactRepository.get(
                  this.workspacePath,
                  artifact.sessionId,
                  artifact.id,
                )
              )?.artifact.revision ?? 0) + 1,
          }
        : artifact;
    const record = await this.artifactRepository.upsert(this.workspacePath, persistedArtifact);
    const activeSessionId = this.operationContext.getStore()?.sessionId;
    if (activeSessionId && activeSessionId !== artifact.sessionId)
      await this.artifactRepository.linkSession(record, activeSessionId);
    this.emit({ type: "artifact-updated", record });
    return record;
  }

  private requestArtifact(record: ArtifactRecord, signal: AbortSignal) {
    if (signal.aborted) return Promise.resolve(undefined);
    const operationId = this.operationContext.getStore()?.operationId;
    if (!operationId)
      throw new Error("Pi requested an artifact response without an active Cake operation");
    const artifactRequestId = crypto.randomUUID();
    return new Promise<JsonValue | undefined>((resolve) => {
      let settled = false;
      const settle = (value: JsonValue | undefined) => {
        if (settled) return;
        settled = true;
        this.pendingArtifacts.delete(artifactRequestId);
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => settle(undefined);
      this.pendingArtifacts.set(artifactRequestId, {
        operationId,
        record,
        artifactRequestId,
        settle,
      });
      signal.addEventListener("abort", onAbort, { once: true });
      this.emit({ type: "artifact-requested", requestId: operationId, artifactRequestId, record });
    });
  }

  /** Re-emits requests that are still blocking so freshly attached renderers can answer them. */
  private replayPendingArtifacts(sessionId: string) {
    for (const pending of this.pendingArtifacts.values())
      if (pending.record.artifact.sessionId === sessionId)
        this.emit({
          type: "artifact-requested",
          requestId: pending.operationId,
          artifactRequestId: pending.artifactRequestId,
          record: pending.record,
        });
  }

  private runtimeFor(sessionId: string) {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) throw new Error("That session is not open in this workspace");
    return runtime;
  }

  private reloadRuntime(runtime: CakeRuntime) {
    if (!runtime.reload) throw new Error("This Pi runtime does not support reloading");
    return runtime.reload();
  }

  private refreshModels(runtime: CakeRuntime) {
    if (!runtime.refreshModels)
      throw new Error("This Pi runtime does not support refreshing models");
    return runtime.refreshModels();
  }

  private async createRuntime(
    newSession: boolean,
    sessionId?: string,
    sessionFile?: string,
    additionalSystemPrompt?: string,
    sessionRoot = this.sessionDir,
    policy?: {
      tools?: string[];
      remainingSubagentDepth?: number;
      auxiliary?: boolean;
      fastMode?: boolean;
    },
  ) {
    if (sessionId && !sessionFile) {
      const existing = this.runtimes.get(sessionId);
      if (existing) return existing;
      const pending = this.runtimePromises.get(sessionId);
      if (pending) return pending;
    }
    const opening = this.createRuntimeUncoordinated(
      newSession,
      sessionId,
      sessionFile,
      additionalSystemPrompt,
      sessionRoot,
      policy,
    );
    if (sessionId) this.runtimePromises.set(sessionId, opening);
    try {
      return await opening;
    } finally {
      if (sessionId && this.runtimePromises.get(sessionId) === opening)
        this.runtimePromises.delete(sessionId);
    }
  }

  private async createRuntimeUncoordinated(
    newSession: boolean,
    sessionId?: string,
    sessionFile?: string,
    additionalSystemPrompt?: string,
    sessionRoot = this.sessionDir,
    policy?: {
      tools?: string[];
      remainingSubagentDepth?: number;
      auxiliary?: boolean;
      fastMode?: boolean;
    },
  ) {
    const requestedArtifactSessionId = sessionId;
    let openedSessionId = sessionId;
    const runtimeRef: RuntimeReference = {};
    const runtime = await this.createRuntimeImpl({
      cwd: this.workspacePath,
      agentDir: this.agentDir,
      sessionDir: sessionRoot,
      resolvedSessionDir: sessionRoot === this.sessionDir ? this.resolvedSessionDir : undefined,
      trusted: this.trusted,
      newSession,
      sessionId,
      sessionFile,
      pluginResources: this.pluginResources,
      additionalSystemPrompt,
      tools: policy?.tools,
      auxiliary: policy?.auxiliary,
      agentControl:
        policy?.remainingSubagentDepth === 0
          ? undefined
          : {
              spawn: (input, parentSessionId, signal, anchorPartId) =>
                this.spawnSubagent(input, parentSessionId, signal, anchorPartId),
              parallel: (input, parentSessionId, signal, onUpdate, anchorPartId) =>
                this.parallelSubagents(input, parentSessionId, signal, onUpdate, anchorPartId),
              prompt: (input, parentSessionId, signal) =>
                this.promptSubagent(input, parentSessionId, signal),
              wait: (handleId, parentSessionId, signal, onUpdate) =>
                this.waitSubagent(handleId, parentSessionId, signal, onUpdate),
              abort: (handleId, parentSessionId) => this.abortSubagent(handleId, parentSessionId),
              close: (handleId, parentSessionId) => this.closeSubagent(handleId, parentSessionId),
            },
      requestUi: (request) => this.requestUi(request),
      persistArtifact: (artifact) => this.persistArtifact(artifact),
      requestArtifact: (record, signal) => this.requestArtifact(record, signal),
      generateInlineWidget: (input) => this.generateInlineWidget(input),
      reviewContextPath: this.reviewRepository.reviewContextPath
        ? (activeSessionId) =>
            this.reviewRepository.reviewContextPath!(this.workspacePath, activeSessionId)
        : undefined,
      utilityModel: this.utilityModel,
      vscodeControl:
        policy?.auxiliary || !this.openInEditor ? undefined : { open: this.openInEditor },
      currentSessionControl: {
        resolved: () => (openedSessionId ? this.sessionResolved(openedSessionId) : false),
        setResolved: async (resolved) => {
          if (!openedSessionId) throw new Error("The Pi session is not ready");
          await this.setSessionResolved(openedSessionId, resolved);
        },
      },
      fastMode: {
        get: () => policy?.fastMode ?? (openedSessionId ? this.fastMode(openedSessionId) : false),
        set: async (enabled) => {
          const targetSessionId = openedSessionId;
          if (!targetSessionId) throw new Error("The Pi session is not ready for Fast mode");
          await this.setFastMode(targetSessionId, enabled);
        },
      },
      openExternal: this.openExternal,
      listArtifacts: async (pointers) => {
        const direct = await Promise.all(
          pointers.map((pointer) =>
            this.artifactRepository.get(this.workspacePath, pointer.sessionId, pointer.artifactId),
          ),
        );
        const sessionIds = [
          ...new Set(
            [requestedArtifactSessionId, openedSessionId].filter((value): value is string =>
              Boolean(value),
            ),
          ),
        ];
        const indexed = (
          await Promise.all(
            sessionIds.map((id) => this.artifactRepository.listSession(this.workspacePath, id)),
          )
        ).flat();
        const records = new Map<string, ArtifactRecord>();
        for (const record of [...direct, ...indexed]) {
          if (!record) continue;
          const current = records.get(record.artifact.id);
          if (!current || record.artifact.revision > current.artifact.revision)
            records.set(record.artifact.id, record);
        }
        return [...records.values()];
      },
      onEvent: (event) => {
        for (const listener of this.runtimeListeners.get(
          event.type === "snapshot" ? event.snapshot.sessionId : event.sessionId,
        ) ?? [])
          listener(event);
        const eventSessionId =
          event.type === "snapshot" ? event.snapshot.sessionId : event.sessionId;
        if (this.privateRuntimeIds.has(eventSessionId)) return;
        if (event.type === "snapshot") {
          this.emit({
            type: "session-snapshot",
            requestId: event.requestId,
            snapshot: event.snapshot,
          });
          this.emitSubagentActivities(event.snapshot.sessionId);
        } else if (
          event.type === "part-updated" ||
          event.type === "part-removed" ||
          event.type === "extension-ui"
        ) {
          this.emit(event);
          if (
            event.type === "part-updated" &&
            event.part.kind === "text" &&
            event.part.role === "user" &&
            event.part.status === "complete"
          ) {
            const activeRuntime = runtimeRef.current;
            if (activeRuntime)
              void activeRuntime
                .snapshot()
                .then((snapshot) => this.emit({ type: "session-snapshot", snapshot }))
                .catch(() => undefined);
          }
        } else
          this.emit({
            type: "session-streaming",
            sessionId: event.sessionId,
            streaming: event.streaming,
          });
      },
    });
    runtimeRef.current = runtime;
    openedSessionId = runtime.sessionId;
    if (runtime.syncFastMode) await runtime.syncFastMode();
    if (this.disposed) {
      runtime.dispose();
      throw new Error("The Pi workspace driver was disposed while opening a session");
    }
    this.runtimes.set(runtime.sessionId, runtime);
    return runtime;
  }

  private async generateInlineWidget(input: InlineWidgetGenerationRequest) {
    const generated = await this.runWidgetGeneration({
      cwd: this.workspacePath,
      agentDir: this.agentDir,
      sessionDir: this.widgetSessionDir,
      ...input,
    });
    const language = "react" as const;
    const generatedSource = extractRepairedWidget(generated.response, language);
    try {
      await this.compileWidget(language, generatedSource, "display");
      return { language, source: generatedSource, generationSessionId: generated.sessionId };
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      const repaired = await this.runWidgetRepair({
        cwd: this.workspacePath,
        agentDir: this.agentDir,
        sessionDir: this.widgetSessionDir,
        language,
        capability: "display",
        source: generatedSource,
        context: JSON.stringify({ brief: input.brief, data: input.data, fallback: input.fallback }),
        diagnostic,
        model: input.model,
        signal: input.signal,
      });
      const source = extractRepairedWidget(repaired.response, language);
      await this.compileWidget(language, source, "display");
      return { language, source, generationSessionId: generated.sessionId };
    }
  }

  private async spawnSubagent(
    rawInput: SubagentTaskInput,
    parentSessionId: string,
    signal: AbortSignal,
    anchorPartId = `subagent-${crypto.randomUUID()}`,
  ) {
    const [prepared] = await this.prepareSubagentTasks(
      [subagentTaskSchema.parse(rawInput)],
      parentSessionId,
      signal,
    );
    if (!prepared) throw new Error("Subagent preflight did not produce a task");
    return this.startSubagent(prepared, parentSessionId, anchorPartId);
  }

  private startSubagent(
    { input, resolvedModel, tools, remainingSubagentDepth }: PreparedSubagentTask,
    parentSessionId: string,
    anchorPartId: string,
  ) {
    const handleId = crypto.randomUUID();
    const handle: SubagentHandle = {
      parentSessionId,
      anchorPartId,
      releaseRuntime: false,
      taskDescription: input.task,
      profile: input.profile,
      resolvedModel,
      fastMode: input.fastMode,
      retain: input.retain,
      status: this.activeSubagents < MAX_ACTIVE_SUBAGENTS ? "running" : "queued",
      revision: 0,
      controller: new AbortController(),
      liveParts: new Map(),
      liveStreaming: false,
      observers: new Set(),
    };
    this.subagentHandles.set(handleId, handle);
    this.emitSubagentActivity(handleId, handle);
    this.emitSessionBackgroundWork(parentSessionId);
    handle.task = this.withSubagentSlot(handleId, handle, async () => {
      let snapshot = await this.openAgent({
        target: { kind: "new", visibility: "private" },
        instructions: subagentSystemPrompt(input.profile, input.instructions),
        tools,
        remainingSubagentDepth,
        auxiliary: true,
        fastMode: input.fastMode,
      });
      handle.sessionId = snapshot.sessionId;
      handle.releaseRuntime = this.privateRuntimeIds.has(snapshot.sessionId);
      if (handle.controller.signal.aborted) throw handle.controller.signal.reason;
      const modelAlreadySelected =
        snapshot.model?.provider === resolvedModel.provider &&
        snapshot.model.id === resolvedModel.modelId &&
        snapshot.thinkingLevel === resolvedModel.thinkingLevel;
      if (!modelAlreadySelected)
        snapshot = await this.configureAgent(
          snapshot.sessionId,
          resolvedModel.provider,
          resolvedModel.modelId,
          resolvedModel.thinkingLevel,
        );
      handle.liveParts = new Map(snapshot.parts.map((part) => [part.id, part]));
      handle.liveStreaming = snapshot.streaming;
      handle.unsubscribe = this.subscribeAgent(snapshot.sessionId, (event) => {
        if (event.type === "part-updated") handle.liveParts.set(event.part.id, event.part);
        else if (event.type === "part-removed") handle.liveParts.delete(event.partId);
        else if (event.type === "streaming") handle.liveStreaming = event.streaming;
        this.scheduleSubagentActivity(handleId, handle);
        for (const observer of handle.observers) observer();
      });
      const finalSnapshot = await this.agentPrompt(snapshot.sessionId, input.task, "prompt");
      if (handle.controller.signal.aborted) throw handle.controller.signal.reason;
      handle.status = "complete";
      handle.liveParts = new Map(finalSnapshot.parts.map((part) => [part.id, part]));
      handle.liveStreaming = finalSnapshot.streaming;
      handle.usage = finalSnapshot.usage;
      handle.result = this.subagentResult(handleId, handle, finalSnapshot);
      this.emitSubagentActivity(handleId, handle);
    })
      .catch((error) => {
        handle.error = error instanceof Error ? error.message : String(error);
        handle.status = handle.controller.signal.aborted ? "aborted" : "error";
        handle.result = jsonValueSchema.parse({
          handleId,
          task: handle.taskDescription,
          profile: handle.profile,
          status: handle.status,
          resolvedModel: handle.resolvedModel,
          error: handle.error,
        });
        this.emitSubagentActivity(handleId, handle);
      })
      .finally(() => {
        this.emitSessionBackgroundWork(parentSessionId);
        if (!handle.retain) handle.unsubscribe?.();
        if (
          !handle.retain &&
          handle.releaseRuntime &&
          handle.sessionId &&
          this.privateRuntimeIds.has(handle.sessionId)
        )
          this.releaseAgent(handle.sessionId);
        if (!handle.retain) this.scheduleSubagentResultExpiry(handleId, handle);
      });
    return jsonValueSchema.parse({
      handleId,
      task: input.task,
      profile: input.profile,
      status: handle.status,
      retained: input.retain,
      fastMode: input.fastMode,
      maxDepth: remainingSubagentDepth,
      resolvedModel,
    });
  }

  private async prepareSubagentTasks(
    inputs: SubagentTask[],
    parentSessionId: string,
    signal: AbortSignal,
  ): Promise<PreparedSubagentTask[]> {
    if (signal.aborted) throw signal.reason;
    const existingHandles = [...this.subagentHandles.values()].filter(
      (handle) => handle.parentSessionId === parentSessionId,
    ).length;
    if (existingHandles + inputs.length > MAX_SUBAGENT_HANDLES_PER_PARENT) {
      throw new Error(
        `An agent may own at most ${MAX_SUBAGENT_HANDLES_PER_PARENT} subagent handles. Close an unused subagent before spawning another.`,
      );
    }
    const parentRuntime = this.runtimeFor(parentSessionId);
    const parentSnapshot = await parentRuntime.snapshot();
    if (signal.aborted) throw signal.reason;
    const parentTools = parentRuntime.getReviewParentContext?.().activeTools ?? [
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
    ];
    const parentDepth = this.runtimeSubagentDepth.get(parentSessionId);
    return inputs.map((input) => {
      const remainingSubagentDepth = Math.min(
        input.maxDepth,
        parentDepth === undefined ? 1 : Math.max(0, parentDepth - 1),
      );
      const resolvedModel = this.resolveAgentModel(input.model, parentSnapshot);
      if (
        input.fastMode &&
        !supportsFastMode({ provider: resolvedModel.provider, id: resolvedModel.modelId })
      )
        throw new Error(
          `Fast mode is unavailable for ${resolvedModel.provider}/${resolvedModel.modelId}`,
        );
      return {
        input,
        resolvedModel,
        tools: toolsForSubagentProfile(input.profile, parentTools),
        remainingSubagentDepth,
      };
    });
  }

  private async parallelSubagents(
    input: ParallelSubagentTasksInput,
    parentSessionId: string,
    signal: AbortSignal,
    onUpdate?: (value: JsonValue) => void,
    anchorPartId = `subagent-${crypto.randomUUID()}`,
  ) {
    const parsedInput = parallelSubagentSchema.parse(input);
    const preparedTasks = await this.prepareSubagentTasks(
      parsedInput.tasks,
      parentSessionId,
      signal,
    );
    const handles: string[] = [];
    try {
      for (const task of preparedTasks) {
        const spawned = this.startSubagent(task, parentSessionId, anchorPartId);
        handles.push(subagentSpawnReceiptSchema.parse(spawned).handleId);
      }
      const results = await Promise.all(
        handles.map((handleId) =>
          this.waitSubagent(
            handleId,
            parentSessionId,
            signal,
            (update) => {
              onUpdate?.(
                jsonValueSchema.parse({
                  mode: "parallel",
                  completed: handles.filter((id) => this.subagentHandles.get(id)?.result).length,
                  total: handles.length,
                  latest: update,
                }),
              );
            },
            false,
          ),
        ),
      );
      const output = jsonValueSchema.parse({
        mode: "parallel",
        completed: results.length,
        total: results.length,
        results,
      });
      for (const handleId of handles) {
        const handle = this.subagentHandles.get(handleId);
        if (handle && !handle.retain) this.removeSubagentHandle(handleId, handle, 500);
      }
      return output;
    } catch (error) {
      await Promise.all(
        handles.map((handleId) =>
          this.closeSubagent(handleId, parentSessionId).catch(() => undefined),
        ),
      );
      throw error;
    }
  }

  private async promptSubagent(
    input: { handleId: string; text: string; delivery: "prompt" | "follow-up" },
    parentSessionId: string,
    signal: AbortSignal,
  ) {
    const handle = this.subagentHandle(input.handleId, parentSessionId);
    if (!handle.retain)
      throw new Error(
        "This subagent was created for one-shot work. Spawn with retain: true to use multi-turn prompts.",
      );
    const sessionId = handle.sessionId;
    if (!sessionId) throw new Error("The retained subagent is still starting");
    if (sessionId === parentSessionId)
      throw new Error("An agent cannot synchronously prompt or wait on itself");
    const onAbort = () => {
      void this.agentAbort(sessionId);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      handle.status = this.activeSubagents < MAX_ACTIVE_SUBAGENTS ? "running" : "queued";
      this.emitSubagentActivity(input.handleId, handle);
      this.emitSessionBackgroundWork(parentSessionId);
      let snapshot: Awaited<ReturnType<CakeRuntime["snapshot"]>> | undefined;
      handle.task = this.withSubagentSlot(input.handleId, handle, async () => {
        try {
          snapshot = await this.agentPrompt(sessionId, input.text, input.delivery);
          if (handle.controller.signal.aborted) throw handle.controller.signal.reason;
          handle.status = "complete";
        } catch (error) {
          handle.status = handle.controller.signal.aborted ? "aborted" : "error";
          handle.error = error instanceof Error ? error.message : String(error);
          this.emitSubagentActivity(input.handleId, handle);
          throw error;
        }
      });
      await handle.task;
      if (!snapshot) throw new Error("The retained subagent turn did not produce a snapshot");
      handle.liveParts = new Map(snapshot.parts.map((part) => [part.id, part]));
      handle.liveStreaming = snapshot.streaming;
      handle.usage = snapshot.usage;
      handle.result = this.subagentResult(input.handleId, handle, snapshot);
      this.emitSubagentActivity(input.handleId, handle);
      return handle.result;
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.emitSessionBackgroundWork(parentSessionId);
    }
  }

  private async waitSubagent(
    handleId: string,
    parentSessionId: string,
    signal: AbortSignal,
    onUpdate?: (value: JsonValue) => void,
    releaseOnComplete = true,
  ) {
    const handle = this.subagentHandle(handleId, parentSessionId);
    if (handle.sessionId === parentSessionId)
      throw new Error("An agent cannot synchronously wait on itself");
    let updateTimer: ReturnType<typeof setTimeout> | undefined;
    const emitUpdate = () => {
      if (updateTimer || !onUpdate) return;
      updateTimer = setTimeout(() => {
        updateTimer = undefined;
        onUpdate(this.liveSubagentResult(handleId, handle));
      }, 150);
    };
    if (onUpdate) handle.observers.add(emitUpdate);
    onUpdate?.(
      jsonValueSchema.parse({
        handleId,
        task: handle.taskDescription,
        profile: handle.profile,
        status: handle.status,
      }),
    );
    try {
      if (handle.task) await this.waitForSubagentTask(handle, signal);
    } finally {
      handle.observers.delete(emitUpdate);
      if (updateTimer) clearTimeout(updateTimer);
    }
    if (handle.result) {
      const result = handle.result;
      if (!handle.retain && releaseOnComplete) {
        if (handle.cleanupTimer) clearTimeout(handle.cleanupTimer);
        this.removeSubagentHandle(handleId, handle, 500);
      }
      return result;
    }
    const sessionId = handle.sessionId;
    if (!sessionId) throw new Error("The subagent did not start a runtime");
    let snapshot = await this.agentSnapshot(sessionId);
    if (snapshot.streaming) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => finish(new Error("Timed out waiting for the subagent")),
          5 * 60_000,
        );
        const unsubscribe = this.subscribeAgent(sessionId, (event) => {
          if (event.type === "streaming" && !event.streaming) finish();
        });
        const onAbort = () =>
          finish(
            signal.reason instanceof Error ? signal.reason : new Error("Subagent wait aborted"),
          );
        const finish = (error?: Error) => {
          clearTimeout(timeout);
          unsubscribe();
          signal.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      snapshot = await this.agentSnapshot(sessionId);
    }
    return this.subagentResult(handleId, handle, snapshot);
  }

  private async waitForSubagentTask(handle: SubagentHandle, signal: AbortSignal) {
    const task = handle.task;
    if (!task) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => finish(new Error("Timed out waiting for the subagent")),
        5 * 60_000,
      );
      const onAbort = () =>
        finish(signal.reason instanceof Error ? signal.reason : new Error("Subagent wait aborted"));
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      else void task.then(() => finish());
    });
  }

  steerSubagent(handleId: string, parentSessionId: string, text: string) {
    const handle = this.subagentHandle(handleId, parentSessionId);
    if (handle.status !== "running" || !handle.sessionId)
      throw new Error("That subagent is no longer available to steer");
    void this.agentPrompt(handle.sessionId, text, "steer").catch((error) => {
      if (this.subagentHandles.get(handleId) !== handle) return;
      handle.error = error instanceof Error ? error.message : String(error);
      this.emitSubagentActivity(handleId, handle);
    });
  }

  async abortSubagent(handleId: string, parentSessionId: string) {
    const handle = this.subagentHandle(handleId, parentSessionId);
    handle.controller.abort(new Error("Subagent aborted"));
    handle.status = "aborted";
    this.emitSubagentActivity(handleId, handle);
    if (!handle.sessionId || !this.privateRuntimeIds.has(handle.sessionId))
      return jsonValueSchema.parse({ handleId, streaming: false, status: handle.status });
    const snapshot = await this.agentAbort(handle.sessionId);
    return jsonValueSchema.parse({
      handleId,
      streaming: snapshot.streaming,
      status: handle.status,
    });
  }

  private async closeSubagent(handleId: string, parentSessionId: string) {
    const handle = this.subagentHandle(handleId, parentSessionId);
    this.removeSubagentHandle(handleId, handle);
    handle.controller.abort(new Error("Subagent closed"));
    if (handle.cleanupTimer) clearTimeout(handle.cleanupTimer);
    handle.unsubscribe?.();
    if (handle.releaseRuntime && handle.sessionId && this.privateRuntimeIds.has(handle.sessionId))
      this.releaseAgent(handle.sessionId);
    return jsonValueSchema.parse({ handleId, closed: true });
  }

  private subagentHandle(handleId: string, parentSessionId: string) {
    const handle = this.subagentHandles.get(handleId);
    if (!handle || handle.parentSessionId !== parentSessionId)
      throw new Error("That subagent handle does not belong to this parent session");
    return handle;
  }

  private subagentResult(
    handleId: string,
    handle: SubagentHandle,
    snapshot: Awaited<ReturnType<CakeRuntime["snapshot"]>>,
  ) {
    const result = {
      handleId,
      task: handle.taskDescription,
      profile: handle.profile,
      status: handle.status,
      resolvedModel: handle.resolvedModel,
      fastMode: handle.fastMode,
      streaming: snapshot.streaming,
      parts: snapshot.parts,
    };
    // UiPart permits optional properties, while Pi tool results must contain strict JSON values.
    return jsonValueSchema.parse(
      JSON.parse(JSON.stringify(snapshot.usage ? { ...result, usage: snapshot.usage } : result)),
    );
  }

  private liveSubagentResult(handleId: string, handle: SubagentHandle) {
    return jsonValueSchema.parse(
      JSON.parse(
        JSON.stringify({
          handleId,
          task: handle.taskDescription,
          profile: handle.profile,
          status: handle.status,
          resolvedModel: handle.resolvedModel,
          fastMode: handle.fastMode,
          streaming: handle.liveStreaming,
          parts: [...handle.liveParts.values()],
        }),
      ),
    );
  }

  private async withSubagentSlot(
    handleId: string,
    handle: SubagentHandle,
    run: () => Promise<void>,
  ) {
    if (this.activeSubagents >= MAX_ACTIVE_SUBAGENTS) {
      await new Promise<void>((resolve, reject) => {
        const start = () => {
          handle.controller.signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          this.subagentQueue.splice(this.subagentQueue.indexOf(start), 1);
          reject(handle.controller.signal.reason);
        };
        this.subagentQueue.push(start);
        handle.controller.signal.addEventListener("abort", abort, { once: true });
      });
    }
    if (handle.controller.signal.aborted) throw handle.controller.signal.reason;
    this.activeSubagents += 1;
    handle.status = "running";
    this.emitSubagentActivity(handleId, handle);
    try {
      await run();
    } finally {
      this.activeSubagents -= 1;
      this.subagentQueue.shift()?.();
    }
  }

  private scheduleSubagentActivity(handleId: string, handle: SubagentHandle) {
    if (handle.activityTimer) return;
    handle.activityTimer = setTimeout(() => {
      handle.activityTimer = undefined;
      if (this.subagentHandles.get(handleId) === handle)
        this.emitSubagentActivity(handleId, handle);
    }, 150);
  }

  private emitSubagentActivity(handleId: string, handle: SubagentHandle) {
    if (handle.activityTimer) {
      clearTimeout(handle.activityTimer);
      handle.activityTimer = undefined;
    }
    handle.revision += 1;
    this.emit({
      type: "subagent-activity",
      activity: subagentActivitySchema.parse({
        parentSessionId: handle.parentSessionId,
        anchorPartId: handle.anchorPartId,
        handleId,
        revision: handle.revision,
        task: handle.taskDescription,
        profile: handle.profile,
        status: handle.status,
        resolvedModel: handle.resolvedModel,
        fastMode: handle.fastMode,
        retained: handle.retain,
        streaming: handle.liveStreaming,
        parts: [...handle.liveParts.values()],
        usage: handle.usage,
        error: handle.error,
      }),
    });
  }

  private emitSubagentActivities(parentSessionId: string) {
    for (const [handleId, handle] of this.subagentHandles)
      if (handle.parentSessionId === parentSessionId) this.emitSubagentActivity(handleId, handle);
  }

  private removeSubagentHandle(handleId: string, handle: SubagentHandle, projectionDelayMs = 0) {
    if (this.subagentHandles.get(handleId) !== handle) return;
    this.subagentHandles.delete(handleId);
    if (handle.cleanupTimer) clearTimeout(handle.cleanupTimer);
    if (handle.activityTimer) clearTimeout(handle.activityTimer);
    const emitRemoval = () =>
      this.emit({
        type: "subagent-activity-removed",
        parentSessionId: handle.parentSessionId,
        handleId,
      });
    if (projectionDelayMs === 0) emitRemoval();
    else {
      const timer = setTimeout(emitRemoval, projectionDelayMs);
      timer.unref?.();
    }
  }

  private emitSessionBackgroundWork(sessionId: string) {
    const active = [...this.subagentHandles.values()].some(
      (handle) =>
        handle.parentSessionId === sessionId &&
        (handle.status === "queued" || handle.status === "running"),
    );
    this.emit({ type: "session-background-work", sessionId, active });
  }

  private scheduleSubagentResultExpiry(handleId: string, handle: SubagentHandle) {
    if (handle.cleanupTimer) clearTimeout(handle.cleanupTimer);
    handle.cleanupTimer = setTimeout(() => {
      this.removeSubagentHandle(handleId, handle);
    }, SUBAGENT_RESULT_TTL_MS);
    handle.cleanupTimer.unref?.();
  }

  private async runReviewThread(
    command: Extract<PiWorkspaceCommand, { type: "submit-review-thread" }>,
  ) {
    const parentRuntime = this.runtimeFor(command.sessionId);
    await this.reviewRecovery;
    const runId = crypto.randomUUID();
    const thread = await this.reviewRepository.claimPending(
      this.workspacePath,
      command.sessionId,
      command.threadId,
      runId,
    );
    if (!thread) return;
    const controller = new AbortController();
    let persistedFailure: string | undefined;
    this.activeReviewRuns.set(runId, controller);
    this.emit({
      type: "review-thread-streaming",
      workspacePath: this.workspacePath,
      sessionId: command.sessionId,
      threadId: command.threadId,
      streaming: true,
    });
    try {
      const agent = await this.runReviewTurnImpl({
        cwd: this.workspacePath,
        agentDir: this.agentDir,
        trusted: this.trusted,
        thread,
        sessionDir: this.reviewRepository.agentSessionDirectory(
          this.workspacePath,
          command.sessionId,
          command.threadId,
        ),
        parentSessionRoot: this.sessionDir,
        signal: controller.signal,
        model: command.model,
        thinkingLevel: command.thinkingLevel,
        parent: parentRuntime.getReviewParentContext?.(),
        onEvent: (event) =>
          this.emit(
            event.type === "part-updated"
              ? {
                  type: "review-thread-part-updated",
                  workspacePath: this.workspacePath,
                  sessionId: command.sessionId,
                  threadId: command.threadId,
                  part: event.part,
                }
              : {
                  type: "review-thread-usage-updated",
                  workspacePath: this.workspacePath,
                  sessionId: command.sessionId,
                  threadId: command.threadId,
                  usage: event.usage,
                },
          ),
      });
      const updated = agent.error
        ? await this.reviewRepository.failRun(
            this.workspacePath,
            command.sessionId,
            command.threadId,
            runId,
            agent.error,
          )
        : await this.reviewRepository.completeRun(
            this.workspacePath,
            command.sessionId,
            command.threadId,
            runId,
            agent,
          );
      if (updated) this.emit({ type: "review-thread-updated", thread: updated });
      if (agent.error) {
        persistedFailure = agent.error;
        throw new Error(agent.error);
      }
    } catch (error) {
      const message = errorMessage(error);
      if (message !== persistedFailure) {
        const updated = await this.reviewRepository.failRun(
          this.workspacePath,
          command.sessionId,
          command.threadId,
          runId,
          message,
        );
        if (updated) this.emit({ type: "review-thread-updated", thread: updated });
      }
      throw error;
    } finally {
      this.activeReviewRuns.delete(runId);
      this.emit({
        type: "review-thread-streaming",
        workspacePath: this.workspacePath,
        sessionId: command.sessionId,
        threadId: command.threadId,
        streaming: false,
      });
    }
  }
}

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, REVIEW_TEXT_MAX_LENGTH);
}

/** Full message plus stack and cause chain so failures stay diagnosable across IPC. */
export function describeOperationError(error: unknown) {
  if (error instanceof Error) {
    const frames = [error.stack || `${error.name}: ${error.message}`];
    let cause: unknown = error.cause;
    while (cause instanceof Error) {
      frames.push(`Caused by: ${cause.stack || `${cause.name}: ${cause.message}`}`);
      cause = cause.cause;
    }
    return { message: error.message || error.name, details: frames.join("\n\n") };
  }
  return { message: String(error), details: undefined };
}
