import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { createCakeRuntime, type CakeRuntime, type CakeRuntimeEvent, type RuntimeUiRequest } from "../agent/cake-runtime";
import { forkWorkspaceSession, loadPiChangelog } from "../agent/session-discovery";
import { runInlineWidgetGeneration, runInlineWidgetRepair, runReviewTurn, type InlineWidgetGenerationRequest } from "../agent/sidecar-runtime";
import type { DesktopEvent, DesktopRequest } from "../ipc/desktop-ipc";
import type { ChangeTurn, UtilityModel } from "../ipc/session-contract";
import type { JsonValue } from "../ipc/json-contract";
import { jsonValueSchema } from "../ipc/json-contract";
import type { AgentModelPreference, ResolvedAgentModel } from "../ipc/plugin-agent-contract";
import { parseArtifactInput, type ArtifactRecord, type CakeArtifactV1 } from "../ipc/artifact-contract";
import { REVIEW_TEXT_MAX_LENGTH } from "../ipc/review-contract";
import type { ArtifactRepository } from "./artifact-repository";
import type { ReviewRepository } from "./review-repository";
import { captureWorkspaceCheckpoint, collectCheckpointChanges, collectWorkingTreeChanges, NotGitRepositoryError, summarizeCheckpointChanges } from "./git-changes";
import { compileInlineWidget, extractRepairedWidget } from "./inline-widget-service";

type ArtifactRepositoryPort = Pick<ArtifactRepository, "upsert" | "get" | "listSession" | "linkSession">;
type ReviewRepositoryPort = Pick<ReviewRepository, "claimPending" | "completeRun" | "failRun" | "recoverRunning" | "agentSessionDirectory"> & Partial<Pick<ReviewRepository, "reviewContextPath">>;

export const MAX_LIVE_PRIVATE_AGENT_RUNTIMES = 32;
export const MAX_SUBAGENT_HANDLES_PER_PARENT = 8;

type PiCommandType =
  | "open-workspace"
  | "rename-session"
  | "fork-session"
  | "navigate-session"
  | "inspect-changes"
  | "get-changelog"
  | "prompt"
  | "submit-review-thread"
  | "abort"
  | "set-model"
  | "set-thinking"
  | "set-pi-setting"
  | "reload-pi"
  | "login"
  | "logout"
  | "respond-ui"
  | "respond-artifact";

type PiCommandRequest = Extract<DesktopRequest, { type: PiCommandType }>;
export type PiWorkspaceCommand =
  PiCommandRequest;

interface PendingUi {
  operationId: string;
  settle(value: string | undefined): void;
}

interface PendingArtifact {
  operationId: string;
  settle(value: JsonValue | undefined): void;
}

interface RuntimeReference {
  current?: CakeRuntime;
}

interface SubagentHandle {
  parentSessionId: string;
  sessionId: string;
  releaseRuntime: boolean;
  task?: Promise<void>;
  error?: string;
}

export interface PiWorkspaceDriverOptions {
  workspacePath: string;
  agentDir: string;
  sessionDir: string;
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
  captureCheckpoint?: typeof captureWorkspaceCheckpoint;
  collectWorkingChanges?: typeof collectWorkingTreeChanges;
  collectCheckpointChanges?: typeof collectCheckpointChanges;
  summarizeCheckpointChanges?: typeof summarizeCheckpointChanges;
  openExternal?: (url: string) => Promise<void>;
  isTrusted?: () => boolean;
  utilityModel?: () => UtilityModel | undefined;
  pluginResources?: { skills: string[]; prompts: string[]; extensions: string[] };
  resolveAgentModel?: (preference: AgentModelPreference, snapshot: Awaited<ReturnType<CakeRuntime["snapshot"]>>) => ResolvedAgentModel;
}

export class PiWorkspaceDriver {
  readonly workspacePath: string;
  private readonly emitEvent: PiWorkspaceDriverOptions["emit"];
  private readonly agentDir: string;
  private readonly sessionDir: string;
  private readonly widgetSessionDir: string;
  private readonly pluginAgentSessionDir: string;
  private readonly createRuntimeImpl: typeof createCakeRuntime;
  private readonly runReviewTurnImpl: typeof runReviewTurn;
  private readonly runWidgetGeneration: typeof runInlineWidgetGeneration;
  private readonly runWidgetRepair: typeof runInlineWidgetRepair;
  private readonly compileWidget: typeof compileInlineWidget;
  private readonly artifactRepository: ArtifactRepositoryPort;
  private readonly reviewRepository: ReviewRepositoryPort;
  private readonly captureCheckpoint: typeof captureWorkspaceCheckpoint;
  private readonly collectWorkingChanges: typeof collectWorkingTreeChanges;
  private readonly collectCheckpointChanges: typeof collectCheckpointChanges;
  private readonly summarizeCheckpointChanges: typeof summarizeCheckpointChanges;
  private readonly openExternal: NonNullable<PiWorkspaceDriverOptions["openExternal"]> | undefined;
  private readonly isTrusted: () => boolean;
  private readonly utilityModel: () => UtilityModel | undefined;
  private readonly pluginResources: { skills: string[]; prompts: string[]; extensions: string[] };
  private readonly runtimes = new Map<string, CakeRuntime>();
  private readonly runtimePromises = new Map<string, Promise<CakeRuntime>>();
  private readonly runtimeListeners = new Map<string, Set<(event: CakeRuntimeEvent) => void>>();
  private readonly privateRuntimeIds = new Set<string>();
  private readonly privateRuntimeLeases = new Map<string, number>();
  private privateRuntimeReservations = 0;
  private readonly activeAgentTurns = new Set<string>();
  private readonly subagentHandles = new Map<string, SubagentHandle>();
  private readonly resolveAgentModel: NonNullable<PiWorkspaceDriverOptions["resolveAgentModel"]>;
  private readonly pendingUi = new Map<string, PendingUi>();
  private readonly pendingArtifacts = new Map<string, PendingArtifact>();
  private readonly operationContext = new AsyncLocalStorage<{ operationId: string; sessionId?: string }>();
  private readonly activeReviewRuns = new Map<string, AbortController>();
  private readonly reviewRecovery: Promise<void>;
  private trusted = false;
  private disposed = false;

  constructor(options: PiWorkspaceDriverOptions) {
    this.workspacePath = options.workspacePath;
    this.agentDir = options.agentDir;
    this.sessionDir = options.sessionDir;
    this.widgetSessionDir = options.widgetSessionDir ?? resolve(options.sessionDir, "..", "widget-sessions");
    this.pluginAgentSessionDir = options.pluginAgentSessionDir ?? resolve(options.sessionDir, "..", "plugin-agent-sessions");
    this.emitEvent = options.emit;
    this.createRuntimeImpl = options.createRuntime ?? createCakeRuntime;
    this.runReviewTurnImpl = options.runReviewTurn ?? runReviewTurn;
    this.runWidgetGeneration = options.runWidgetGeneration ?? runInlineWidgetGeneration;
    this.runWidgetRepair = options.runWidgetRepair ?? runInlineWidgetRepair;
    this.compileWidget = options.compileWidget ?? compileInlineWidget;
    this.openExternal = options.openExternal;
    this.captureCheckpoint = options.captureCheckpoint ?? captureWorkspaceCheckpoint;
    this.collectWorkingChanges = options.collectWorkingChanges ?? collectWorkingTreeChanges;
    this.collectCheckpointChanges = options.collectCheckpointChanges ?? collectCheckpointChanges;
    this.summarizeCheckpointChanges = options.summarizeCheckpointChanges ?? summarizeCheckpointChanges;
    this.isTrusted = options.isTrusted ?? (() => false);
    this.utilityModel = options.utilityModel ?? (() => undefined);
    this.pluginResources = options.pluginResources ?? { skills: [], prompts: [], extensions: [] };
    this.resolveAgentModel = options.resolveAgentModel ?? ((preference, snapshot) => {
      if (preference.prefer === "exact") return { requested: "exact", source: "exact", provider: preference.provider, modelId: preference.modelId, thinkingLevel: preference.thinkingLevel ?? snapshot.thinkingLevel, fallbacks: [] };
      if (!snapshot.model) throw new Error("The calling session has no current model");
      return { requested: preference.prefer, source: "current", provider: snapshot.model.provider, modelId: snapshot.model.id, thinkingLevel: snapshot.thinkingLevel, fallbacks: preference.prefer === "current" ? [] : [{ source: preference.prefer, reason: "not-configured" }] };
    });
    this.artifactRepository = options.artifactRepository ?? {
      async upsert(workspacePath, artifact) {
        const now = new Date().toISOString();
        return { artifact: parseArtifactInput(artifact), workspacePath, digest: "0".repeat(64), createdAt: now, updatedAt: now };
      },
      async listSession() { return []; }
      ,async get() { return undefined; }
      ,async linkSession() { return undefined; }
    };
    this.reviewRepository = options.reviewRepository ?? {
      async claimPending() { return undefined; },
      async completeRun() { throw new Error("Review persistence is unavailable"); },
      async failRun() { throw new Error("Review persistence is unavailable"); },
      async recoverRunning() {},
      agentSessionDirectory() { throw new Error("Review persistence is unavailable"); }
    };
    this.reviewRecovery = this.reviewRepository.recoverRunning(this.workspacePath);
    void this.reviewRecovery.catch(() => undefined);
  }

  dispatch(command: PiWorkspaceCommand) {
    if (this.disposed) throw new Error("The Pi workspace driver has been disposed");
    if (command.type === "respond-ui") {
      const pending = this.pendingUi.get(command.uiRequestId);
      if (pending?.operationId === command.requestId) pending.settle(command.cancelled ? undefined : command.value);
      return;
    }
    if (command.type === "respond-artifact") {
      const pending = this.pendingArtifacts.get(command.artifactRequestId);
      if (pending?.operationId === command.requestId) pending.settle(command.cancelled ? undefined : command.value);
      return;
    }
    if (command.type === "open-workspace") {
      void this.run(command.requestId, async () => {
        this.trusted ||= this.isTrusted();
        const existing = command.sessionId ? this.runtimes.get(command.sessionId) : undefined;
        const runtime = existing ?? await this.createRuntime(command.newSession, command.sessionId);
        this.emit({ type: "session-snapshot", requestId: command.requestId, snapshot: await runtime.snapshot(command.requestId) });
      });
      return;
    }
    if (command.type === "inspect-changes") {
      void this.run(command.requestId, () => this.inspectChanges(command), command.sessionId);
      return;
    }
    if (command.type === "get-changelog") {
      void this.run(command.requestId, async () => {
        this.runtimeFor(command.sessionId);
        this.emit({ type: "changelog-snapshot", requestId: command.requestId, workspacePath: this.workspacePath, sessionId: command.sessionId, markdown: loadPiChangelog() });
      }, command.sessionId);
      return;
    }
    if (command.type === "submit-review-thread") {
      void this.run(command.requestId, () => this.runReviewThread(command), command.sessionId);
      return;
    }
    void this.run(command.requestId, async () => {
      const runtime = command.type === "rename-session" || command.type === "prompt" || command.type === "set-model"
        ? this.runtimes.get(command.sessionId) ?? await this.createRuntime(false, command.sessionId)
        : this.runtimeFor(command.sessionId);
      if (command.type === "abort") await runtime.abort();
      else if (command.type === "prompt") {
        await runtime.prompt(command.text, command.delivery, command.attachments);
        this.emit({ type: "session-snapshot", snapshot: await runtime.snapshot() });
      }
      else if (command.type === "set-model") await runtime.setModel(command.provider, command.modelId);
      else if (command.type === "set-thinking") await runtime.setThinkingLevel(command.level);
      else if (command.type === "set-pi-setting") {
        await runtime.setPiSetting(command.update);
        if (["packages", "extensions", "skills", "prompts"].includes(command.update.key)) {
          await Promise.all([...this.runtimes.values()].map((activeRuntime) => this.reloadRuntime(activeRuntime)));
        }
      }
      else if (command.type === "reload-pi") await this.reloadRuntime(runtime);
      else if (command.type === "login") await runtime.login(command.provider, command.authType);
      else if (command.type === "logout") await runtime.logout(command.provider);
      else if (command.type === "rename-session") await runtime.rename(command.name);
      else if (command.type === "navigate-session") await runtime.navigate(command.entryId);
      else if (command.type === "fork-session") {
        const forked = await runtime.fork(command.entryId);
        const next = await this.createRuntime(false, forked.sessionId, forked.sessionFile);
        this.emit({ type: "session-snapshot", requestId: command.requestId, snapshot: await next.snapshot(command.requestId) });
      }
    }, command.sessionId);
  }

  [Symbol.dispose]() {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.activeReviewRuns.values()) controller.abort();
    this.activeReviewRuns.clear();
    for (const pending of this.pendingUi.values()) pending.settle(undefined);
    this.pendingUi.clear();
    this.cancelPendingRequests();
    for (const runtime of this.runtimes.values()) runtime.dispose();
    this.runtimes.clear();
    this.privateRuntimeIds.clear();
    this.privateRuntimeLeases.clear();
    this.subagentHandles.clear();
  }

  cancelPendingRequests() {
    for (const pending of this.pendingArtifacts.values()) pending.settle(undefined);
    this.pendingArtifacts.clear();
  }

  async openAgent(input: {
    target: { kind: "new"; visibility: "private" | "project" } | { kind: "attach"; sessionId: string } | { kind: "fork"; sessionId: string; entryId?: string; visibility: "private" | "project" };
    instructions?: string;
  }) {
    const createsPrivateRuntime = (input.target.kind === "new" || input.target.kind === "fork") && input.target.visibility === "private";
    if (createsPrivateRuntime) {
      if (this.privateRuntimeIds.size + this.privateRuntimeReservations >= MAX_LIVE_PRIVATE_AGENT_RUNTIMES) {
        throw new Error(`This workspace already has ${MAX_LIVE_PRIVATE_AGENT_RUNTIMES} live private agent runtimes. Close an unused private agent before opening another.`);
      }
      this.privateRuntimeReservations += 1;
    }
    let runtime: CakeRuntime | undefined;
    let leaseAcquired = false;
    try {
      if (input.target.kind === "new") {
        runtime = await this.createRuntime(true, undefined, undefined, input.instructions, input.target.visibility === "private" ? this.pluginAgentSessionDir : this.sessionDir);
        if (input.target.visibility === "private") this.privateRuntimeIds.add(runtime.sessionId);
      } else if (input.target.kind === "attach") {
        runtime = this.runtimes.get(input.target.sessionId) ?? await this.createRuntime(false, input.target.sessionId);
      } else {
        const source = this.runtimes.get(input.target.sessionId) ?? await this.createRuntime(false, input.target.sessionId);
        const sourceSnapshot = await source.snapshot();
        const entryId = input.target.entryId ?? [...sourceSnapshot.parts].reverse().flatMap((part) => "entryId" in part && part.entryId ? [part.entryId] : [])[0];
        if (!entryId) throw new Error("The source session has no branch leaf to fork");
        if (!sourceSnapshot.sessionFile) throw new Error("The source session is not persisted");
        const targetRoot = input.target.visibility === "private" ? this.pluginAgentSessionDir : this.sessionDir;
        const forked = forkWorkspaceSession(sourceSnapshot.sessionFile, this.workspacePath, targetRoot);
        runtime = await this.createRuntime(false, forked.sessionId, forked.sessionFile, input.instructions, targetRoot);
        await runtime.navigate(entryId);
        if (input.target.visibility === "private") this.privateRuntimeIds.add(runtime.sessionId);
      }
      if (this.privateRuntimeIds.has(runtime.sessionId)) {
        this.privateRuntimeLeases.set(runtime.sessionId, (this.privateRuntimeLeases.get(runtime.sessionId) ?? 0) + 1);
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
    for (const [handleId, handle] of this.subagentHandles) {
      if (handle.parentSessionId !== sessionId) continue;
      this.subagentHandles.delete(handleId);
      if (handle.releaseRuntime) this.releaseAgent(handle.sessionId);
    }
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
    if (delivery === "prompt" && this.activeAgentTurns.has(sessionId)) throw new Error("That agent session already has an active turn");
    if (delivery === "prompt") this.activeAgentTurns.add(sessionId);
    try {
      await runtime.prompt(text, delivery, []);
      return runtime.snapshot();
    } finally {
      if (delivery === "prompt") this.activeAgentTurns.delete(sessionId);
    }
  }

  async agentAbort(sessionId: string) {
    await this.runtimeFor(sessionId).abort();
    return this.runtimeFor(sessionId).snapshot();
  }

  async configureAgent(sessionId: string, provider: string, modelId: string, thinkingLevel: Parameters<CakeRuntime["setThinkingLevel"]>[0]) {
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
      this.emit({ type: "fatal", requestId: operationId, message: errorMessage(error) });
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
        options: request.options
      });
    });
  }

  private async persistArtifact(artifact: CakeArtifactV1) {
    const persistedArtifact = artifact.kind === "request"
      ? { ...artifact, revision: ((await this.artifactRepository.get(this.workspacePath, artifact.sessionId, artifact.id))?.artifact.revision ?? 0) + 1 }
      : artifact;
    const record = await this.artifactRepository.upsert(this.workspacePath, persistedArtifact);
    const activeSessionId = this.operationContext.getStore()?.sessionId;
    if (activeSessionId && activeSessionId !== artifact.sessionId) await this.artifactRepository.linkSession(record, activeSessionId);
    this.emit({ type: "artifact-updated", record });
    return record;
  }

  private requestArtifact(record: ArtifactRecord, signal: AbortSignal) {
    const operationId = this.operationContext.getStore()?.operationId;
    if (!operationId) throw new Error("Pi requested an artifact response without an active Cake operation");
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
      this.pendingArtifacts.set(artifactRequestId, { operationId, settle });
      signal.addEventListener("abort", onAbort, { once: true });
      this.emit({ type: "artifact-requested", requestId: operationId, artifactRequestId, record });
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

  private async createRuntime(newSession: boolean, sessionId?: string, sessionFile?: string, additionalSystemPrompt?: string, sessionRoot = this.sessionDir) {
    if (sessionId && !sessionFile) {
      const existing = this.runtimes.get(sessionId);
      if (existing) return existing;
      const pending = this.runtimePromises.get(sessionId);
      if (pending) return pending;
    }
    const opening = this.createRuntimeUncoordinated(newSession, sessionId, sessionFile, additionalSystemPrompt, sessionRoot);
    if (sessionId) this.runtimePromises.set(sessionId, opening);
    try { return await opening; }
    finally { if (sessionId && this.runtimePromises.get(sessionId) === opening) this.runtimePromises.delete(sessionId); }
  }

  private async createRuntimeUncoordinated(newSession: boolean, sessionId?: string, sessionFile?: string, additionalSystemPrompt?: string, sessionRoot = this.sessionDir) {
    const requestedArtifactSessionId = sessionId;
    let openedSessionId = sessionId;
    const runtimeRef: RuntimeReference = {};
    const runtime = await this.createRuntimeImpl({
      cwd: this.workspacePath,
      agentDir: this.agentDir,
      sessionDir: sessionRoot,
      trusted: this.trusted,
      newSession,
      sessionId,
      sessionFile,
      pluginResources: this.pluginResources,
      additionalSystemPrompt,
      agentControl: {
        spawn: (input, parentSessionId, signal) => this.spawnSubagent(input, parentSessionId, signal),
        prompt: (input, parentSessionId, signal) => this.promptSubagent(input, parentSessionId, signal),
        wait: (handleId, parentSessionId, signal) => this.waitSubagent(handleId, parentSessionId, signal),
        abort: (handleId, parentSessionId) => this.abortSubagent(handleId, parentSessionId),
        close: (handleId, parentSessionId) => this.closeSubagent(handleId, parentSessionId)
      },
      requestUi: (request) => this.requestUi(request),
      persistArtifact: (artifact) => this.persistArtifact(artifact),
      requestArtifact: (record, signal) => this.requestArtifact(record, signal),
      generateInlineWidget: (input) => this.generateInlineWidget(input),
      reviewContextPath: this.reviewRepository.reviewContextPath
        ? (activeSessionId) => this.reviewRepository.reviewContextPath!(this.workspacePath, activeSessionId)
        : undefined,
      utilityModel: this.utilityModel,
      openExternal: this.openExternal,
      captureGitCheckpoint: (activeSessionId) => this.captureCheckpoint(this.workspacePath, activeSessionId),
      listArtifacts: async (pointers) => {
        const direct = await Promise.all(pointers.map((pointer) => this.artifactRepository.get(this.workspacePath, pointer.sessionId, pointer.artifactId)));
        const sessionIds = [...new Set([requestedArtifactSessionId, openedSessionId].filter((value): value is string => Boolean(value)))];
        const indexed = (await Promise.all(sessionIds.map((id) => this.artifactRepository.listSession(this.workspacePath, id)))).flat();
        const records = new Map<string, ArtifactRecord>();
        for (const record of [...direct, ...indexed]) {
          if (!record) continue;
          const current = records.get(record.artifact.id);
          if (!current || record.artifact.revision > current.artifact.revision) records.set(record.artifact.id, record);
        }
        return [...records.values()];
      },
      onEvent: (event) => {
        for (const listener of this.runtimeListeners.get(event.type === "snapshot" ? event.snapshot.sessionId : event.sessionId) ?? []) listener(event);
        const eventSessionId = event.type === "snapshot" ? event.snapshot.sessionId : event.sessionId;
        if (this.privateRuntimeIds.has(eventSessionId)) return;
        if (event.type === "snapshot") this.emit({ type: "session-snapshot", requestId: event.requestId, snapshot: event.snapshot });
        else if (event.type === "part-updated" || event.type === "part-removed" || event.type === "extension-ui") {
          this.emit(event);
          if (event.type === "part-updated" && event.part.kind === "text" && event.part.role === "user" && event.part.status === "complete") {
            const activeRuntime = runtimeRef.current;
            if (activeRuntime) void activeRuntime.snapshot().then((snapshot) => this.emit({ type: "session-snapshot", snapshot })).catch(() => undefined);
          }
        }
        else this.emit({ type: "session-streaming", sessionId: event.sessionId, streaming: event.streaming });
      }
    });
    runtimeRef.current = runtime;
    openedSessionId = runtime.sessionId;
    if (this.disposed) {
      runtime.dispose();
      throw new Error("The Pi workspace driver was disposed while opening a session");
    }
    this.runtimes.set(runtime.sessionId, runtime);
    void runtime.ensureInitialGitCheckpoint?.().catch(() => undefined);
    return runtime;
  }

  private async generateInlineWidget(input: InlineWidgetGenerationRequest) {
    const generated = await this.runWidgetGeneration({
      cwd: this.workspacePath,
      agentDir: this.agentDir,
      sessionDir: this.widgetSessionDir,
      ...input
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
        signal: input.signal
      });
      const source = extractRepairedWidget(repaired.response, language);
      await this.compileWidget(language, source, "display");
      return { language, source, generationSessionId: generated.sessionId };
    }
  }

  private async spawnSubagent(input: { task: string; model: AgentModelPreference; instructions?: string }, parentSessionId: string, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    if ([...this.subagentHandles.values()].filter((handle) => handle.parentSessionId === parentSessionId).length >= MAX_SUBAGENT_HANDLES_PER_PARENT) {
      throw new Error(`An agent may own at most ${MAX_SUBAGENT_HANDLES_PER_PARENT} subagent handles. Close an unused subagent before spawning another.`);
    }
    let snapshot = await this.openAgent({ target: { kind: "new", visibility: "private" }, instructions: input.instructions });
    const releaseRuntime = this.privateRuntimeIds.has(snapshot.sessionId);
    if (signal.aborted) {
      if (releaseRuntime) this.releaseAgent(snapshot.sessionId);
      throw signal.reason;
    }
    let resolvedModel: ResolvedAgentModel;
    try {
      resolvedModel = this.resolveAgentModel(input.model, snapshot);
      const modelAlreadySelected = snapshot.model?.provider === resolvedModel.provider && snapshot.model.id === resolvedModel.modelId && snapshot.thinkingLevel === resolvedModel.thinkingLevel;
      if (!modelAlreadySelected) {
        if (snapshot.streaming) throw new Error("Cannot change the model profile while the attached agent is running");
        snapshot = await this.configureAgent(snapshot.sessionId, resolvedModel.provider, resolvedModel.modelId, resolvedModel.thinkingLevel);
      }
    } catch (error) {
      if (releaseRuntime) this.releaseAgent(snapshot.sessionId);
      throw error;
    }
    const handleId = crypto.randomUUID();
    const handle: SubagentHandle = { parentSessionId, sessionId: snapshot.sessionId, releaseRuntime };
    this.subagentHandles.set(handleId, handle);
    handle.task = this.agentPrompt(snapshot.sessionId, input.task, "prompt")
      .then(() => undefined)
      .catch((error) => { handle.error = error instanceof Error ? error.message : String(error); });
    return jsonValueSchema.parse({ handleId, resolvedModel, running: true });
  }

  private async promptSubagent(input: { handleId: string; text: string; delivery: "prompt" | "follow-up" }, parentSessionId: string, signal: AbortSignal) {
    const handle = this.subagentHandle(input.handleId, parentSessionId);
    if (handle.sessionId === parentSessionId) throw new Error("An agent cannot synchronously prompt or wait on itself");
    const onAbort = () => { void this.agentAbort(handle.sessionId); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const snapshot = await this.agentPrompt(handle.sessionId, input.text, input.delivery);
      const result = { handleId: input.handleId, streaming: snapshot.streaming, parts: snapshot.parts };
      return jsonValueSchema.parse(snapshot.usage ? { ...result, usage: snapshot.usage } : result);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async waitSubagent(handleId: string, parentSessionId: string, signal: AbortSignal) {
    const handle = this.subagentHandle(handleId, parentSessionId);
    if (handle.sessionId === parentSessionId) throw new Error("An agent cannot synchronously wait on itself");
    if (handle.task) {
      await this.waitForSubagentTask(handle, signal);
      if (handle.error) throw new Error(handle.error);
    }
    let snapshot = await this.agentSnapshot(handle.sessionId);
    if (snapshot.streaming) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => finish(new Error("Timed out waiting for the subagent")), 5 * 60_000);
        const unsubscribe = this.subscribeAgent(handle.sessionId, (event) => {
          if (event.type === "streaming" && !event.streaming) finish();
        });
        const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("Subagent wait aborted"));
        const finish = (error?: Error) => {
          clearTimeout(timeout);
          unsubscribe();
          signal.removeEventListener("abort", onAbort);
          if (error) reject(error); else resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      snapshot = await this.agentSnapshot(handle.sessionId);
    }
    const result = { handleId, streaming: snapshot.streaming, parts: snapshot.parts };
    return jsonValueSchema.parse(snapshot.usage ? { ...result, usage: snapshot.usage } : result);
  }

  private async waitForSubagentTask(handle: SubagentHandle, signal: AbortSignal) {
    const task = handle.task;
    if (!task) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error("Timed out waiting for the subagent")), 5 * 60_000);
      const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("Subagent wait aborted"));
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        if (error) reject(error); else resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      else void task.then(() => finish());
    });
  }

  private async abortSubagent(handleId: string, parentSessionId: string) {
    const handle = this.subagentHandle(handleId, parentSessionId);
    const snapshot = await this.agentAbort(handle.sessionId);
    return jsonValueSchema.parse({ handleId, streaming: snapshot.streaming });
  }

  private async closeSubagent(handleId: string, parentSessionId: string) {
    const handle = this.subagentHandle(handleId, parentSessionId);
    this.subagentHandles.delete(handleId);
    if (handle.releaseRuntime) this.releaseAgent(handle.sessionId);
    return jsonValueSchema.parse({ handleId, closed: true });
  }

  private subagentHandle(handleId: string, parentSessionId: string) {
    const handle = this.subagentHandles.get(handleId);
    if (!handle || handle.parentSessionId !== parentSessionId) throw new Error("That subagent handle does not belong to this parent session");
    return handle;
  }

  private async inspectChanges(command: Extract<PiWorkspaceCommand, { type: "inspect-changes" }>) {
    const runtime = this.runtimeFor(command.sessionId);
    try {
      if (command.source === "working-tree") {
        const files = await this.collectWorkingChanges(this.workspacePath);
        this.emit({ type: "changes-snapshot", requestId: command.requestId, workspacePath: this.workspacePath, sessionId: command.sessionId, source: command.source, turns: [], files });
        return;
      }
      const initial = await runtime.ensureInitialGitCheckpoint?.();
      await runtime.waitForGitCheckpoints?.();
      if (!initial) throw new Error("Git checkpoints are unavailable for this session");
      const projections = await Promise.all((runtime.gitChangeTurns?.() ?? []).map(async (turn) => {
        const totals = await this.summarizeCheckpointChanges(this.workspacePath, turn.beforeTree, turn.afterTree);
        const summary: ChangeTurn = {
          id: turn.id,
          label: turn.label,
          capturedAt: turn.capturedAt,
          ...totals
        };
        return { summary, turn };
      }));
      projections.reverse();
      const selected = projections.find(({ summary }) => summary.id === command.turnId) ?? projections[0];
      const files = selected ? await this.collectCheckpointChanges(this.workspacePath, selected.turn.beforeTree, selected.turn.afterTree) : [];
      this.emit({
        type: "changes-snapshot",
        requestId: command.requestId,
        workspacePath: this.workspacePath,
        sessionId: command.sessionId,
        source: command.source,
        selectedTurnId: selected?.summary.id,
        turns: projections.map(({ summary }) => summary),
        files
      });
    } catch (error) {
      if (!(error instanceof NotGitRepositoryError)) throw error;
      this.emit({ type: "changes-snapshot", requestId: command.requestId, workspacePath: this.workspacePath, sessionId: command.sessionId, source: command.source, turns: [], files: [] });
    }
  }

  private async runReviewThread(command: Extract<PiWorkspaceCommand, { type: "submit-review-thread" }>) {
    const parentRuntime = this.runtimeFor(command.sessionId);
    await this.reviewRecovery;
    const runId = crypto.randomUUID();
    const thread = await this.reviewRepository.claimPending(this.workspacePath, command.sessionId, command.threadId, runId);
    if (!thread) return;
    const controller = new AbortController();
    let persistedFailure: string | undefined;
    this.activeReviewRuns.set(runId, controller);
    this.emit({ type: "review-thread-streaming", workspacePath: this.workspacePath, sessionId: command.sessionId, threadId: command.threadId, streaming: true });
    try {
      const agent = await this.runReviewTurnImpl({
        cwd: this.workspacePath,
        agentDir: this.agentDir,
        trusted: this.trusted,
        thread,
        sessionDir: this.reviewRepository.agentSessionDirectory(this.workspacePath, command.sessionId, command.threadId),
        parentSessionRoot: this.sessionDir,
        signal: controller.signal,
        model: command.model,
        thinkingLevel: command.thinkingLevel,
        parent: parentRuntime.getReviewParentContext?.(),
        onEvent: (event) => this.emit(event.type === "part-updated"
          ? { type: "review-thread-part-updated", workspacePath: this.workspacePath, sessionId: command.sessionId, threadId: command.threadId, part: event.part }
          : { type: "review-thread-usage-updated", workspacePath: this.workspacePath, sessionId: command.sessionId, threadId: command.threadId, usage: event.usage })
      });
      const updated = agent.error
        ? await this.reviewRepository.failRun(this.workspacePath, command.sessionId, command.threadId, runId, agent.error)
        : await this.reviewRepository.completeRun(this.workspacePath, command.sessionId, command.threadId, runId, agent);
      if (updated) this.emit({ type: "review-thread-updated", thread: updated });
      if (agent.error) {
        persistedFailure = agent.error;
        throw new Error(agent.error);
      }
    } catch (error) {
      const message = errorMessage(error);
      if (message !== persistedFailure) {
        const updated = await this.reviewRepository.failRun(this.workspacePath, command.sessionId, command.threadId, runId, message);
        if (updated) this.emit({ type: "review-thread-updated", thread: updated });
      }
      throw error;
    } finally {
      this.activeReviewRuns.delete(runId);
      this.emit({ type: "review-thread-streaming", workspacePath: this.workspacePath, sessionId: command.sessionId, threadId: command.threadId, streaming: false });
    }
  }
}

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, REVIEW_TEXT_MAX_LENGTH);
}
