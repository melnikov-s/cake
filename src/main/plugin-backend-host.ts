import { pathToFileURL } from "node:url";
import { z } from "zod";
import { jsonValueSchema } from "../ipc/json-contract";
import type { CakePluginBackend, PluginBackendValue } from "../plugin/backend-api";
import { pluginBackendHostRequestSchema, type PluginBackendHostMessage } from "../plugin/backend-protocol";

const port = process.parentPort;
const active = new Map<string, AbortController>();
let backend: CakePluginBackend | undefined;
let pluginId: string | undefined;

function post(message: PluginBackendHostMessage) {
  port.postMessage(message);
}

const backendSchema = z.object({
  methods: z.record(z.string(), z.function()),
  start: z.function().optional(),
  dispose: z.function().optional()
});

function value(input: PluginBackendValue): PluginBackendValue {
  const serialized = JSON.stringify(input);
  if (serialized === undefined) throw new Error("Plugin backends must return JSON values");
  if (serialized.length > 2_000_000) throw new Error("Plugin backend values may not exceed 2 MB");
  return jsonValueSchema.parse(JSON.parse(serialized));
}

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 32_768);
}

async function dispose() {
  for (const controller of active.values()) controller.abort();
  active.clear();
  await backend?.dispose?.();
}

async function start(nextPluginId: string, backendPath: string) {
  pluginId = nextPluginId;
  const imported: { default?: unknown } = await import(pathToFileURL(backendPath).href);
  const parsed = backendSchema.safeParse(imported.default);
  if (!parsed.success) throw new Error(`Plugin ${pluginId} backend must default-export definePluginBackend({ methods: ... })`);
  // SAFETY: backendSchema established the callable methods and optional lifecycle function shape at this module boundary.
  backend = parsed.data as CakePluginBackend;
  const emit = (name: string, input: PluginBackendValue) => post({ type: "event", name, value: value(input) });
  await backend.start?.({ emit });
  post({ type: "ready", pluginId });
}

port.on("message", (event) => {
  const parsed = pluginBackendHostRequestSchema.safeParse(event.data);
  if (!parsed.success) return;
  const request = parsed.data;
  if (request.type === "init") {
    if (backend || pluginId) return;
    void start(request.pluginId, request.backendPath).catch((error) => {
      post({ type: "fatal", error: errorMessage(error) });
      process.exitCode = 1;
    });
    return;
  }
  if (request.type === "cancel") {
    active.get(request.callId)?.abort();
    return;
  }
  if (request.type === "dispose") {
    void dispose().finally(() => process.exit(0));
    return;
  }
  const method = backend?.methods[request.method];
  if (!method) {
    post({ type: "result", callId: request.callId, ok: false, error: `Plugin ${pluginId ?? "unknown"} has no backend method ${request.method}` });
    return;
  }
  const controller = new AbortController();
  active.set(request.callId, controller);
  const emit = (name: string, input: PluginBackendValue) => post({ type: "event", name, value: value(input) });
  void Promise.resolve(method(request.input, { signal: controller.signal, emit }))
    .then((result) => post({ type: "result", callId: request.callId, ok: true, value: value(result) }))
    .catch((error) => post({ type: "result", callId: request.callId, ok: false, error: errorMessage(error) }))
    .finally(() => active.delete(request.callId));
});
