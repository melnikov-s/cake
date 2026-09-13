import { BrowserWindow } from "electron";
import { Context, Effect, Layer, Schema, Semaphore } from "effect";
import type { CompiledInlineWidget } from "../../ipc/inline-widget-contract";

const CAPTURE_WIDTH = 560;
const CAPTURE_HEIGHT = 480;
const MAX_CAPTURE_BYTES = 8_000_000;
const READY_TIMEOUT_MS = 15_000;

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

const failure = (kind: RenderedWidgetCaptureError["kind"], cause: unknown) =>
  new RenderedWidgetCaptureError({
    kind,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const hostDocument = () =>
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src cake-widget:; style-src 'unsafe-inline'"><style>html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent}iframe{display:block;width:100%;height:100%;border:0}</style></head><body></body></html>`;

const prepareScript = (widget: CompiledInlineWidget) => `(() => new Promise((resolve) => {
  const token = ${JSON.stringify(widget.token)};
  const diagnostics = [];
  let contentHeight;
  let settled = false;
  let timeout;
  const frame = document.createElement("iframe");
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    removeEventListener("message", receive);
    resolve(value);
  };
  const receive = (event) => {
    const value = event.data;
    if (event.source !== frame.contentWindow || !value || typeof value !== "object" ||
        value.source !== "cake-inline-widget" || value.token !== token) return;
    if (value.type === "height" && typeof value.value === "number") {
      contentHeight = value.value;
      return;
    }
    if (value.type === "error") {
      finish({ diagnostics, runtimeError: String(value.value).slice(0, 2000) });
      return;
    }
    if (value.type !== "ready") return;
    requestAnimationFrame(() => requestAnimationFrame(() => finish({
      rect: { x: 0, y: 0, width: innerWidth, height: innerHeight },
      diagnostics: [
        "viewport=" + innerWidth + "x" + innerHeight,
        "widget=" + innerWidth + "x" + innerHeight,
        "contentHeight=" + Math.ceil(contentHeight ?? innerHeight),
        "verticalOverflow=" + ((contentHeight ?? innerHeight) > innerHeight),
        "deviceScaleFactor=" + devicePixelRatio,
        "host=hidden-offscreen"
      ]
    })));
  };
  addEventListener("message", receive);
  timeout = setTimeout(() => finish({ diagnostics, runtimeError: "Widget did not become ready" }), ${READY_TIMEOUT_MS});
  frame.title = "Widget visual review capture";
  frame.sandbox = "allow-scripts";
  frame.referrerPolicy = "no-referrer";
  frame.src = ${JSON.stringify(widget.url)};
  document.body.append(frame);
}))()`;

const acquireWindow = Effect.acquireRelease(
  Effect.try({
    try: () => {
      const window = new BrowserWindow({
        width: CAPTURE_WIDTH,
        height: CAPTURE_HEIGHT,
        useContentSize: true,
        show: false,
        frame: false,
        focusable: false,
        skipTaskbar: true,
        transparent: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          offscreen: true,
          backgroundThrottling: false,
          spellcheck: false,
        },
      });
      window.setTitle("Cake Widget Review Capture");
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      return window;
    },
    catch: (cause) => failure("infrastructure", cause),
  }),
  (window) => Effect.sync(() => window.destroy()),
);

const abortEffect = (signal: AbortSignal) =>
  Effect.callback<never, RenderedWidgetCaptureError>((resume) => {
    const onAbort = () => resume(Effect.fail(failure("cancelled", "Widget review was cancelled")));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

export const RenderedWidgetCaptureLive = Layer.effect(
  RenderedWidgetCapture,
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const capture = Effect.fn("RenderedWidgetCapture.capture")(function* (
      _sessionId: string,
      widget: CompiledInlineWidget,
      signal: AbortSignal,
    ) {
      if (signal.aborted) return yield* failure("cancelled", "Widget review was cancelled");
      const work = lock.withPermits(1)(
        Effect.scoped(
          Effect.gen(function* () {
            if (signal.aborted) return yield* failure("cancelled", "Widget review was cancelled");
            const window = yield* acquireWindow;
            yield* Effect.tryPromise({
              try: () =>
                window.loadURL(
                  `data:text/html;charset=utf-8,${encodeURIComponent(hostDocument())}`,
                ),
              catch: (cause) => failure("infrastructure", cause),
            });
            const prepared = yield* Effect.tryPromise({
              try: () => window.webContents.executeJavaScript(prepareScript(widget), true),
              catch: (cause) => failure("infrastructure", cause),
            }).pipe(
              Effect.flatMap((value) =>
                Schema.decodeUnknownEffect(
                  Schema.Struct({
                    rect: Schema.optionalKey(
                      Schema.Struct({
                        x: Schema.Int,
                        y: Schema.Int,
                        width: Schema.Int,
                        height: Schema.Int,
                      }),
                    ),
                    diagnostics: Schema.Array(Schema.String),
                    runtimeError: Schema.optionalKey(Schema.String),
                  }),
                )(value),
              ),
              Effect.mapError((cause) => failure("infrastructure", cause)),
            );
            if (prepared.runtimeError)
              return yield* failure(
                prepared.runtimeError === "Widget did not become ready"
                  ? "infrastructure"
                  : "widget",
                prepared.runtimeError,
              );
            if (!prepared.rect)
              return yield* failure("infrastructure", "Widget capture bounds are unavailable");
            if (
              prepared.rect.x !== 0 ||
              prepared.rect.y !== 0 ||
              prepared.rect.width !== CAPTURE_WIDTH ||
              prepared.rect.height !== CAPTURE_HEIGHT
            )
              return yield* failure(
                "infrastructure",
                "Widget capture viewport was not deterministic",
              );
            // capturePage has no native abort. Keep the serialization permit and native window
            // alive until it settles, then discard pixels when cancellation won meanwhile.
            const image = yield* Effect.uninterruptible(
              Effect.tryPromise({
                try: () => window.webContents.capturePage(prepared.rect),
                catch: (cause) => failure("infrastructure", cause),
              }),
            );
            if (signal.aborted) return yield* failure("cancelled", "Widget review was cancelled");
            const png = image.toPNG();
            if (png.byteLength === 0 || png.byteLength > MAX_CAPTURE_BYTES)
              return yield* failure(
                "infrastructure",
                "Widget preview capture is empty or too large",
              );
            return { pngBase64: png.toString("base64"), diagnostics: prepared.diagnostics };
          }),
        ),
      );
      return yield* Effect.raceFirst(work, abortEffect(signal));
    });
    return RenderedWidgetCapture.of({ capture });
  }),
);
