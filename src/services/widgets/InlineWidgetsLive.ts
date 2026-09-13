import { Effect, Layer } from "effect";
import type { cakeRpcPayloadSchemas } from "../../ipc/cake-rpc-contract";
import { InlineWidgetError, InlineWidgets } from "./InlineWidgets";
import { compileInlineWidget } from "./inline-widget-service";

type CompilePayload = (typeof cakeRpcPayloadSchemas)["compile-inline-widget"]["Type"];

export interface InlineWidgetsLiveOptions {
  readonly publish: (compiled: { readonly token: string; readonly document: string }) => {
    readonly token: string;
    readonly url: string;
  };
}

export const makeInlineWidgetsLive = (
  options: InlineWidgetsLiveOptions,
): Layer.Layer<InlineWidgets> =>
  Layer.succeed(
    InlineWidgets,
    InlineWidgets.of({
      compile: Effect.fn("InlineWidgets.compile")(function* (request: CompilePayload) {
        return yield* Effect.tryPromise({
          try: async () => ({
            widget: options.publish(
              await compileInlineWidget(request.language, request.source, request.capability),
            ),
          }),
          catch: (cause) =>
            new InlineWidgetError({
              operation: "compile",
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        });
      }),
    }),
  );
