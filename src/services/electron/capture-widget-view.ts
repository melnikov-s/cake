import type { WebContents } from "electron";
import { Clock, Effect, Schema } from "effect";
import { ElectronError } from "../../contracts/desktop/electron-errors";
import { WidgetViewIdentity } from "../../contracts/widgets/widget-view-evidence";

const preparedView = Schema.Union([
  Schema.Struct({
    identity: WidgetViewIdentity,
    rect: Schema.Struct({ x: Schema.Int, y: Schema.Int, width: Schema.Int, height: Schema.Int }),
  }),
  Schema.Struct({ error: Schema.String }),
]);

// Runs only in the requesting Cake renderer, not in widget code. Never remounts or rerenders it.
const inspectView = (
  viewId: string,
) => `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve((() => {
  const host = Array.from(document.querySelectorAll('[data-widget-view-id]'))
    .find(element => element.getAttribute('data-widget-view-id') === ${JSON.stringify(viewId)});
  const frame = host?.querySelector('iframe');
  if (!frame || host.getAttribute('data-widget-view-ready') !== 'true')
    return { error: 'Current widget view is unavailable or not ready. Open the widget first.' };
  const bounds = frame.getBoundingClientRect();
  const x = Math.ceil(bounds.left), y = Math.ceil(bounds.top);
  const right = Math.floor(bounds.right), bottom = Math.floor(bounds.bottom);
  if (x < 0 || y < 0 || right > innerWidth || bottom > innerHeight || right <= x || bottom <= y ||
      ![[x, y], [right - 1, y], [x, bottom - 1], [right - 1, bottom - 1], [(x + right) / 2, (y + bottom) / 2]]
        .every(([px, py]) => document.elementFromPoint(px, py) === frame))
    return { error: 'Widget view is clipped or covered. Scroll it fully into view or use fullscreen, then retry.' };
  return { identity: JSON.parse(host.getAttribute('data-widget-view-identity')),
    rect: { x, y, width: right - x, height: bottom - y } };
})()))))`;

export const captureWidgetView = Effect.fn("Electron.captureWidgetView")(
  function* (sender: Pick<WebContents, "executeJavaScript" | "capturePage">, viewId: string) {
    const prepare = () =>
      Effect.tryPromise({
        try: () => sender.executeJavaScript(inspectView(viewId)),
        catch: (cause) => new ElectronError({ message: String(cause) }),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(preparedView)),
        Effect.mapError((cause) => new ElectronError({ message: String(cause) })),
        Effect.flatMap((value) =>
          "error" in value
            ? Effect.fail(new ElectronError({ message: value.error }))
            : Effect.succeed(value),
        ),
      );
    const before = yield* prepare();
    const image = yield* Effect.tryPromise({
      try: () => sender.capturePage(before.rect),
      catch: (cause) => new ElectronError({ message: String(cause) }),
    });
    const after = yield* prepare();
    if (JSON.stringify(before) !== JSON.stringify(after))
      return yield* new ElectronError({
        message: "Widget view changed during capture. Please retry.",
      });
    const png = image.toPNG();
    if (!png.byteLength || png.byteLength > 8_000_000)
      return yield* new ElectronError({ message: "Current widget capture is empty or too large." });
    const capturedAt = yield* Clock.currentTimeMillis;
    return {
      ...before.identity,
      provenance: "live-widget-view" as const,
      capturedAt: new Date(capturedAt).toISOString(),
      width: image.getSize().width,
      height: image.getSize().height,
      data: png.toString("base64"),
    };
  },
  Effect.timeout("10 seconds"),
  Effect.catchTag("TimeoutError", () =>
    Effect.fail(
      new ElectronError({
        message:
          "Current widget capture timed out. Restore the window and retry; no initial-state preview was substituted.",
      }),
    ),
  ),
);
