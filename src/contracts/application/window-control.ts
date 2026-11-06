import { Schema } from "effect";
import { AgentActionNotice } from "./agent-action-notice";

export const WindowControlRequest = Schema.Struct({
  controlRequestId: Schema.String,
  invocation: Schema.Struct({ name: Schema.String, arguments: Schema.Json }),
  source: Schema.optionalKey(AgentActionNotice.fields.source),
});
export interface WindowControlRequest extends Schema.Schema.Type<typeof WindowControlRequest> {}

export const WindowControlResponse = Schema.Union([
  Schema.Struct({ handled: Schema.Literal(false) }),
  Schema.Struct({ handled: Schema.Literal(true), result: Schema.Json }),
]);
export type WindowControlResponse = Schema.Schema.Type<typeof WindowControlResponse>;
