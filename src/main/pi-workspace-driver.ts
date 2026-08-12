import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCakeRuntime, inspectWorkspace, loadPiChangelog, type CakeRuntime, type RuntimeUiRequest } from "../agent/pi-runtime";
import type { DesktopEvent, DesktopRequest } from "../ipc/desktop-ipc";
import { parseArtifactInput, type ArtifactRecord, type CakeArtifactV1 } from "../ipc/artifact-contract";
import type { ArtifactRepository } from "./artifact-repository";

type ArtifactRepositoryPort = Pick<ArtifactRepository, "upsert" | "get" | "listSession" | "linkSession">;

type PiCommandType =
  | "inspect-workspace"
  | "open-workspace"
  | "rename-session"
  | "fork-session"
  | "navigate-session"
  | "refresh-session"
  | "inspect-changes"
  | "get-changelog"
  | "prompt"
  | "abort"
  | "set-model"
  | "set-thinking"
  | "set-pi-setting"
  | "login"
  | "logout"
  | "respond-ui"
  | "respond-artifact";

export type PiWorkspaceCommand = Extract<DesktopRequest, { type: PiCommandType }>;

interface PendingUi {
  operationId: string;
  settle(value: string | undefined): void;
}

interface PendingArtifact {
  operationId: string;
  settle(value: unknown | undefined): void;
}

export interface PiWorkspaceDriverOptions {
  workspacePath: string;
  emit(event: DesktopEvent): void;
  createRuntime?: typeof createCakeRuntime;
  artifactRepository?: ArtifactRepositoryPort;
  openExternal?: (url: string) => Promise<void>;
}

const execFileAsync = promisify(execFile);

export class PiWorkspaceDriver {
  readonly workspacePath: string;
  private readonly emitEvent: PiWorkspaceDriverOptions["emit"];
  private readonly createRuntimeImpl: typeof createCakeRuntime;
  private readonly artifactRepository: ArtifactRepositoryPort;
  private readonly openExternal: NonNullable<PiWorkspaceDriverOptions["openExternal"]> | undefined;
  private readonly runtimes = new Map<string, CakeRuntime>();
  private readonly pendingUi = new Map<string, PendingUi>();
  private readonly pendingArtifacts = new Map<string, PendingArtifact>();
  private readonly operationContext = new AsyncLocalStorage<{ operationId: string; sessionId?: string }>();
  private trusted = false;
  private disposed = false;

  constructor(options: PiWorkspaceDriverOptions) {
    this.workspacePath = options.workspacePath;
    this.emitEvent = options.emit;
    this.createRuntimeImpl = options.createRuntime ?? createCakeRuntime;
    this.openExternal = options.openExternal;
    this.artifactRepository = options.artifactRepository ?? {
      async upsert(workspacePath, artifact) {
        const now = new Date().toISOString();
        return { artifact: parseArtifactInput(artifact), workspacePath, digest: "0".repeat(64), createdAt: now, updatedAt: now };
      },
      async listSession() { return []; }
      ,async get() { return undefined; }
      ,async linkSession() { return undefined; }
    };
  }

  dispatch(command: PiWorkspaceCommand) {
    if (this.disposed) throw new Error("The Pi workspace driver has been disposed");
    const routedPath = command.type === "inspect-workspace" || command.type === "open-workspace"
      ? command.path
      : command.workspacePath;
    if (routedPath !== this.workspacePath) {
      throw new Error("Workspace driver routing mismatch");
    }
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
    if (command.type === "inspect-workspace") {
      const inspection = inspectWorkspace(command.path);
      this.emit({ type: "workspace-inspected", requestId: command.requestId, ...inspection });
      this.emit({ type: "complete", requestId: command.requestId });
      return;
    }
    if (command.type === "open-workspace") {
      void this.run(command.requestId, async () => {
        this.trusted ||= command.trusted;
        const existing = command.sessionId ? this.runtimes.get(command.sessionId) : undefined;
        const runtime = existing ?? await this.createRuntime(command.newSession, command.sessionId, command.sessionFile);
        this.emit({ type: "session-snapshot", requestId: command.requestId, snapshot: await runtime.snapshot(command.requestId) });
      });
      return;
    }
    if (command.type === "inspect-changes") {
      void this.run(command.requestId, () => this.inspectChanges(command.requestId));
      return;
    }
    if (command.type === "get-changelog") {
      void this.run(command.requestId, async () => {
        this.runtimeFor(command.sessionId);
        this.emit({ type: "changelog-snapshot", requestId: command.requestId, workspacePath: this.workspacePath, sessionId: command.sessionId, markdown: loadPiChangelog() });
      }, command.sessionId);
      return;
    }
    if (command.type === "refresh-session") {
      void this.run(command.requestId, async () => {
        const runtime = this.runtimeFor(command.sessionId);
        this.emit({ type: "session-snapshot", snapshot: await runtime.snapshot() });
      }, command.sessionId);
      return;
    }
    void this.run(command.requestId, async () => {
      const runtime = command.type === "rename-session"
        ? this.runtimes.get(command.sessionId) ?? await this.createRuntime(false, command.sessionId)
        : this.runtimeFor(command.sessionId);
      if (command.type === "abort") await runtime.abort();
      else if (command.type === "prompt") {
        await runtime.prompt(command.text, command.delivery, command.attachments);
        this.emit({ type: "session-snapshot", snapshot: await runtime.snapshot() });
      }
      else if (command.type === "set-model") await runtime.setModel(command.provider, command.modelId);
      else if (command.type === "set-thinking") await runtime.setThinkingLevel(command.level);
      else if (command.type === "set-pi-setting") await runtime.setPiSetting(command.update);
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
    for (const pending of this.pendingUi.values()) pending.settle(undefined);
    this.pendingUi.clear();
    this.cancelPendingRequests();
    for (const runtime of this.runtimes.values()) runtime.dispose();
    this.runtimes.clear();
  }

  cancelPendingRequests() {
    for (const pending of this.pendingArtifacts.values()) pending.settle(undefined);
    this.pendingArtifacts.clear();
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
    const record = await this.artifactRepository.upsert(this.workspacePath, artifact);
    const activeSessionId = this.operationContext.getStore()?.sessionId;
    if (activeSessionId && activeSessionId !== artifact.sessionId) await this.artifactRepository.linkSession(record, activeSessionId);
    this.emit({ type: "artifact-updated", record });
    return record;
  }

  private requestArtifact(record: ArtifactRecord, signal: AbortSignal) {
    const operationId = this.operationContext.getStore()?.operationId;
    if (!operationId) throw new Error("Pi requested an artifact response without an active Cake operation");
    const artifactRequestId = crypto.randomUUID();
    return new Promise<unknown | undefined>((resolve) => {
      let settled = false;
      const settle = (value: unknown | undefined) => {
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

  private async createRuntime(newSession: boolean, sessionId?: string, sessionFile?: string) {
    const requestedArtifactSessionId = sessionId;
    let openedSessionId = sessionId;
    const runtimeRef: { current?: CakeRuntime } = {};
    const runtime = await this.createRuntimeImpl({
      cwd: this.workspacePath,
      trusted: this.trusted,
      newSession,
      sessionId,
      sessionFile,
      requestUi: (request) => this.requestUi(request),
      persistArtifact: (artifact) => this.persistArtifact(artifact),
      requestArtifact: (record, signal) => this.requestArtifact(record, signal),
      openExternal: this.openExternal,
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
        if (event.type === "snapshot") this.emit({ type: "session-snapshot", requestId: event.requestId, snapshot: event.snapshot });
        else if (event.type === "part-updated" || event.type === "part-removed" || event.type === "extension-ui") {
          this.emit(event);
          if (event.type === "part-updated" && event.part.kind === "text" && event.part.role === "user" && event.part.status === "complete") {
            const activeRuntime = runtimeRef.current;
            if (activeRuntime) void activeRuntime.snapshot().then((snapshot) => this.emit({ type: "session-snapshot", snapshot }));
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
    return runtime;
  }

  private async inspectChanges(requestId: string) {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z"], { cwd: this.workspacePath, maxBuffer: 4_000_000 });
    const records = stdout.split("\0").filter(Boolean);
    const files = [];
    for (let index = 0; index < records.length; index++) {
      const record = records[index]!;
      const status = record.slice(0, 2);
      let path = record.slice(3);
      if ((status[0] === "R" || status[0] === "C") && records[index + 1]) path = records[++index]!;
      const staged = status[0] !== " " && status[0] !== "?";
      let diff: string;
      try {
        diff = (await execFileAsync("git", ["diff", "--no-ext-diff", ...(staged ? ["--cached"] : []), "--", path], { cwd: this.workspacePath, maxBuffer: 1_000_000 })).stdout;
      } catch (error) {
        diff = typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout) : "";
      }
      const lines = diff.split("\n");
      files.push({
        path,
        status,
        staged,
        additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
        deletions: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
        diff: diff.slice(0, 262_144)
      });
    }
    this.emit({ type: "changes-snapshot", requestId, workspacePath: this.workspacePath, files });
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
