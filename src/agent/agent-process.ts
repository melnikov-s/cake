import { AsyncLocalStorage } from "node:async_hooks";
import { agentCommandSchema, type AgentEvent } from "../ipc/agent-ipc";
import {
  createCakeRuntime,
  inspectWorkspace,
  type CakeRuntime,
  type RuntimeUiRequest
} from "./pi-runtime";

interface PendingUi {
  requestId: string;
  settle(value: string | undefined): void;
}

let runtime: CakeRuntime | undefined;
let workspaceRevision = 0;
const pendingUi = new Map<string, PendingUi>();
const operationContext = new AsyncLocalStorage<string>();

function emit(event: AgentEvent) {
  process.parentPort?.postMessage(event);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function requestUi(request: RuntimeUiRequest) {
  const requestId = operationContext.getStore();
  if (!requestId) throw new Error("Pi requested UI without an active Cake operation");
  const uiRequestId = crypto.randomUUID();
  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    const settle = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      pendingUi.delete(uiRequestId);
      request.signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => settle(undefined);
    pendingUi.set(uiRequestId, { requestId, settle });
    request.signal?.addEventListener("abort", onAbort, { once: true });
    emit({
      type: "ui-request",
      requestId,
      uiRequestId,
      kind: request.kind,
      title: request.title,
      message: request.message,
      placeholder: request.placeholder,
      options: request.options
    });
  });
}

async function run(requestId: string, operation: () => Promise<void>) {
  try {
    await operationContext.run(requestId, operation);
    emit({ type: "complete", requestId });
  } catch (error) {
    emit({ type: "fatal", requestId, message: errorMessage(error) });
  } finally {
    for (const [uiRequestId, pending] of pendingUi) {
      if (pending.requestId === requestId) pending.settle(undefined);
      pendingUi.delete(uiRequestId);
    }
  }
}

process.parentPort?.on("message", (event) => {
  const result = agentCommandSchema.safeParse(event.data);
  if (!result.success) return;
  const command = result.data;

  if (command.type === "shutdown") {
    for (const pending of pendingUi.values()) pending.settle(undefined);
    runtime?.dispose();
    process.exit(0);
  }

  if (command.type === "ui-response") {
    const pending = pendingUi.get(command.uiRequestId);
    if (pending?.requestId === command.requestId) pending.settle(command.cancelled ? undefined : command.value);
    return;
  }

  if (command.type === "inspect-workspace") {
    const inspection = inspectWorkspace(command.path);
    emit({ type: "workspace-inspected", requestId: command.requestId, ...inspection });
    emit({ type: "complete", requestId: command.requestId });
    return;
  }

  if (command.type === "abort") {
    void run(command.requestId, async () => runtime?.abort());
    return;
  }

  if (command.type === "open-workspace") {
    const revision = ++workspaceRevision;
    void run(command.requestId, async () => {
      runtime?.dispose();
      runtime = undefined;
      const candidate = await createCakeRuntime({
        cwd: command.path,
        trusted: command.trusted,
        newSession: command.newSession,
        sessionId: command.sessionId,
        requestUi,
        onEvent(runtimeEvent) {
          if (revision !== workspaceRevision) return;
          if (runtimeEvent.type === "snapshot") emit({ type: "session-snapshot", requestId: runtimeEvent.requestId, snapshot: runtimeEvent.snapshot });
          if (runtimeEvent.type === "part-updated") emit(runtimeEvent);
          if (runtimeEvent.type === "part-removed") emit(runtimeEvent);
          if (runtimeEvent.type === "streaming") emit({ type: "session-streaming", sessionId: runtimeEvent.sessionId, streaming: runtimeEvent.streaming });
        }
      });
      if (revision !== workspaceRevision) {
        candidate.dispose();
        return;
      }
      runtime = candidate;
      const snapshot = await candidate.snapshot(command.requestId);
      if (revision !== workspaceRevision) return;
      emit({ type: "session-snapshot", requestId: command.requestId, snapshot });
    });
    return;
  }

  if (!runtime) {
    emit({ type: "fatal", requestId: command.requestId, message: "Open a project before using the Pi session" });
    return;
  }

  if (command.type === "prompt") {
    void run(command.requestId, () => runtime!.prompt(command.text, command.delivery, command.attachments));
  } else if (command.type === "set-model") {
    void run(command.requestId, () => runtime!.setModel(command.provider, command.modelId));
  } else if (command.type === "set-thinking") {
    void run(command.requestId, () => runtime!.setThinkingLevel(command.level));
  } else if (command.type === "login") {
    void run(command.requestId, () => runtime!.login(command.provider, command.authType));
  } else if (command.type === "logout") {
    void run(command.requestId, () => runtime!.logout(command.provider));
  }
});

emit({ type: "ready" });
