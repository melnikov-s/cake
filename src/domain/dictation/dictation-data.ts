import { Schema } from "effect";

export const DictationState = Schema.Struct({
  supported: Schema.Boolean,
  status: Schema.Literals(["missing", "installed", "installing", "loading", "ready", "error"]),
  modelPath: Schema.optional(Schema.String),
  managedModelPath: Schema.String,
  engineAvailable: Schema.Boolean,
  message: Schema.optional(Schema.String),
  downloadedBytes: Schema.Number,
  totalBytes: Schema.Number,
});
export interface DictationState extends Schema.Schema.Type<typeof DictationState> {}

/** Bounded mono, 16 kHz, little-endian float32 PCM. Never persisted. */
export const DictationAudio = Schema.Struct({
  utteranceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  pcm: Schema.String.check(Schema.isMaxLength(854_000), Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/)),
  final: Schema.Boolean,
});
export interface DictationAudio extends Schema.Schema.Type<typeof DictationAudio> {}

export class DictationError extends Schema.TaggedError<DictationError>()("DictationError", {
  message: Schema.String,
}) {}
