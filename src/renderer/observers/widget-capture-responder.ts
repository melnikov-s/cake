import { Effect } from "effect";
import type { CakeEvent } from "../../contracts/application/cake-rpc-contract";
import { RenderedWidgetCaptureError } from "../../contracts/widgets/rendered-widget-capture-errors";
import { CakeIpcClient } from "../../ipc/client/CakeIpcClient";

/** Captures once on the native host, preserving the backend request's correlation and result shape. */
export const respondWidgetCapture = Effect.fn("Renderer.respondWidgetCapture")(function* (
  event: Extract<CakeEvent, { type: "widget-capture-requested" }>,
  host: "desktop" | "browser",
) {
  const client = yield* CakeIpcClient;
  const result =
    host === "browser"
      ? {
          ok: false as const,
          kind: "infrastructure" as const,
          message: "Native widget capture is unavailable in this browser",
        }
      : yield* client.widgets["capture-native-widget"]({
          sessionId: event.sessionId,
          widget: event.widget,
          pluginState: event.pluginState,
        }).pipe(
          Effect.map((value) => ({ ok: true as const, ...value })),
          Effect.catch((cause) =>
            Effect.succeed({
              ok: false as const,
              kind:
                cause instanceof RenderedWidgetCaptureError
                  ? cause.kind
                  : ("infrastructure" as const),
              message:
                cause instanceof Error
                  ? cause.message.slice(0, 2000)
                  : "Desktop capture unavailable",
            }),
          ),
        );
  yield* client.widgets["respond-widget-capture"]({
    requestId: event.requestId,
    sessionId: event.sessionId,
    result,
  });
});
