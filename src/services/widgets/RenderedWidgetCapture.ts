import { BrowserWindow } from "electron";
import { Context, Effect, Layer, Schema } from "effect";
import type { CompiledInlineWidget } from "../../ipc/inline-widget-contract";
import { Electron } from "../electron/Electron";
import { RendererRequestCoordinator } from "../renderer-requests/RendererRequestCoordinator";

export class RenderedWidgetCaptureError extends Schema.TaggedError<RenderedWidgetCaptureError>()(
  "RenderedWidgetCaptureError",
  { message: Schema.String },
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

const failure = (cause: unknown) =>
  new RenderedWidgetCaptureError({
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const RenderedWidgetCaptureLive = Layer.effect(
  RenderedWidgetCapture,
  Effect.gen(function* () {
    const coordinator = yield* RendererRequestCoordinator;
    const electron = yield* Electron;
    return RenderedWidgetCapture.of({
      capture: Effect.fn("RenderedWidgetCapture.capture")(function* (sessionId, widget, signal) {
        const prepared = yield* coordinator
          .requestWidgetPreview(sessionId, widget, signal)
          .pipe(Effect.mapError(failure));
        const { x, y, width, height } = prepared.rect;
        const contents = yield* Effect.try({
          try: () => electron.requireRendererConnection(prepared.connectionId),
          catch: failure,
        });
        return yield* Effect.gen(function* () {
          if (signal.aborted) return yield* failure("Widget review was cancelled");
          if (x < 0 || y < 0 || width < 1 || height < 1 || width > 1_200 || height > 1_200)
            return yield* failure("The widget preview returned invalid capture bounds");
          const window = BrowserWindow.fromWebContents(contents);
          if (!window) return yield* failure("The widget preview window is unavailable");
          const bounds = window.getContentBounds();
          if (!bounds || x + width > bounds.width || y + height > bounds.height)
            return yield* failure("The widget preview lies outside the Cake window");
          const image = yield* Effect.tryPromise({
            try: () => contents.capturePage({ x, y, width, height }),
            catch: failure,
          });
          if (signal.aborted) return yield* failure("Widget review was cancelled");
          const png = image.toPNG();
          if (png.byteLength === 0 || png.byteLength > 8_000_000)
            return yield* failure("The widget preview capture is empty or too large");
          return { pngBase64: png.toString("base64"), diagnostics: prepared.diagnostics };
        }).pipe(
          Effect.ensuring(
            Effect.sync(() =>
              electron.sendTo(contents, { type: "widget-preview-dismissed", token: widget.token }),
            ),
          ),
        );
      }),
    });
  }),
);
