import { useCallback, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import type { PluginPersistenceScope } from "../plugin/plugin-contract";
import { MainChatStore } from "./stores/MainChatStore";
import { useStore } from "r-state-tree/react";

export type SerializablePluginValue = null | boolean | number | string | SerializablePluginValue[] | { [key: string]: SerializablePluginValue };

interface Resource<T extends SerializablePluginValue> {
  value: T;
  version: number;
  revision: number;
  status: "pending" | "ready" | "failed";
  error?: unknown;
  promise: Promise<void>;
  saveQueue: Promise<void>;
  listeners: Set<() => void>;
}

const resources = new Map<string, Resource<SerializablePluginValue>>();
const resourceKey = (pluginId: string, key: string, scope: PluginPersistenceScope) => `${pluginId}\0${key}\0${scope.kind === "global" ? "global" : `session:${scope.sessionId}`}`;

function notify(resource: Resource<SerializablePluginValue>) { resource.revision += 1; for (const listener of resource.listeners) listener(); }

function createResource<T extends SerializablePluginValue>(pluginId: string, key: string, scope: PluginPersistenceScope, initialValue: T): Resource<T> {
  const resource: Resource<T> = { value: initialValue, version: 0, revision: 0, status: "pending", promise: Promise.resolve(), saveQueue: Promise.resolve(), listeners: new Set() };
  resource.promise = (async () => {
    try {
      if (!window.cake) throw new Error("Cake's persistence bridge is unavailable");
      const response = await window.cake.request({ type: "load-plugin-state", pluginId, key, scope });
      if (response.type !== "plugin-state") throw new Error("Cake returned invalid plugin state");
      if (response.record) { resource.value = response.record.value as T; resource.version = response.record.version; }
      resource.status = "ready";
    } catch (error) { resource.status = "failed"; resource.error = error; }
    notify(resource);
  })();
  return resource;
}

function usePluginState<T extends SerializablePluginValue>(pluginId: string, key: string, scope: PluginPersistenceScope, initialValue: T): [T, Dispatch<SetStateAction<T>>] {
  const cacheKey = resourceKey(pluginId, key, scope);
  let resource = resources.get(cacheKey) as Resource<T> | undefined;
  if (!resource) { resource = createResource(pluginId, key, scope, initialValue); resources.set(cacheKey, resource); }
  useSyncExternalStore((listener) => { resource!.listeners.add(listener); return () => resource!.listeners.delete(listener); }, () => resource!.revision, () => resource!.revision);
  const setValue = useCallback<Dispatch<SetStateAction<T>>>((update) => {
    const next = typeof update === "function" ? (update as (value: T) => T)(resource!.value) : update;
    resource!.value = next; notify(resource!);
    resource!.saveQueue = resource!.saveQueue.then(async () => {
      if (!window.cake) throw new Error("Cake's persistence bridge is unavailable");
      const response = await window.cake.request({ type: "save-plugin-state", pluginId, key, scope, value: next, expectedVersion: resource!.version });
      if (response.type !== "plugin-state" || !response.record) throw new Error("Cake did not persist plugin state");
      resource!.version = response.record.version;
    }).catch((error) => { resource!.status = "failed"; resource!.error = error; notify(resource!); });
  }, [pluginId, key, cacheKey]);
  if (resource.status === "pending") throw resource.promise;
  if (resource.status === "failed") throw resource.error;
  return [resource.value, setValue];
}

export function usePluginGlobalState<T extends SerializablePluginValue>(pluginId: string, key: string, initialValue: T) {
  return usePluginState(pluginId, key, { kind: "global" }, initialValue);
}

export function usePluginSessionState<T extends SerializablePluginValue>(pluginId: string, key: string, initialValue: T) {
  const sessionId = useStore(MainChatStore).session?.sessionId;
  if (!sessionId) throw new Error("Session-scoped plugin state requires an active Cake session");
  return usePluginState(pluginId, key, { kind: "session", sessionId }, initialValue);
}
