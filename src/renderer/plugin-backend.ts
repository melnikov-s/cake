import { useCallback, useMemo } from "react";
import { desktopResponseSchema } from "../ipc/desktop-ipc";
import type { PluginBackendValue } from "../plugin/backend-api";
import { useRendererInfrastructure } from "./RendererInfrastructureContext";

interface PluginBackendClient {
  call(
    method: string,
    input?: PluginBackendValue,
    options?: { signal?: AbortSignal },
  ): Promise<PluginBackendValue>;
  subscribe(name: string, listener: (value: PluginBackendValue) => void): () => void;
}

export function usePluginBackend(pluginId: string): PluginBackendClient {
  const infrastructure = useRendererInfrastructure();
  const call = useCallback(
    async (
      method: string,
      input: PluginBackendValue = null,
      options?: { signal?: AbortSignal },
    ) => {
      const callId = crypto.randomUUID();
      const abort = () => {
        void infrastructure.client.plugins.invoke({
          type: "cancel-plugin-backend-call",
          pluginId,
          callId,
        });
      };
      if (options?.signal?.aborted)
        throw new DOMException("The plugin backend call was aborted", "AbortError");
      options?.signal?.addEventListener("abort", abort, { once: true });
      try {
        const response = desktopResponseSchema.parse(
          await infrastructure.client.plugins.invoke({
            type: "call-plugin-backend",
            pluginId,
            callId,
            method,
            input,
          }),
        );
        if (response.type !== "plugin-backend-result")
          throw new Error("Cake returned an invalid plugin backend result");
        if (!response.ok) throw new Error(response.error ?? "The plugin backend call failed");
        return response.value ?? null;
      } finally {
        options?.signal?.removeEventListener("abort", abort);
      }
    },
    [infrastructure, pluginId],
  );
  const subscribe = useCallback(
    (name: string, listener: (value: PluginBackendValue) => void) => {
      return infrastructure.subscribe((event) => {
        if (
          event.type === "plugin-backend-event" &&
          event.pluginId === pluginId &&
          event.name === name
        )
          listener(event.value);
      });
    },
    [infrastructure, pluginId],
  );
  return useMemo(() => ({ call, subscribe }), [call, subscribe]);
}
