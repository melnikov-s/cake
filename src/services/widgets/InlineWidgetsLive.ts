import { Effect, Layer } from "effect";
import type { cakeRpcPayloadSchemas } from "../../contracts/application/cake-rpc-contract";
import { InlineWidgetError } from "../../contracts/widgets/inline-widgets-errors";
import { InlineWidgets } from "./InlineWidgets";
import { WidgetBrowserOutputs } from "./WidgetBrowserOutputs";
import { WidgetPackages } from "./WidgetPackages";
import { compileInlineWidget, type CompiledInlineWidgetDocument } from "./inline-widget-service";

type CompilePayload = (typeof cakeRpcPayloadSchemas)["compile-inline-widget"]["Type"];

export interface InlineWidgetsLiveOptions {
  readonly publish: (compiled: CompiledInlineWidgetDocument) => {
    readonly token: string;
    readonly url: string;
  };
}

export const makeInlineWidgetsLive = (options: InlineWidgetsLiveOptions) =>
  Layer.effect(
    InlineWidgets,
    Effect.gen(function* () {
      const packages = yield* WidgetPackages;
      const browserOutputs = yield* WidgetBrowserOutputs;
      return InlineWidgets.of({
        compile: Effect.fn("InlineWidgets.compile")(function* (request: CompilePayload) {
          const compiled = yield* Effect.tryPromise({
            try: () =>
              compileInlineWidget(request.language, request.source, request.capability, {
                packageDirectory: packages.directory,
              }),
            catch: (cause) =>
              new InlineWidgetError({
                operation: "compile",
                message: cause instanceof Error ? cause.message : String(cause),
              }),
          });
          return { widget: options.publish(compiled) };
        }),
        open: Effect.fn("InlineWidgets.open")(function* (request) {
          return { widget: options.publish(yield* browserOutputs.open(request.browser)) };
        }),
      });
    }),
  );
