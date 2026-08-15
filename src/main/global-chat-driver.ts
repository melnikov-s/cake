import { homedir } from "node:os";
import { createCakeRuntime, type CakeRuntime, type CakeRuntimeEvent, type GlobalControlTool } from "../agent/pi-runtime";
import type { DesktopEvent } from "../ipc/desktop-ipc";

interface PendingControlRequest {
  settle(result: unknown): void;
}

export interface GlobalChatDriverOptions {
  agentDir: string;
  sessionDir: string;
  emit(event: DesktopEvent): void;
  createRuntime?: typeof createCakeRuntime;
}

/** Owns Cake's one persistent, application-level Pi conversation. */
export class GlobalChatDriver {
  private runtime: CakeRuntime | undefined;
  private runtimePromise: Promise<CakeRuntime> | undefined;
  private tools: readonly GlobalControlTool[] = [];
  private readonly pendingControl = new Map<string, PendingControlRequest>();
  private readonly createRuntime: typeof createCakeRuntime;
  private disposed = false;
  private streaming = false;

  constructor(private readonly options: GlobalChatDriverOptions) {
    this.createRuntime = options.createRuntime ?? createCakeRuntime;
  }

  open(requestId: string, tools: readonly GlobalControlTool[]) {
    this.tools = tools;
    void this.run(requestId, async () => {
      const runtime = await this.ensureRuntime(false);
      this.emitSnapshot(await runtime.snapshot(requestId), requestId);
    });
  }

  prompt(requestId: string, text: string) {
    void this.run(requestId, async () => {
      const runtime = await this.ensureRuntime(false);
      await runtime.prompt(text, this.streaming ? "follow-up" : "prompt", []);
    });
  }

  abort(requestId: string) {
    void this.run(requestId, async () => this.runtime?.abort());
  }

  clear(requestId: string, tools: readonly GlobalControlTool[]) {
    this.tools = tools;
    void this.run(requestId, async () => {
      this.disposeRuntime();
      const runtime = await this.ensureRuntime(true);
      this.emitSnapshot(await runtime.snapshot(requestId), requestId);
    });
  }

  setModel(requestId: string, provider: string, modelId: string) {
    void this.run(requestId, async () => {
      const runtime = await this.ensureRuntime(false);
      await runtime.setModel(provider, modelId);
    });
  }

  setThinkingLevel(requestId: string, level: Parameters<CakeRuntime["setThinkingLevel"]>[0]) {
    void this.run(requestId, async () => {
      const runtime = await this.ensureRuntime(false);
      await runtime.setThinkingLevel(level);
    });
  }

  respond(controlRequestId: string, result: unknown) {
    this.pendingControl.get(controlRequestId)?.settle(result);
  }

  [Symbol.dispose]() {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeRuntime();
  }

  private async ensureRuntime(newSession: boolean) {
    if (this.disposed) throw new Error("The global chat has been disposed");
    if (this.runtime) return this.runtime;
    if (this.runtimePromise) return this.runtimePromise;
    this.runtimePromise = this.createRuntime({
      cwd: homedir(),
      agentDir: this.options.agentDir,
      trusted: false,
      sessionDir: this.options.sessionDir,
      newSession,
      requestUi: async () => undefined,
      globalControl: {
        tools: this.tools,
        invoke: (invocation, signal) => this.requestControl(invocation, signal)
      },
      onEvent: (event) => this.receive(event)
    });
    try {
      this.runtime = await this.runtimePromise;
      return this.runtime;
    } finally {
      this.runtimePromise = undefined;
    }
  }

  private requestControl(invocation: { name: string; arguments: unknown }, signal: AbortSignal) {
    return new Promise<unknown>((resolve) => {
      const controlRequestId = crypto.randomUUID();
      const settle = (result: unknown) => {
        this.pendingControl.delete(controlRequestId);
        signal.removeEventListener("abort", abort);
        resolve(result);
      };
      const abort = () => settle({ ok: false, name: invocation.name, error: "The global-chat request was cancelled." });
      this.pendingControl.set(controlRequestId, { settle });
      signal.addEventListener("abort", abort, { once: true });
      this.options.emit({ type: "global-chat-control-request", controlRequestId, invocation });
    });
  }

  private receive(event: CakeRuntimeEvent) {
    if (event.type === "snapshot") this.emitSnapshot(event.snapshot, event.requestId);
    else if (event.type === "part-updated") this.options.emit({ type: "global-chat-part-updated", part: event.part });
    else if (event.type === "part-removed") this.options.emit({ type: "global-chat-part-removed", partId: event.partId });
    else if (event.type === "streaming") {
      this.streaming = event.streaming;
      this.options.emit({ type: "global-chat-streaming", streaming: event.streaming });
    }
  }

  private emitSnapshot(snapshot: Awaited<ReturnType<CakeRuntime["snapshot"]>>, requestId?: string) {
    this.options.emit({
      type: "global-chat-snapshot",
      ...(requestId ? { requestId } : {}),
      snapshot
    });
  }

  private async run(requestId: string, operation: () => Promise<void>) {
    try {
      await operation();
      this.options.emit({ type: "global-chat-operation-completed", requestId });
    } catch (error) {
      this.options.emit({ type: "global-chat-operation-failed", requestId, message: error instanceof Error ? error.message : String(error) });
    }
  }

  private disposeRuntime() {
    this.runtime?.dispose();
    this.runtime = undefined;
    this.streaming = false;
    for (const pending of this.pendingControl.values()) pending.settle({ ok: false, error: "The global chat was reset." });
    this.pendingControl.clear();
  }
}
