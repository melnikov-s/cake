import { useCallback, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import type { z } from "zod";
import {
  desktopResponseSchema,
  type DesktopRequest,
  type DesktopResponse,
} from "../ipc/desktop-ipc";
import type { PluginPersistenceScope } from "../plugin/plugin-contract";
import { useRendererInfrastructure } from "./RendererInfrastructureContext";
import { RootStore } from "./stores/RootStore";
import { useStore } from "r-state-tree/react";

export type SerializablePluginValue =
  | null
  | boolean
  | number
  | string
  | SerializablePluginValue[]
  | { [key: string]: SerializablePluginValue };

interface Resource {
  value: SerializablePluginValue;
  version: number;
  revision: number;
  status: "pending" | "ready" | "failed";
  error?: unknown;
  promise: Promise<void>;
  saveQueue: Promise<void>;
  listeners: Set<() => void>;
}

const resources = new Map<string, Resource>();
const resourceKey = (pluginId: string, key: string, scope: PluginPersistenceScope) =>
  `${pluginId}\0${key}\0${scope.kind === "global" ? "global" : `session:${scope.sessionId}`}`;

function notify(resource: Resource) {
  resource.revision += 1;
  for (const listener of resource.listeners) listener();
}

type InvokePrivileged = (request: DesktopRequest) => Promise<DesktopResponse>;

function createResource<T extends SerializablePluginValue>(
  invoke: InvokePrivileged,
  pluginId: string,
  key: string,
  scope: PluginPersistenceScope,
  schema: z.ZodType<T>,
  initialValue: T,
): Resource {
  const resource: Resource = {
    value: schema.parse(initialValue),
    version: 0,
    revision: 0,
    status: "pending",
    promise: Promise.resolve(),
    saveQueue: Promise.resolve(),
    listeners: new Set(),
  };
  resource.promise = (async () => {
    try {
      const response = desktopResponseSchema.parse(
        await invoke({
          type: "load-plugin-state",
          pluginId,
          key,
          scope,
        }),
      );
      if (response.type !== "plugin-state") throw new Error("Cake returned invalid plugin state");
      if (response.record) {
        resource.value = schema.parse(response.record.value);
        resource.version = response.record.version;
      }
      resource.status = "ready";
    } catch (error) {
      resource.status = "failed";
      resource.error = error;
    }
    notify(resource);
  })();
  return resource;
}

function usePluginState<T extends SerializablePluginValue>(
  pluginId: string,
  key: string,
  scope: PluginPersistenceScope,
  schema: z.ZodType<T>,
  initialValue: T,
): [T, Dispatch<SetStateAction<T>>] {
  const infrastructure = useRendererInfrastructure();
  const invoke: InvokePrivileged = (request) =>
    infrastructure.client.plugins.invoke(request).then(desktopResponseSchema.parse);
  const cacheKey = resourceKey(pluginId, key, scope);
  let resource = resources.get(cacheKey);
  if (!resource) {
    resource = createResource(invoke, pluginId, key, scope, schema, initialValue);
    resources.set(cacheKey, resource);
  }
  useSyncExternalStore(
    (listener) => {
      resource!.listeners.add(listener);
      return () => resource!.listeners.delete(listener);
    },
    () => resource!.revision,
    () => resource!.revision,
  );
  const setValue = useCallback<Dispatch<SetStateAction<T>>>(
    (update) => {
      const current = schema.parse(resource!.value);
      const next = schema.parse(isStateUpdater(update) ? update(current) : update);
      resource!.value = next;
      notify(resource!);
      resource!.saveQueue = resource!.saveQueue
        .then(async () => {
          const response = desktopResponseSchema.parse(
            await invoke({
              type: "save-plugin-state",
              pluginId,
              key,
              scope,
              value: next,
              expectedVersion: resource!.version,
            }),
          );
          if (response.type !== "plugin-state" || !response.record)
            throw new Error("Cake did not persist plugin state");
          resource!.version = response.record.version;
        })
        .catch((error) => {
          resource!.status = "failed";
          resource!.error = error;
          notify(resource!);
        });
    },
    [pluginId, key, cacheKey, schema, invoke],
  );
  if (resource.status === "pending") throw resource.promise;
  if (resource.status === "failed") throw resource.error;
  return [schema.parse(resource.value), setValue];
}

function isStateUpdater<T extends SerializablePluginValue>(
  update: SetStateAction<T>,
): update is (value: T) => T {
  return typeof update === "function";
}

export function usePluginGlobalState<T extends SerializablePluginValue>(
  pluginId: string,
  key: string,
  schema: z.ZodType<T>,
  initialValue: T,
) {
  return usePluginState(pluginId, key, { kind: "global" }, schema, initialValue);
}

export function usePluginSessionState<T extends SerializablePluginValue>(
  pluginId: string,
  key: string,
  schema: z.ZodType<T>,
  initialValue: T,
) {
  const sessionId = useStore(RootStore).projectWorkbenchStore.activeSession?.sessionId;
  if (!sessionId) throw new Error("Session-scoped plugin state requires an active Cake session");
  return usePluginState(pluginId, key, { kind: "session", sessionId }, schema, initialValue);
}
