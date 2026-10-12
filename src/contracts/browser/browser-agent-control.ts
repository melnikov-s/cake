import type { JsonValue, JsonObject } from "../serialization/json-contract";
import type { BrowserActionResult } from "./browser-action-result";

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
