import type { JsonValue } from "../serialization/json-contract";

/** Cake-owned scalar projection of a tool caller; no SDK objects escape the adapter. */
export interface CakeOperationRuntime {
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly entryId?: string;
  readonly assistantEntryId?: string;
  readonly model?: { readonly provider: string; readonly id: string };
}

/** Session-bound transcript capabilities implemented by the engine adapter. */
export interface CakeOperationHost {
  appendEntry(type: string, data: JsonValue): void;
  on?(
    event: "before_agent_start",
    handler: (event: {
      readonly systemPrompt: string;
    }) =>
      | void
      | { readonly systemPrompt: string }
      | Promise<void | { readonly systemPrompt: string }>,
  ): void;
}
