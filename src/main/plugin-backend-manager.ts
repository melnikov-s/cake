import { Option, Schema } from "effect";
import { utilityProcess, type UtilityProcess } from "electron";
import type { JsonValue } from "../ipc/json-contract";
import { pluginBackendHostMessageSchema } from "../plugin/backend-protocol";
import type { PluginBuildService } from "./plugin-build-service";

interface RunningBackend {
  pluginId: string;
  process: UtilityProcess;
  stopping: boolean;
}

interface PendingCall {
  pluginId: string;
  resolve(value: JsonValue): void;
  reject(error: Error): void;
}

export class PluginBackendManager {
  private readonly running = new Map<string, RunningBackend>();
  private readonly pending = new Map<string, PendingCall>();
  private revision?: string;

  constructor(
    private readonly builder: PluginBuildService,
    private readonly hostPath: string,
    private readonly emit: (event: {
      type: "plugin-backend-event";
      pluginId: string;
      name: string;
      value: JsonValue;
    }) => void,
    private readonly failed: (pluginId: string, message: string) => void,
  ) {}

  async activate(revision?: string) {
    if (this.revision === revision) return;
    await this.stop();
    if (!revision) return;
    const entries = await this.builder.backendEntries(revision);
    try {
      await Promise.all(entries.map((entry) => this.start(entry.pluginId, entry.path)));
      this.revision = revision;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  call(pluginId: string, callId: string, method: string, input: JsonValue) {
    const backend = this.running.get(pluginId);
    if (!backend) return Promise.reject(new Error(`Plugin ${pluginId} has no active backend`));
    if (this.pending.has(callId))
      return Promise.reject(new Error(`Plugin backend call ${callId} is already active`));
    return new Promise<JsonValue>((resolve, reject) => {
      this.pending.set(callId, { pluginId, resolve, reject });
      backend.process.postMessage({ type: "call", callId, method, input });
    });
  }

  cancel(pluginId: string, callId: string) {
    const pending = this.pending.get(callId);
    if (!pending || pending.pluginId !== pluginId) return;
    this.running.get(pluginId)?.process.postMessage({ type: "cancel", callId });
    pending.reject(new Error("Plugin backend call was cancelled"));
    this.pending.delete(callId);
  }

  async stop() {
    this.revision = undefined;
    for (const pending of this.pending.values())
      pending.reject(new Error("Plugin backend was stopped"));
    this.pending.clear();
    const running = [...this.running.values()];
    this.running.clear();
    for (const backend of running) {
      backend.stopping = true;
      backend.process.postMessage({ type: "dispose" });
      setTimeout(() => backend.process.kill(), 1_000).unref();
    }
  }

  private start(pluginId: string, backendPath: string) {
    return new Promise<void>((resolve, reject) => {
      const child = utilityProcess.fork(this.hostPath, [], {
        cwd: this.builder.paths.plugins,
        env: process.env,
        serviceName: `Cake Plugin: ${pluginId}`,
        stdio: "pipe",
      });
      const running: RunningBackend = { pluginId, process: child, stopping: false };
      this.running.set(pluginId, running);
      let ready = false;
      const timeout = setTimeout(
        () => reject(new Error(`Plugin ${pluginId} backend did not start within 10 seconds`)),
        10_000,
      );
      child.on("spawn", () => child.postMessage({ type: "init", pluginId, backendPath }));
      child.on("message", (untrusted) => {
        const parsed = Schema.decodeUnknownOption(pluginBackendHostMessageSchema)(untrusted);
        if (Option.isNone(parsed)) return;
        const message = parsed.value;
        if (message.type === "ready") {
          ready = true;
          clearTimeout(timeout);
          resolve();
        } else if (message.type === "event") {
          this.emit({
            type: "plugin-backend-event",
            pluginId,
            name: message.name,
            value: message.value,
          });
        } else if (message.type === "result") {
          const pending = this.pending.get(message.callId);
          if (!pending || pending.pluginId !== pluginId) return;
          this.pending.delete(message.callId);
          if (message.ok) pending.resolve(message.value);
          else pending.reject(new Error(message.error));
        } else {
          clearTimeout(timeout);
          if (!ready) reject(new Error(message.error));
          else this.failed(pluginId, message.error);
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        if (this.running.get(pluginId)?.process === child) this.running.delete(pluginId);
        for (const [callId, pending] of this.pending) {
          if (pending.pluginId !== pluginId) continue;
          pending.reject(new Error(`Plugin ${pluginId} backend exited with code ${code}`));
          this.pending.delete(callId);
        }
        if (!ready)
          reject(
            new Error(`Plugin ${pluginId} backend exited with code ${code} before becoming ready`),
          );
        else if (!running.stopping)
          this.failed(pluginId, `Backend exited unexpectedly with code ${code}`);
      });
      child.stderr?.on("data", (chunk) =>
        console.error(`[plugin:${pluginId}] ${String(chunk).trimEnd()}`),
      );
      child.stdout?.on("data", (chunk) =>
        console.log(`[plugin:${pluginId}] ${String(chunk).trimEnd()}`),
      );
    });
  }

  [Symbol.dispose]() {
    void this.stop();
  }
}
