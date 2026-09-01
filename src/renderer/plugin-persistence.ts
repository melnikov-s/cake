import { useCallback, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import { Schema } from "effect";
import type { RendererClient } from "./client/RendererClient";
import type { PluginPersistenceScope } from "../plugin/plugin-contract";
import { useRendererInfrastructure } from "./RendererInfrastructureContext";
import { RootStore } from "./stores/RootStore";
import { useStore } from "r-state-tree/react";

export type SerializablePluginValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<SerializablePluginValue>
  | { readonly [key: string]: SerializablePluginValue };

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

function createResource<T extends SerializablePluginValue>(
  client: RendererClient["plugins"],
  pluginId: string,
  key: string,
  scope: PluginPersistenceScope,
  schema: Schema.ConstraintDecoder<T, never>,
  initialValue: T,
): Resource {
  const resource: Resource = {
    value: Schema.decodeUnknownSync(schema)(initialValue),
    version: 0,
    revision: 0,
    status: "pending",
    promise: Promise.resolve(),
    saveQueue: Promise.resolve(),
    listeners: new Set(),
  };
  resource.promise = (async () => {
    try {
      const record = await client.loadState(pluginId, key, scope);
      if (record) {
        resource.value = Schema.decodeUnknownSync(schema)(record.value);
        resource.version = record.version;
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
  schema: Schema.ConstraintDecoder<T, never>,
  initialValue: T,
): [T, Dispatch<SetStateAction<T>>] {
  const infrastructure = useRendererInfrastructure();
  const client = infrastructure.client.plugins;
  const cacheKey = resourceKey(pluginId, key, scope);
  let resource = resources.get(cacheKey);
  if (!resource) {
    resource = createResource(client, pluginId, key, scope, schema, initialValue);
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
      const current = Schema.decodeUnknownSync(schema)(resource!.value);
      const next = Schema.decodeUnknownSync(schema)(
        isStateUpdater(update) ? update(current) : update,
      );
      resource!.value = next;
      notify(resource!);
      resource!.saveQueue = resource!.saveQueue
        .then(async () => {
          const record = await client.saveState({
            pluginId,
            key,
            scope,
            value: next,
            expectedVersion: resource!.version,
          });
          resource!.version = record.version;
        })
        .catch((error) => {
          resource!.status = "failed";
          resource!.error = error;
          notify(resource!);
        });
    },
    [pluginId, key, cacheKey, schema, client],
  );
  if (resource.status === "pending") throw resource.promise;
  if (resource.status === "failed") throw resource.error;
  return [Schema.decodeUnknownSync(schema)(resource.value), setValue];
}

function isStateUpdater<T extends SerializablePluginValue>(
  update: SetStateAction<T>,
): update is (value: T) => T {
  return typeof update === "function";
}

export function usePluginGlobalState<T extends SerializablePluginValue>(
  pluginId: string,
  key: string,
  schema: Schema.ConstraintDecoder<T, never>,
  initialValue: T,
) {
  return usePluginState(pluginId, key, { kind: "global" }, schema, initialValue);
}

export function usePluginSessionState<T extends SerializablePluginValue>(
  pluginId: string,
  key: string,
  schema: Schema.ConstraintDecoder<T, never>,
  initialValue: T,
) {
  const sessionId = useStore(RootStore).projectWorkbenchStore.activeSession?.sessionId;
  if (!sessionId) throw new Error("Session-scoped plugin state requires an active Cake session");
  return usePluginState(pluginId, key, { kind: "session", sessionId }, schema, initialValue);
}
