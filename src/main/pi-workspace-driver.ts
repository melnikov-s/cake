import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import {
  createCakeRuntime,
  type CakeRuntime,
  type CakeRuntimeEvent,
  type CakeRuntimeOptions,
  type RuntimeUiRequest,
} from "../services/pi/runtime/cake-runtime";
import { forkWorkspaceSession } from "../services/pi/runtime/session-discovery";
import {
  runInlineWidgetGeneration,
  runInlineWidgetRepair,
  type InlineWidgetGenerationRequest,
} from "../services/pi/runtime/sidecar-runtime";
import { type NativeEvent, type nativeCommandSchemas } from "../ipc/native-contract";
import type { SourceLocation } from "../ipc/source-location";
import type { ModelPreset, UtilityModel } from "../ipc/session-contract";
import type { WorktreeLandingCoordinator } from "../ipc/worktree-contract";
import type { JsonValue } from "../ipc/json-contract";
import {
  parseArtifactInput,
  type ArtifactRecord,
  type CakeArtifactV1,
} from "../ipc/artifact-contract";
import type { ArtifactRepository } from "./artifact-repository";
import type { ReviewRepository } from "./review-repository";
import { compileInlineWidget, extractRepairedWidget } from "./inline-widget-service";

type ArtifactRepositoryPort = Pick<
  ArtifactRepository,
  "upsert" | "get" | "listSession" | "linkSession"
>;
type ReviewRepositoryPort = Partial<Pick<ReviewRepository, "reviewContextPath">>;

const MAX_LIVE_PRIVATE_AGENT_RUNTIMES = 32;

export type PiWorkspaceCommand =
  | (typeof nativeCommandSchemas)["respond-ui"]["Type"]
  | (typeof nativeCommandSchemas)["respond-artifact"]["Type"];

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

type ProjectSessionRuntimeIntegrations = Pick<
  CakeRuntimeOptions,
  | "generateInlineWidget"
  | "listArtifacts"
  | "persistArtifact"
  | "requestArtifact"
  | "requestUi"
  | "reviewContextPath"
>;

export interface PiWorkspaceDriverOptions {
  workspacePath: string;
  agentDir: string;
  sessionDir: string;
  resolvedSessionDir?: string;
  widgetSessionDir?: string;
  pluginAgentSessionDir?: string;
  emit(event: NativeEvent): void;
  createRuntime?: typeof createCakeRuntime;
  runWidgetGeneration?: typeof runInlineWidgetGeneration;
  runWidgetRepair?: typeof runInlineWidgetRepair;
  compileWidget?: typeof compileInlineWidget;
  artifactRepository?: ArtifactRepositoryPort;
  reviewRepository?: ReviewRepositoryPort;
  openExternal?: (url: string) => Promise<void>;
  openInEditor?: (location: SourceLocation, signal: AbortSignal) => Promise<SourceLocation>;
  isTrusted?: () => boolean;
  utilityModel?: () => UtilityModel | undefined;
  generateSessionTitle?: NonNullable<CakeRuntimeOptions["generateSessionTitle"]>;
  modelPresets?: () => {
    readonly presets: readonly Pick<ModelPreset, "id" | "name" | "modelId">[];
    readonly defaultPresetId?: string;
  };
  worktreeLanding?: WorktreeLandingCoordinator;
  fastMode?(sessionId: string): boolean;
  setFastMode?(sessionId: string, enabled: boolean): Promise<void>;
  sessionResolved?(sessionId: string): boolean;
  setSessionResolved?(sessionId: string, resolved: boolean): Promise<void>;
  pluginResources?: { skills: string[]; prompts: string[]; extensions: string[] };
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
  private readonly runWidgetGeneration: typeof runInlineWidgetGeneration;
  private readonly runWidgetRepair: typeof runInlineWidgetRepair;
  private readonly compileWidget: typeof compileInlineWidget;
  private readonly artifactRepository: ArtifactRepositoryPort;
  private readonly reviewRepository: ReviewRepositoryPort;
  private readonly openExternal: NonNullable<PiWorkspaceDriverOptions["openExternal"]> | undefined;
  private readonly openInEditor: PiWorkspaceDriverOptions["openInEditor"];
  private readonly isTrusted: () => boolean;
  private readonly utilityModel: () => UtilityModel | undefined;
  private readonly generateSessionTitle: PiWorkspaceDriverOptions["generateSessionTitle"];
  private readonly modelPresets: PiWorkspaceDriverOptions["modelPresets"];
  private readonly worktreeLanding: WorktreeLandingCoordinator | undefined;
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
  private readonly pendingUi = new Map<string, PendingUi>();
  private readonly pendingArtifacts = new Map<string, PendingArtifact>();
  private readonly operationContext = new AsyncLocalStorage<{
    operationId: string;
    sessionId?: string;
  }>();
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
    this.runWidgetGeneration = options.runWidgetGeneration ?? runInlineWidgetGeneration;
    this.runWidgetRepair = options.runWidgetRepair ?? runInlineWidgetRepair;
    this.compileWidget = options.compileWidget ?? compileInlineWidget;
    this.openExternal = options.openExternal;
    this.openInEditor = options.openInEditor;
    this.isTrusted = options.isTrusted ?? (() => false);
    this.utilityModel = options.utilityModel ?? (() => undefined);
    this.generateSessionTitle = options.generateSessionTitle;
    this.modelPresets = options.modelPresets;
    this.worktreeLanding = options.worktreeLanding;
    this.fastMode = options.fastMode ?? (() => false);
    this.setFastMode = options.setFastMode ?? (async () => undefined);
    this.sessionResolved = options.sessionResolved ?? (() => false);
    this.setSessionResolved = options.setSessionResolved ?? (async () => undefined);
    this.pluginResources = options.pluginResources ?? { skills: [], prompts: [], extensions: [] };
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
    this.reviewRepository = options.reviewRepository ?? {};
  }

  dispatch(command: PiWorkspaceCommand) {
    if (this.disposed) throw new Error("The Pi workspace driver has been disposed");
    if (command.type === "respond-ui") {
      const pending = this.pendingUi.get(command.uiRequestId);
      if (pending?.operationId === command.requestId)
        pending.settle(command.cancelled ? undefined : command.value);
      return;
    }
    const pending = this.pendingArtifacts.get(command.artifactRequestId);
    if (pending?.operationId === command.requestId)
      pending.settle(command.cancelled ? undefined : command.value);
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
    runtime.dispose();
    this.runtimes.delete(sessionId);
    this.runtimeListeners.delete(sessionId);
    this.activeAgentTurns.delete(sessionId);
  }

  [Symbol.dispose]() {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pendingUi.values()) pending.settle(undefined);
    this.pendingUi.clear();
    this.cancelPendingRequests();
    for (const runtime of this.runtimes.values()) runtime.dispose();
    this.runtimes.clear();
    this.privateRuntimeIds.clear();
    this.privateRuntimeLeases.clear();
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
    this.runtimeListeners.delete(sessionId);
    this.activeAgentTurns.delete(sessionId);
    this.runtimes.get(sessionId)?.dispose();
    this.runtimes.delete(sessionId);
    this.privateRuntimeIds.delete(sessionId);
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
    await runtime.abort();
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

  private emit(event: NativeEvent) {
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
    const operationId = this.operationContext.getStore()?.operationId ?? crypto.randomUUID();
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
    const operationId = this.operationContext.getStore()?.operationId ?? crypto.randomUUID();
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

  /**
   * Supplies the temporary non-lifecycle integrations still coordinated by the
   * driver while Project Session runtime ownership lives in PiSessions.
   * Packets 6B/6C and the artifact/review slices remove these callbacks.
   */
  projectSessionRuntimeIntegrations(sessionId: string): ProjectSessionRuntimeIntegrations {
    const reviewContextPath = this.reviewRepository.reviewContextPath;
    return {
      requestUi: (request) => this.requestUi(request),
      persistArtifact: (artifact) => this.persistArtifact(artifact),
      requestArtifact: (record, signal) => this.requestArtifact(record, signal),
      generateInlineWidget: (input) => this.generateInlineWidget(input),
      reviewContextPath: reviewContextPath
        ? (activeSessionId) => reviewContextPath(this.workspacePath, activeSessionId)
        : undefined,
      listArtifacts: async (pointers) => {
        const direct = await Promise.all(
          pointers.map((pointer) =>
            this.artifactRepository.get(this.workspacePath, pointer.sessionId, pointer.artifactId),
          ),
        );
        const indexed = await this.artifactRepository.listSession(this.workspacePath, sessionId);
        const records = new Map<string, ArtifactRecord>();
        for (const record of [...direct, ...indexed]) {
          if (!record) continue;
          const current = records.get(record.artifact.id);
          if (!current || record.artifact.revision > current.artifact.revision)
            records.set(record.artifact.id, record);
        }
        return [...records.values()];
      },
    };
  }

  private async createRuntime(
    newSession: boolean,
    sessionId?: string,
    sessionFile?: string,
    additionalSystemPrompt?: string,
    sessionRoot = this.sessionDir,
    policy?: {
      tools?: string[];
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
      requestUi: (request) => this.requestUi(request),
      persistArtifact: (artifact) => this.persistArtifact(artifact),
      requestArtifact: (record, signal) => this.requestArtifact(record, signal),
      generateInlineWidget: (input) => this.generateInlineWidget(input),
      reviewContextPath: this.reviewRepository.reviewContextPath
        ? (activeSessionId) =>
            this.reviewRepository.reviewContextPath!(this.workspacePath, activeSessionId)
        : undefined,
      utilityModel: this.utilityModel,
      generateSessionTitle: this.generateSessionTitle,
      modelPresets: this.modelPresets,
      worktreeLandingControl:
        policy?.auxiliary || !this.worktreeLanding
          ? undefined
          : {
              proposeSquashMessage: (message) =>
                this.worktreeLanding!.proposeSquashMessage({
                  workspacePath: this.workspacePath,
                  ...message,
                }),
            },
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
