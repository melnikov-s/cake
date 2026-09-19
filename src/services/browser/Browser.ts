import { Context, Schema, type Effect } from "effect";
import type { JsonObject, JsonValue } from "../../ipc/json-contract";

export interface BrowserState {
  readonly sessionId: string;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly inspecting: boolean;
}

export interface BrowserBounds {
  readonly sessionId: string;
  readonly visible: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type BrowserAction = "back" | "forward" | "reload" | "stop";

export type BrowserActionResult<Value> =
  | { readonly status: "completed"; readonly value: Value }
  | { readonly status: "mode-required" };

export class BrowserError extends Schema.TaggedError<BrowserError>()("BrowserError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface BrowserService {
  readonly open: (
    connectionId: number,
    input: { readonly sessionId: string; readonly url?: string },
  ) => Effect.Effect<BrowserState, BrowserError>;
  readonly state: (sessionId: string) => Effect.Effect<BrowserState, BrowserError>;
  readonly updateBounds: (
    connectionId: number,
    bounds: BrowserBounds,
  ) => Effect.Effect<BrowserState, BrowserError>;
  readonly navigate: (sessionId: string, url: string) => Effect.Effect<BrowserState, BrowserError>;
  readonly action: (
    sessionId: string,
    action: BrowserAction,
  ) => Effect.Effect<BrowserState, BrowserError>;
  readonly inspect: (sessionId: string) => Effect.Effect<BrowserState, BrowserError>;
  readonly enterProjectBrowser: (
    sessionId: string,
    workingDirectory: string,
  ) => Effect.Effect<void, BrowserError>;
  readonly sendProjectCdp: (
    sessionId: string,
    workingDirectory: string,
    method: string,
    params: JsonObject,
  ) => Effect.Effect<BrowserActionResult<JsonValue>, BrowserError>;
  readonly takeProjectCdpEvents: (
    sessionId: string,
    workingDirectory: string,
    methods: ReadonlyArray<string>,
    limit: number,
    clear: boolean,
  ) => Effect.Effect<BrowserActionResult<JsonValue>, BrowserError>;
  readonly closeForWindow: (ownerId: number) => Effect.Effect<void>;
}

/** Owns persistent Chromium views and Chrome DevTools Protocol access. */
export class Browser extends Context.Service<Browser, BrowserService>()(
  "cake/services/browser/Browser",
) {}
