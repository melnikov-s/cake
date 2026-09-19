import { Option, Schema } from "effect";
import { jsonObjectSchema, type JsonObject, type JsonValue } from "../../../ipc/json-contract";
import type { BrowserActionResult } from "../../browser/Browser";
import { cakeOperationImageResult, type CakeOperationDefinition } from "./cake-operation-registry";

const browserEnterInputSchema = Schema.Struct({});
const browserCdpInputSchema = Schema.Struct({
  method: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  params: Schema.optionalKey(jsonObjectSchema),
});
const browserEventsInputSchema = Schema.Struct({
  methods: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))).check(
      Schema.isMaxLength(100),
    ),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(500)),
  ),
  clear: Schema.optionalKey(Schema.Boolean),
});

const screenshotResultSchema = Schema.Struct({ data: Schema.String });
type BrowserCdpInput = typeof browserCdpInputSchema.Type;

export interface BrowserControl {
  enter(signal: AbortSignal): Promise<void>;
  cdp(
    method: string,
    params: JsonObject,
    signal: AbortSignal,
  ): Promise<BrowserActionResult<JsonValue>>;
  events(
    methods: ReadonlyArray<string>,
    limit: number,
    clear: boolean,
    signal: AbortSignal,
  ): Promise<BrowserActionResult<JsonValue>>;
}

function modeRequired() {
  return {
    ok: false,
    error: {
      code: "BROWSER_MODE_REQUIRED",
      retryable: true,
      recovery: "Call browser.enter, then retry the same CDP command.",
    },
  } as const;
}

export function createCakeBrowserOperations(control: BrowserControl): CakeOperationDefinition[] {
  return [
    {
      command: "browser.enter",
      topic: "browser",
      summary: "Enter Browser Mode for the calling Project Session.",
      guidance: [
        "Use Browser Mode to run, inspect, and interact with local web applications while the user watches.",
        "The embedded browser has a persistent Cake profile, so cookies and site storage survive restarts.",
      ],
      inputSchema: browserEnterInputSchema,
      examples: [{}],
      result: "Confirmation that Cake entered Browser Mode.",
      async execute(_input, context) {
        await control.enter(context.signal);
        return { entered: true };
      },
    },
    {
      command: "browser.events",
      topic: "browser",
      summary: "Read buffered Chrome DevTools Protocol events from the embedded browser.",
      guidance: [
        "Enable the relevant CDP domain with browser.cdp before collecting its events.",
        "Omit methods to read all buffered events, or filter by exact event names such as Network.responseReceived.",
        "Events are retained in a bounded 500-event buffer. Reading clears matching events by default.",
      ],
      inputSchema: browserEventsInputSchema,
      examples: [
        { input: { methods: ["Runtime.consoleAPICalled", "Runtime.exceptionThrown"], limit: 100 } },
      ],
      result: "Buffered CDP events in arrival order.",
      limitations: ["Call browser.enter before using this operation."],
      async execute(input, context) {
        // SAFETY: CakeOperationRegistry parsed this value with browserEventsInputSchema.
        const request = input as typeof browserEventsInputSchema.Type;
        const result = await control.events(
          request.methods ?? [],
          request.limit ?? 100,
          request.clear ?? true,
          context.signal,
        );
        return result.status === "mode-required" ? modeRequired() : result.value;
      },
    },
    {
      command: "browser.cdp",
      topic: "browser",
      summary: "Send any Chrome DevTools Protocol command to the Project Session's browser.",
      guidance: [
        "This is unrestricted raw CDP. Use any domain and method supported by the embedded Chromium version.",
        "Enable a CDP domain before relying on its events or domain-specific state.",
        "Runtime.evaluate may execute arbitrary JavaScript in the loaded page.",
        "Page.captureScreenshot is returned as image content rather than a large JSON string.",
      ],
      inputSchema: browserCdpInputSchema,
      examples: [
        {
          input: {
            method: "Runtime.evaluate",
            params: {
              expression: "document.title",
              returnByValue: true,
              awaitPromise: true,
            },
          },
        },
        { input: { method: "Page.captureScreenshot", params: { format: "png" } } },
      ],
      result: "The raw JSON-compatible CDP result, or an image for Page.captureScreenshot.",
      limitations: ["Call browser.enter before using this operation."],
      async execute(input, context) {
        // SAFETY: CakeOperationRegistry parsed this value with browserCdpInputSchema.
        const request = input as BrowserCdpInput;
        const result = await control.cdp(request.method, request.params ?? {}, context.signal);
        if (result.status === "mode-required") return modeRequired();
        if (request.method === "Page.captureScreenshot") {
          const screenshot = Schema.decodeUnknownOption(screenshotResultSchema)(result.value);
          if (Option.isSome(screenshot))
            return cakeOperationImageResult({ captured: true, method: request.method }, [
              {
                type: "image",
                data: screenshot.value.data,
                mimeType: request.params?.format === "jpeg" ? "image/jpeg" : "image/png",
              },
            ]);
        }
        return result.value;
      },
    },
  ];
}
