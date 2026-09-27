import { Effect, Option } from "effect";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import {
  RenderedWidgetCapture,
  RenderedWidgetCaptureError,
} from "../../services/widgets/RenderedWidgetCapture";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";
import { NativeWidgetCaptureRpc, WidgetCaptureResponseRpc } from "../protocol/WidgetCaptureRpc";

export const nativeWidgetCaptureHandlers = NativeWidgetCaptureRpc.of({
  "widgets.capture-native-widget": ({ sessionId, widget, pluginState }) =>
    Effect.gen(function* () {
      if (
        !/^[0-9a-f-]{36}$/.test(widget.token) ||
        widget.url !== `cake-widget://document/${widget.token}`
      )
        return yield* new RenderedWidgetCaptureError({
          kind: "infrastructure",
          message: "Invalid widget capture capability",
        });
      const capture = yield* Effect.serviceOption(RenderedWidgetCapture);
      if (Option.isNone(capture))
        return yield* new RenderedWidgetCaptureError({
          kind: "infrastructure",
          message: "Native capture unavailable",
        });
      const cancellation = new AbortController();
      return yield* capture.value
        .capture(sessionId, widget, cancellation.signal, pluginState)
        .pipe(Effect.ensuring(Effect.sync(() => cancellation.abort())));
    }),
});

export const widgetCaptureResponseHandlers = WidgetCaptureResponseRpc.of({
  "widgets.respond-widget-capture": ({ sessionId, requestId, result }) =>
    Effect.gen(function* () {
      const { connectionId } = yield* RendererConnection;
      yield* (yield* RendererRequestCoordinator).respondWidgetCapture(
        connectionId,
        sessionId,
        requestId,
        result,
      );
      return {};
    }).pipe(
      Effect.mapError(
        (error) =>
          new RenderedWidgetCaptureError({ kind: "infrastructure", message: error.message }),
      ),
    ),
});
