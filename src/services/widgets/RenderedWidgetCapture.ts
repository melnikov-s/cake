import { BrowserWindow } from "electron";
import { Context, Effect, Layer, Schema } from "effect";
import type { CompiledInlineWidget } from "../../ipc/inline-widget-contract";
import { Electron } from "../electron/Electron";
import { RendererRequestCoordinator } from "../renderer-requests/RendererRequestCoordinator";

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
    readonly capture: (
      sessionId: string,
      widget: CompiledInlineWidget,
      signal: AbortSignal,
    ) => Effect.Effect<RenderedWidgetCaptureResult, RenderedWidgetCaptureError>;
  }
>()("cake/services/widgets/RenderedWidgetCapture") {}

const failure = (kind: "widget" | "cancelled" | "infrastructure", cause: unknown) =>
  new RenderedWidgetCaptureError({
    kind,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const RenderedWidgetCaptureLive = Layer.effect(
  RenderedWidgetCapture,
  Effect.gen(function* () {
    const coordinator = yield* RendererRequestCoordinator;
    const electron = yield* Electron;
    return RenderedWidgetCapture.of({
      capture: Effect.fn("RenderedWidgetCapture.capture")(function* (sessionId, widget, signal) {
        return yield* coordinator
          .withWidgetPreview(sessionId, widget, signal, (prepared) => {
            const capturePixels = Effect.gen(function* () {
              if (signal.aborted) return yield* failure("cancelled", "Widget review was cancelled");
              const { x, y, width, height } = prepared.rect;
              if (x < 0 || y < 0 || width < 1 || height < 1 || width > 1_200 || height > 1_200)
                return yield* failure(
                  "infrastructure",
                  "The widget preview returned invalid capture bounds",
                );
              const contents = yield* Effect.try({
                try: () => electron.requireRendererConnection(prepared.connectionId),
                catch: (cause) => failure("infrastructure", cause),
              });
              const window = BrowserWindow.fromWebContents(contents);
              if (!window)
                return yield* failure("infrastructure", "The widget preview window is unavailable");
              const bounds = window.getContentBounds();
              if (x + width > bounds.width || y + height > bounds.height)
                return yield* failure(
                  "infrastructure",
                  "The widget preview lies outside the Cake window",
                );
              // capturePage has no native abort. Once started, keep the per-renderer lease until
              // Electron settles, then reject and discard pixels if cancellation won meanwhile.
              const image = yield* Effect.uninterruptible(
                Effect.tryPromise({
                  try: () => contents.capturePage({ x, y, width, height }),
                  catch: (cause) => failure("infrastructure", cause),
                }),
              );
              if (signal.aborted) return yield* failure("cancelled", "Widget review was cancelled");
              const png = image.toPNG();
              if (png.byteLength === 0 || png.byteLength > 8_000_000)
                return yield* failure(
                  "infrastructure",
                  "The widget preview capture is empty or too large",
                );
              return { pngBase64: png.toString("base64"), diagnostics: prepared.diagnostics };
            });
            return capturePixels;
          })
          .pipe(
            Effect.mapError((cause) => {
              if (cause instanceof RenderedWidgetCaptureError) return cause;
              if (cause.operation === "widgetRuntime") return failure("widget", cause.message);
              if (cause.operation === "widgetCancelled") return failure("cancelled", cause.message);
              return failure(signal.aborted ? "cancelled" : "infrastructure", cause.message);
            }),
          );
      }),
    });
  }),
);
