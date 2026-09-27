import { Effect, Layer } from "effect";
import { RendererRequestCoordinator } from "../renderer-requests/RendererRequestCoordinator";
import { RenderedWidgetCapture, RenderedWidgetCaptureError } from "./RenderedWidgetCapture";

/** Backend-side request bridge. Pixels are always produced by the bound desktop. */
export const RemoteRenderedWidgetCaptureLive = Layer.effect(
  RenderedWidgetCapture,
  Effect.gen(function* () {
    const requests = yield* RendererRequestCoordinator;
    return RenderedWidgetCapture.of({
      preflight: Effect.fn("RemoteRenderedWidgetCapture.preflight")((sessionId) =>
        requests
          .requireDesktopRecipient(sessionId)
          .pipe(
            Effect.mapError(
              (error) =>
                new RenderedWidgetCaptureError({ kind: "infrastructure", message: error.message }),
            ),
          ),
      ),
      capture: Effect.fn("RemoteRenderedWidgetCapture.capture")(
        (sessionId, widget, signal, pluginState) =>
          requests.requestWidgetCapture(sessionId, widget, signal, pluginState).pipe(
            Effect.mapError((error) =>
              error instanceof RenderedWidgetCaptureError
                ? error
                : new RenderedWidgetCaptureError({
                    kind: "infrastructure",
                    message: String(error),
                  }),
            ),
          ),
      ),
    });
  }),
);
