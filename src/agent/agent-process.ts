import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as pty from "node-pty";
import { agentCommandSchema, type AgentEvent } from "../ipc/agent-ipc";
import { createCakeRuntime, inspectWorkspace, type CakeRuntime, type RuntimeUiRequest } from "./pi-runtime";

interface PendingUi { requestId: string; settle(value: string | undefined): void }
const runtimes = new Map<string, CakeRuntime>();
const pendingUi = new Map<string, PendingUi>();
const terminals = new Map<string, pty.IPty>();
const operationContext = new AsyncLocalStorage<string>();
const workspacePath = process.env.CAKE_WORKSPACE_PATH ?? "";
const execFileAsync = promisify(execFile);
let workspaceTrusted = false;

function emit(event: AgentEvent) { process.parentPort?.postMessage(event); }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }

function requestUi(request: RuntimeUiRequest) {
  const requestId = operationContext.getStore();
  if (!requestId) throw new Error("Pi requested UI without an active Cake operation");
  const uiRequestId = crypto.randomUUID();
  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    const settle = (value: string | undefined) => {
      if (settled) return;
      settled = true; pendingUi.delete(uiRequestId); request.signal?.removeEventListener("abort", onAbort); resolve(value);
    };
    const onAbort = () => settle(undefined);
    pendingUi.set(uiRequestId, { requestId, settle });
    request.signal?.addEventListener("abort", onAbort, { once: true });
    emit({ type: "ui-request", requestId, uiRequestId, kind: request.kind, title: request.title, message: request.message, placeholder: request.placeholder, options: request.options });
  });
}

async function run(requestId: string, operation: () => Promise<void>) {
  try { await operationContext.run(requestId, operation); emit({ type: "complete", requestId }); }
  catch (error) { emit({ type: "fatal", requestId, message: errorMessage(error) }); }
  finally {
    for (const pending of pendingUi.values()) if (pending.requestId === requestId) pending.settle(undefined);
  }
}

function runtimeFor(sessionId: string) {
  const runtime = runtimes.get(sessionId);
  if (!runtime) throw new Error("That session is not open in this workspace process");
  return runtime;
}

async function createRuntime(newSession: boolean, sessionId: string | undefined, sessionFile?: string) {
  const candidate: CakeRuntime = await createCakeRuntime({
    cwd: workspacePath, trusted: workspaceTrusted, newSession, sessionId, sessionFile, requestUi,
    onEvent(runtimeEvent) {
      if (runtimeEvent.type === "snapshot") emit({ type: "session-snapshot", requestId: runtimeEvent.requestId, snapshot: runtimeEvent.snapshot });
      if (runtimeEvent.type === "part-updated" || runtimeEvent.type === "part-removed") emit(runtimeEvent);
      if (runtimeEvent.type === "streaming") emit({ type: "session-streaming", sessionId: runtimeEvent.sessionId, streaming: runtimeEvent.streaming });
    }
  });
  runtimes.set(candidate.sessionId, candidate);
  return candidate;
}

async function inspectChanges(requestId: string) {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z"], { cwd: workspacePath, maxBuffer: 4_000_000 });
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
      const result = await execFileAsync("git", ["diff", "--no-ext-diff", ...(staged ? ["--cached"] : []), "--", path], { cwd: workspacePath, maxBuffer: 1_000_000 });
      diff = result.stdout;
    } catch (error) {
      diff = typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout) : "";
    }
    const lines = diff.split("\n");
    files.push({ path, status, staged, additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length, deletions: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length, diff: diff.slice(0, 262_144) });
  }
  emit({ type: "changes-snapshot", requestId, workspacePath, files });
}

process.parentPort?.on("message", (event) => {
  const result = agentCommandSchema.safeParse(event.data);
  if (!result.success) return;
  const command = result.data;
  if (command.type === "shutdown") {
    for (const pending of pendingUi.values()) pending.settle(undefined);
    for (const terminal of terminals.values()) terminal.kill();
    for (const runtime of runtimes.values()) runtime.dispose();
    process.exit(0);
  }
  if (command.type !== "inspect-workspace" && "workspacePath" in command && command.workspacePath !== workspacePath) return;
  if (command.type === "ui-response") {
    const pending = pendingUi.get(command.uiRequestId);
    if (pending?.requestId === command.requestId) pending.settle(command.cancelled ? undefined : command.value);
    return;
  }
  if (command.type === "inspect-workspace") {
    const inspection = inspectWorkspace(command.path);
    emit({ type: "workspace-inspected", requestId: command.requestId, ...inspection }); emit({ type: "complete", requestId: command.requestId }); return;
  }
  if (command.type === "open-workspace") {
    void run(command.requestId, async () => {
      if (command.path !== workspacePath) throw new Error("Workspace process routing mismatch");
      workspaceTrusted = workspaceTrusted || command.trusted;
      const existing = command.sessionId ? runtimes.get(command.sessionId) : undefined;
      const runtime = existing ?? await createRuntime(command.newSession, command.sessionId, command.sessionFile);
      emit({ type: "session-snapshot", requestId: command.requestId, snapshot: await runtime.snapshot(command.requestId) });
    }); return;
  }
  if (command.type === "inspect-changes") { void run(command.requestId, () => inspectChanges(command.requestId)); return; }
  if (command.type === "terminal-start") {
    void run(command.requestId, async () => {
      terminals.get(command.terminalId)?.kill();
      const terminal = pty.spawn(process.env.SHELL || "/bin/sh", [], { name: "xterm-256color", cols: command.cols, rows: command.rows, cwd: workspacePath, env: { ...process.env, TERM: "xterm-256color" } as Record<string, string> });
      terminals.set(command.terminalId, terminal);
      terminal.onData((data) => { for (let offset = 0; offset < data.length; offset += 262_144) emit({ type: "terminal-output", workspacePath, terminalId: command.terminalId, data: data.slice(offset, offset + 262_144) }); });
      terminal.onExit(({ exitCode }) => { terminals.delete(command.terminalId); emit({ type: "terminal-exited", workspacePath, terminalId: command.terminalId, exitCode }); });
    }); return;
  }
  if (command.type === "terminal-input") { terminals.get(command.terminalId)?.write(command.data); emit({ type: "complete", requestId: command.requestId }); return; }
  if (command.type === "terminal-resize") { terminals.get(command.terminalId)?.resize(command.cols, command.rows); emit({ type: "complete", requestId: command.requestId }); return; }
  if (command.type === "terminal-close") { terminals.get(command.terminalId)?.kill(); terminals.delete(command.terminalId); emit({ type: "complete", requestId: command.requestId }); return; }
  void run(command.requestId, async () => {
    const runtime = runtimeFor(command.sessionId);
    if (command.type === "abort") await runtime.abort();
    else if (command.type === "prompt") await runtime.prompt(command.text, command.delivery, command.attachments);
    else if (command.type === "set-model") await runtime.setModel(command.provider, command.modelId);
    else if (command.type === "set-thinking") await runtime.setThinkingLevel(command.level);
    else if (command.type === "login") await runtime.login(command.provider, command.authType);
    else if (command.type === "logout") await runtime.logout(command.provider);
    else if (command.type === "rename-session") await runtime.rename(command.name);
    else if (command.type === "navigate-session") await runtime.navigate(command.entryId);
    else if (command.type === "fork-session") {
      const forked = await runtime.fork(command.entryId);
      const next = await createRuntime(false, forked.sessionId);
      emit({ type: "session-snapshot", requestId: command.requestId, snapshot: await next.snapshot(command.requestId) });
    }
  });
});

emit({ type: "ready" });
