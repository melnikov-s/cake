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
import type { RequestInspection } from "./request-inspection";
import { CAKE_CHAT_SESSION_ID } from "../../ipc/cake-chat-data";

/** Keep Cake's existing credential/custom-provider authority. Never ask the newer
 * collection to authenticate against a different default Pi home. The two SDKs
 * brand normalized contexts separately, so normalize at this request boundary. */
export function durableModels(
  runtime: Pick<
    ModelRuntime,
    "streamSimple" | "stream" | "streamDeferred" | "cancelDeferred" | "getProviders"
  >,
  fastMode: () => boolean = () => false,
  inspection?: RequestInspection,
): Models & { synchronizeProviders(): void } {
  const catalog = createModels();
  const relay = (
    start: () => ReturnType<ModelRuntime["streamSimple"]>,
    model: Parameters<Models["streamSimple"]>[0],
    capture?: ReturnType<RequestInspection["begin"]>,
  ): AssistantMessageEventStream => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      for await (const event of start()) {
        if (event.type === "error") capture?.settle(true);
        if (event.type === "done") capture?.settle(false);
        output.push(event);
      }
    })().catch((error: unknown) => {
      capture?.settle(true);
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
  const streamSimple: Models["streamSimple"] = (model, context, options) => {
    const capture = inspection?.begin(CAKE_CHAT_SESSION_ID, model, options, fastMode());
    return relay(
      () =>
        runtime.streamSimple(model, normalizeContext({ messages: context.messages }), {
          ...options,
          fetch: capture ? capture.fetch(options?.fetch) : options?.fetch,
          onPayload: async (payload, selected) => {
            const transformed = applyFastModePayload(
              Schema.decodeUnknownSync(FastModePayload)(
                (await options?.onPayload?.(payload, selected)) ?? payload,
              ),
              selected,
              fastMode(),
            );
            capture?.payload(transformed);
            return transformed;
          },
        }),
      model,
      capture,
    );
  };
  const stream: Models["stream"] = (model, context, options) => {
    const capture = inspection?.begin(CAKE_CHAT_SESSION_ID, model, options);
    return relay(
      () =>
        runtime.stream<Api>(model, normalizeContext({ messages: context.messages }), {
          ...options,
          fetch: capture ? capture.fetch(options?.fetch) : options?.fetch,
          onPayload: async (payload, selected) => {
            const transformed = (await options?.onPayload?.(payload, selected)) ?? payload;
            capture?.payload(transformed);
            return transformed;
          },
        }),
      model,
      capture,
    );
  };
  const streamDeferred: Models["streamDeferred"] = (model, handle, options) => {
    const capture = inspection?.begin(CAKE_CHAT_SESSION_ID, model, options);
    return relay(
      () =>
        runtime.streamDeferred(model, handle, {
          ...options,
          fetch: capture ? capture.fetch(options?.fetch) : options?.fetch,
          onPayload: async (payload, selected) => {
            const transformed = (await options?.onPayload?.(payload, selected)) ?? payload;
            capture?.payload(transformed);
            return transformed;
          },
        }),
      model,
      capture,
    );
  };
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
