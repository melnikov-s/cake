import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCommandSchema, type AgentEvent } from "../ipc/agent-ipc";
import { createFoundationRuntime, type FoundationRuntime } from "./pi-runtime";

interface PendingConfirmation {
  requestId: string;
  resolve(accepted: boolean): void;
}

let runtime: FoundationRuntime | undefined;
let activeRequestId: string | undefined;
const pendingConfirmations = new Map<string, PendingConfirmation>();

function emit(event: AgentEvent) {
  process.parentPort?.postMessage(event);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function requestConfirm(title: string, message: string, signal?: AbortSignal) {
  const requestId = activeRequestId;
  if (!requestId) throw new Error("Pi requested UI without an active Cake operation");

  const uiRequestId = crypto.randomUUID();
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      pendingConfirmations.delete(uiRequestId);
      signal?.removeEventListener("abort", onAbort);
      resolve(accepted);
    };
    const onAbort = () => settle(false);
    pendingConfirmations.set(uiRequestId, { requestId, resolve: settle });
    signal?.addEventListener("abort", onAbort, { once: true });
    emit({ type: "ui-request", requestId, uiRequestId, kind: "confirm", title, message });
  });
}

async function getRuntime() {
  runtime ??= await createFoundationRuntime({
    cwd: process.cwd(),
    agentDir: join(tmpdir(), "cake-s0-agent"),
    requestConfirm,
    onEvent(event) {
      if (event.type === "text-delta" && activeRequestId) {
        emit({ type: "text-delta", requestId: activeRequestId, text: event.text });
      }
    }
  });
  return runtime;
}

async function run(requestId: string) {
  if (activeRequestId) {
    emit({ type: "fatal", requestId, message: "A Pi foundation operation is already running" });
    return;
  }

  activeRequestId = requestId;
  try {
    const currentRuntime = await getRuntime();
    await currentRuntime.run();
    emit({ type: "complete", requestId });
  } catch (error) {
    emit({ type: "fatal", requestId, message: errorMessage(error) });
  } finally {
    for (const [uiRequestId, confirmation] of pendingConfirmations) {
      if (confirmation.requestId === requestId) confirmation.resolve(false);
      pendingConfirmations.delete(uiRequestId);
    }
    activeRequestId = undefined;
  }
}

process.parentPort?.on("message", (event) => {
  const result = agentCommandSchema.safeParse(event.data);
  if (!result.success) return;
  const command = result.data;

  if (command.type === "shutdown") {
    for (const confirmation of pendingConfirmations.values()) confirmation.resolve(false);
    runtime?.dispose();
    process.exit(0);
  }

  if (command.type === "ui-response") {
    const confirmation = pendingConfirmations.get(command.uiRequestId);
    if (confirmation?.requestId === command.requestId) confirmation.resolve(command.accepted);
    return;
  }

  void run(command.requestId);
});

emit({ type: "ready" });
