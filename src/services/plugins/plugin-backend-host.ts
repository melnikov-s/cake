import { Option, Predicate, Schema } from "effect";
import { pathToFileURL } from "node:url";
import { jsonValueSchema } from "../../ipc/json-contract";
import type { CakePluginBackend, PluginBackendValue } from "../../plugin/backend-api";
import {
  pluginBackendHostRequestSchema,
  type PluginBackendHostMessage,
} from "../../plugin/backend-protocol";

const port = process.parentPort;
const active = new Map<string, AbortController>();
let backend: CakePluginBackend | undefined;
let pluginId: string | undefined;

function post(message: PluginBackendHostMessage) {
  port.postMessage(message);
}

function value(input: PluginBackendValue): PluginBackendValue {
  const serialized = JSON.stringify(input);
  if (serialized === undefined) throw new Error("Plugin backends must return JSON values");
  if (serialized.length > 2_000_000) throw new Error("Plugin backend values may not exceed 2 MB");
  return Schema.decodeUnknownSync(jsonValueSchema)(JSON.parse(serialized));
}

interface PluginBackendCandidate {
  readonly methods?: unknown;
  readonly start?: unknown;
  readonly dispose?: unknown;
}

function isCakePluginBackend(input: PluginBackendCandidate): input is CakePluginBackend {
  return (
    Predicate.isObject(input.methods) &&
    Object.values(input.methods).every(Predicate.isFunction) &&
    (input.start === undefined || Predicate.isFunction(input.start)) &&
    (input.dispose === undefined || Predicate.isFunction(input.dispose))
  );
}

function errorMessage(error: unknown) {
  return (error instanceof Error ? (error.stack ?? error.message) : String(error)).slice(0, 32_768);
}

async function dispose() {
  for (const controller of active.values()) controller.abort();
  active.clear();
  await backend?.dispose?.();
}

async function start(nextPluginId: string, backendPath: string) {
  pluginId = nextPluginId;
  const imported: { default?: unknown } = await import(pathToFileURL(backendPath).href);
  const candidate = imported.default;
  if (!Predicate.isObject(candidate))
    throw new Error(
      `Plugin ${pluginId} backend must default-export definePluginBackend({ methods: ... })`,
    );
  const backendCandidate: PluginBackendCandidate = {
    methods: candidate.methods,
    start: candidate.start,
    dispose: candidate.dispose,
  };
  if (!isCakePluginBackend(backendCandidate))
    throw new Error(
      `Plugin ${pluginId} backend must default-export definePluginBackend({ methods: ... })`,
    );
  backend = backendCandidate;
  const emit = (name: string, input: PluginBackendValue) =>
    post({ type: "event", name, value: value(input) });
  await backend.start?.({ emit });
  post({ type: "ready", pluginId });
}

port.on("message", (event) => {
  const parsed = Schema.decodeUnknownOption(pluginBackendHostRequestSchema)(event.data);
  if (Option.isNone(parsed)) return;
  const request = parsed.value;
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
    post({
      type: "result",
      callId: request.callId,
      ok: false,
      error: `Plugin ${pluginId ?? "unknown"} has no backend method ${request.method}`,
    });
    return;
  }
  const controller = new AbortController();
  active.set(request.callId, controller);
  const emit = (name: string, input: PluginBackendValue) =>
    post({ type: "event", name, value: value(input) });
  void Promise.resolve(method(request.input, { signal: controller.signal, emit }))
    .then((result) =>
      post({ type: "result", callId: request.callId, ok: true, value: value(result) }),
    )
    .catch((error) =>
      post({ type: "result", callId: request.callId, ok: false, error: errorMessage(error) }),
    )
    .finally(() => active.delete(request.callId));
});
