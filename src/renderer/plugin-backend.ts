import { useCallback, useMemo } from "react";
import type { PluginBackendValue } from "../plugin/backend-api";

interface PluginBackendClient {
  call(
    method: string,
    input?: PluginBackendValue,
    options?: { signal?: AbortSignal },
  ): Promise<PluginBackendValue>;
  subscribe(name: string, listener: (value: PluginBackendValue) => void): () => void;
}

export function usePluginBackend(pluginId: string): PluginBackendClient {
  const call = useCallback(
    async (
      method: string,
      input: PluginBackendValue = null,
      options?: { signal?: AbortSignal },
    ) => {
      if (!window.cake) throw new Error("Cake's plugin backend bridge is unavailable");
      const callId = crypto.randomUUID();
      const abort = () => {
        void window.cake?.request({ type: "cancel-plugin-backend-call", pluginId, callId });
      };
      if (options?.signal?.aborted)
        throw new DOMException("The plugin backend call was aborted", "AbortError");
      options?.signal?.addEventListener("abort", abort, { once: true });
      try {
        const response = await window.cake.request({
          type: "call-plugin-backend",
          pluginId,
          callId,
          method,
          input,
        });
        if (response.type !== "plugin-backend-result")
          throw new Error("Cake returned an invalid plugin backend result");
        if (!response.ok) throw new Error(response.error ?? "The plugin backend call failed");
        return response.value ?? null;
      } finally {
        options?.signal?.removeEventListener("abort", abort);
      }
    },
    [pluginId],
  );
  const subscribe = useCallback(
    (name: string, listener: (value: PluginBackendValue) => void) => {
      if (!window.cake) return () => undefined;
      return window.cake.subscribe((event) => {
        if (
          event.type === "plugin-backend-event" &&
          event.pluginId === pluginId &&
          event.name === name
        )
          listener(event.value);
      });
    },
    [pluginId],
  );
  return useMemo(() => ({ call, subscribe }), [call, subscribe]);
}
