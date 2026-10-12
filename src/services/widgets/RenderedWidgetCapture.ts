import { Context, type Effect } from "effect";
import type { CompiledInlineWidget } from "../../contracts/widgets/inline-widget-contract";
import type { JsonValue } from "../../contracts/serialization/json-contract";
import type { RenderedWidgetCaptureError } from "../../contracts/widgets/rendered-widget-capture-errors";

export interface RenderedWidgetCaptureResult {
  readonly pngBase64: string;
  readonly diagnostics: ReadonlyArray<string>;
}

export class RenderedWidgetCapture extends Context.Service<
  RenderedWidgetCapture,
  {
    readonly preflight?: (sessionId: string) => Effect.Effect<void, RenderedWidgetCaptureError>;
    readonly capture: (
      sessionId: string,
      widget: CompiledInlineWidget,
      signal: AbortSignal,
      pluginState?: JsonValue,
    ) => Effect.Effect<RenderedWidgetCaptureResult, RenderedWidgetCaptureError>;
  }
>()("cake/services/widgets/RenderedWidgetCapture") {}
