import { normalizeContext, type Api } from "@earendil-works/pi-ai";
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  type Models,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-durable-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import { applyFastModePayload, FastModePayload } from "../pi/fast-mode";
import { durableModelFacade } from "./durable-model-facade";

/** Keep Cake's existing credential/custom-provider authority. Never ask the newer
 * collection to authenticate against a different default Pi home. The two SDKs
 * brand normalized contexts separately, so normalize at this request boundary. */
export function durableModels(
  runtime: ModelRuntime,
  fastMode: () => boolean = () => false,
): Models & { synchronizeProviders(): void } {
  const catalog = createModels();
  const relay = (
    start: () => ReturnType<ModelRuntime["streamSimple"]>,
    model: Parameters<Models["streamSimple"]>[0],
  ): AssistantMessageEventStream => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      for await (const event of start()) output.push(event);
    })().catch((error: unknown) => {
      const message = {
        role: "assistant" as const,
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: "error" as const,
        errorMessage: error instanceof Error ? error.message : String(error),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      output.push({ type: "error", reason: "error", error: message });
    });
    return output;
  };
  const streamSimple: Models["streamSimple"] = (model, context, options) =>
    relay(
      () =>
        runtime.streamSimple(model, normalizeContext({ messages: context.messages }), {
          ...options,
          onPayload: async (payload, selected) =>
            applyFastModePayload(
              Schema.decodeUnknownSync(FastModePayload)(
                (await options?.onPayload?.(payload, selected)) ?? payload,
              ),
              selected,
              fastMode(),
            ),
        }),
      model,
    );
  const stream: Models["stream"] = (model, context, options) =>
    relay(
      () =>
        runtime.stream<Api>(
          model,
          normalizeContext({ messages: context.messages }),
          // SAFETY: the same registered provider's expert options cross the versioned SDK boundary unchanged.
          options as Parameters<ModelRuntime["stream"]>[2],
        ),
      model,
    );
  const streamDeferred: Models["streamDeferred"] = (model, handle, options) =>
    relay(() => runtime.streamDeferred(model, handle, options), model);
  const synchronizeProviders = () => {
    catalog.clearProviders();
    for (const provider of runtime.getProviders())
      catalog.setProvider(
        createProvider({
          id: provider.id,
          name: provider.name,
          auth: provider.auth,
          models: provider.getModels(),
          api: { stream, streamSimple },
        }),
      );
  };
  synchronizeProviders();
  return durableModelFacade(catalog, {
    stream,
    streamSimple,
    streamDeferred,
    complete: (model, context, options) => stream(model, context, options).result(),
    completeSimple: (model, context, options) => streamSimple(model, context, options).result(),
    fetchDeferred: (model, handle, options) => streamDeferred(model, handle, options).result(),
    cancelDeferred: (model, handle, options) => runtime.cancelDeferred(model, handle, options),
    synchronizeProviders,
  });
}
