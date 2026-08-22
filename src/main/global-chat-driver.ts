import { homedir } from "node:os";
import {
  createCakeRuntime,
  type CakeRuntime,
  type CakeRuntimeEvent,
  type GlobalControlTool,
} from "../agent/cake-runtime";
import type { DesktopEvent } from "../ipc/desktop-ipc";
import type { JsonValue } from "../ipc/json-contract";
import type { Attachment } from "../ipc/session-contract";

interface PendingControlRequest {
  sessionId: string;
  settle(result: JsonValue): void;
}

interface RuntimeIdentity {
  sessionId?: string;
}

export interface GlobalChatDriverOptions {
  agentDir: string;
  sessionDir: string;
  emit(event: DesktopEvent): void;
  recoveryContext?(): string | undefined;
  fastMode?(sessionId: string): boolean;
  setFastMode?(sessionId: string, enabled: boolean): Promise<void>;
  createRuntime?: typeof createCakeRuntime;
}

/** Owns the active runtime for Cake's persistent application-level conversations. */
export class GlobalChatDriver {
  private readonly runtimes = new Map<string, CakeRuntime>();
  private readonly runtimePromises = new Map<string, Promise<CakeRuntime>>();
  private tools: readonly GlobalControlTool[] = [];
  private readonly pendingControl = new Map<string, PendingControlRequest>();
  private readonly createRuntime: typeof createCakeRuntime;
  private disposed = false;
  private readonly streamingSessionIds = new Set<string>();
  private readonly recoveryContextRefreshPending = new Set<string>();

  constructor(private readonly options: GlobalChatDriverOptions) {
    this.createRuntime = options.createRuntime ?? createCakeRuntime;
  }

  open(
    requestId: string,
    tools: readonly GlobalControlTool[],
    target: { newSession?: boolean; sessionId?: string; initialPrompt?: string } = {},
  ) {
    this.tools = tools;
    void this.run(requestId, async () => {
      const runtime = await this.ensureRuntime(Boolean(target.newSession), target.sessionId);
      if (target.initialPrompt) await runtime.prompt(target.initialPrompt, "prompt", []);
      this.emitSnapshot(await runtime.snapshot(requestId), requestId);
    });
  }

  prompt(requestId: string, sessionId: string, text: string, attachments: Attachment[]) {
    void this.run(requestId, async () => {
      const runtime = await this.ensureRuntime(false, sessionId);
      await runtime.prompt(
        text,
        this.streamingSessionIds.has(sessionId) ? "follow-up" : "prompt",
        attachments,
      );
    });
  }

  abort(requestId: string, sessionId: string) {
    void this.run(requestId, async () => this.runtimeFor(sessionId).abort());
  }

  compact(requestId: string, sessionId: string, instructions?: string) {
    void this.run(requestId, async () => {
      const runtime = await this.ensureRuntime(false, sessionId);
      await runtime.compact(instructions);
    });
  }

  setModel(requestId: string, sessionId: string, provider: string, modelId: string) {
    void this.run(requestId, async () => {
      const runtime = await this.ensureRuntime(false, sessionId);
      await runtime.setModel(provider, modelId);
    });
  }

  setThinkingLevel(
    requestId: string,
    sessionId: string,
    level: Parameters<CakeRuntime["setThinkingLevel"]>[0],
  ) {
    void this.run(requestId, async () => {
      const runtime = await this.ensureRuntime(false, sessionId);
      await runtime.setThinkingLevel(level);
    });
  }

  setFastMode(requestId: string, sessionId: string, enabled: boolean) {
    void this.run(requestId, async () => {
      const runtime = await this.ensureRuntime(false, sessionId);
      if (!runtime.setFastMode)
        throw new Error("This Cake Chat runtime does not support Fast mode");
      await runtime.setFastMode(enabled);
    });
  }

  respond(controlRequestId: string, result: JsonValue) {
    this.pendingControl.get(controlRequestId)?.settle(result);
  }

  refreshRecoveryContext() {
    for (const sessionId of this.runtimes.keys()) {
      if (this.streamingSessionIds.has(sessionId))
        this.recoveryContextRefreshPending.add(sessionId);
      else this.disposeRuntime(sessionId);
    }
  }

  [Symbol.dispose]() {
    if (this.disposed) return;
    this.disposed = true;
    for (const sessionId of this.runtimes.keys()) this.disposeRuntime(sessionId);
  }

  private async ensureRuntime(newSession: boolean, sessionId?: string) {
    if (this.disposed) throw new Error("Cake Chat has been disposed");
    if (sessionId) {
      const existing = this.runtimes.get(sessionId);
      if (existing) return existing;
      const pending = this.runtimePromises.get(sessionId);
      if (pending) return pending;
    }
    const pendingKey = sessionId ?? (newSession ? crypto.randomUUID() : "recent");
    const pending = this.runtimePromises.get(pendingKey);
    if (pending) return pending;
    const runtimeIdentity: RuntimeIdentity = {};
    const runtimePromise = this.createRuntime({
      cwd: homedir(),
      agentDir: this.options.agentDir,
      trusted: false,
      sessionDir: this.options.sessionDir,
      newSession,
      sessionId,
      // Cake Chat sessions have no rename workflow, so /name is not offered there.
      slashCommands: ["compact", "model"],
      requestUi: async () => undefined,
      fastMode: {
        get: () => {
          const targetSessionId = runtimeIdentity.sessionId ?? sessionId;
          return targetSessionId ? (this.options.fastMode?.(targetSessionId) ?? false) : false;
        },
        set: async (enabled) => {
          const targetSessionId = runtimeIdentity.sessionId ?? sessionId;
          if (!targetSessionId) throw new Error("The Cake Chat session is not ready for Fast mode");
          await this.options.setFastMode?.(targetSessionId, enabled);
        },
      },
      globalControl: {
        tools: this.tools,
        recoveryContext: this.options.recoveryContext?.(),
        invoke: (invocation, signal) =>
          this.requestControl(invocation, signal, () => runtimeIdentity.sessionId),
      },
      onEvent: (event) => this.receive(event),
    });
    this.runtimePromises.set(pendingKey, runtimePromise);
    try {
      const runtime = await runtimePromise;
      if (this.disposed) {
        runtime.dispose();
        throw new Error("Cake Chat has been disposed");
      }
      runtimeIdentity.sessionId = runtime.sessionId;
      if (runtime.syncFastMode) await runtime.syncFastMode();
      this.runtimes.set(runtime.sessionId, runtime);
      return runtime;
    } finally {
      this.runtimePromises.delete(pendingKey);
    }
  }

  private runtimeFor(sessionId: string) {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) throw new Error("That Cake Chat session is not open");
    return runtime;
  }

  private requestControl(
    invocation: { name: string; arguments: JsonValue },
    signal: AbortSignal,
    sessionId: () => string | undefined,
  ) {
    return new Promise<JsonValue>((resolve) => {
      const controlRequestId = crypto.randomUUID();
      const settle = (result: JsonValue) => {
        this.pendingControl.delete(controlRequestId);
        signal.removeEventListener("abort", abort);
        resolve(result);
      };
      const abort = () =>
        settle({ ok: false, name: invocation.name, error: "The Cake Chat request was cancelled." });
      this.pendingControl.set(controlRequestId, { sessionId: sessionId() ?? "unknown", settle });
      signal.addEventListener("abort", abort, { once: true });
      this.options.emit({ type: "global-chat-control-request", controlRequestId, invocation });
    });
  }

  private receive(event: CakeRuntimeEvent) {
    if (event.type === "snapshot") this.emitSnapshot(event.snapshot, event.requestId);
    else if (event.type === "part-updated")
      this.options.emit({
        type: "global-chat-part-updated",
        sessionId: event.sessionId,
        part: event.part,
      });
    else if (event.type === "part-removed")
      this.options.emit({
        type: "global-chat-part-removed",
        sessionId: event.sessionId,
        partId: event.partId,
      });
    else if (event.type === "streaming") {
      if (event.streaming) this.streamingSessionIds.add(event.sessionId);
      else this.streamingSessionIds.delete(event.sessionId);
      this.options.emit({
        type: "global-chat-streaming",
        sessionId: event.sessionId,
        streaming: event.streaming,
      });
      if (!event.streaming && this.recoveryContextRefreshPending.has(event.sessionId)) {
        this.recoveryContextRefreshPending.delete(event.sessionId);
        this.disposeRuntime(event.sessionId);
      }
    }
  }

  private emitSnapshot(snapshot: Awaited<ReturnType<CakeRuntime["snapshot"]>>, requestId?: string) {
    this.options.emit(
      requestId
        ? { type: "global-chat-snapshot", requestId, snapshot }
        : { type: "global-chat-snapshot", snapshot },
    );
  }

  private async run(requestId: string, operation: () => Promise<void>) {
    try {
      await operation();
      this.options.emit({ type: "global-chat-operation-completed", requestId });
    } catch (error) {
      this.options.emit({
        type: "global-chat-operation-failed",
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private disposeRuntime(sessionId: string) {
    this.runtimes.get(sessionId)?.dispose();
    this.runtimes.delete(sessionId);
    this.streamingSessionIds.delete(sessionId);
    this.recoveryContextRefreshPending.delete(sessionId);
    for (const [controlRequestId, pending] of this.pendingControl) {
      if (pending.sessionId !== sessionId) continue;
      pending.settle({ ok: false, error: "Cake Chat refreshed this session." });
      this.pendingControl.delete(controlRequestId);
    }
  }
}
