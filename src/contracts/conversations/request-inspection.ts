import { Schema } from "effect";

export const RequestInspectionEntry = Schema.Struct({
  id: Schema.String,
  callId: Schema.String,
  sessionId: Schema.String,
  capturedAt: Schema.String,
  provider: Schema.String,
  modelId: Schema.String,
  api: Schema.String,
  purpose: Schema.Literals(["coordinator", "memory-summary"]),
  boundary: Schema.Literals(["http-body", "provider-payload"]),
  state: Schema.Literals(["assembled", "sent", "completed", "failed"]),
  attempt: Schema.Int,
  byteSize: Schema.Int,
  status: Schema.optionalKey(Schema.Int),
  limitation: Schema.optionalKey(Schema.String),
  settings: Schema.String,
});
export interface RequestInspectionEntry extends Schema.Schema.Type<typeof RequestInspectionEntry> {}

export const RequestInspectionPayload = Schema.Struct({
  entry: RequestInspectionEntry,
  raw: Schema.optionalKey(Schema.String),
});
export interface RequestInspectionPayload extends Schema.Schema.Type<
  typeof RequestInspectionPayload
> {}

export const RequestInspectionHistory = Schema.Struct({
  entries: Schema.Array(RequestInspectionEntry),
  evicted: Schema.Int,
  maxEntries: Schema.Int,
  maxBytes: Schema.Int,
});
export interface RequestInspectionHistory extends Schema.Schema.Type<
  typeof RequestInspectionHistory
> {}

export interface RequestInspectionResult {
  readonly history: RequestInspectionHistory;
  readonly payload?: RequestInspectionPayload;
}
/** Erase schema implementation depth at the large RPC union, retaining exact decoded types. */
export const RequestInspectionResult: Schema.Codec<RequestInspectionResult> = Schema.Struct({
  history: RequestInspectionHistory,
  payload: Schema.optionalKey(RequestInspectionPayload),
});
