import { Context, type Effect, Schema } from "effect";
import type { CompiledInlineWidget } from "../../ipc/inline-widget-contract";
import type { JsonValue } from "../../ipc/json-contract";

export class RenderedWidgetCaptureError extends Schema.TaggedError<RenderedWidgetCaptureError>()(
  "RenderedWidgetCaptureError",
  { kind: Schema.Literals(["widget", "cancelled", "infrastructure"]), message: Schema.String },
) {}

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
