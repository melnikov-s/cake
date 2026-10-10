import { Context, type Effect, Schema } from "effect";
import { SpeechOutputError } from "./speech-output-data";

/** Metadata only: no credentials, text, voice IDs, response bodies or audio. */
export const SpeechOutputDiagnostic = Schema.Struct({
  timestampMillis: Schema.Number,
  elapsedMillis: Schema.Number,
  reason: Schema.Literals([
    "request-failed",
    "unexpected-content-type",
    "empty-stream",
    "incomplete-sample",
  ]),
  errorKind: SpeechOutputError.fields.kind,
  httpStatus: Schema.optionalKey(Schema.Number),
  contentType: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(128), Schema.isPattern(/^[a-z0-9!#$&^_.+/-]+$/)),
  ),
  providerRequestId: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(128), Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
  ),
  receivedChunks: Schema.Number,
  receivedBytes: Schema.Number,
  largestChunkBytes: Schema.Number,
  emittedBytes: Schema.Number,
  danglingSampleByte: Schema.Boolean,
});
export interface SpeechOutputDiagnostic extends Schema.Schema.Type<typeof SpeechOutputDiagnostic> {}

/** Best-effort, native-main diagnostic persistence; never prevents speech or retries it. */
export class SpeechOutputDiagnostics extends Context.Service<
  SpeechOutputDiagnostics,
  {
    readonly record: (diagnostic: SpeechOutputDiagnostic) => Effect.Effect<void>;
  }
>()("cake/services/speech/SpeechOutputDiagnostics") {}
