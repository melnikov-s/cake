import { Schema } from "effect";

export const TextProcessingMode = Schema.Literals(["raw", "utility"]);
export type TextProcessingMode = typeof TextProcessingMode.Type;

export const DictationState = Schema.Struct({
  supported: Schema.Boolean,
  status: Schema.Literals(["missing", "installed", "installing", "loading", "ready", "error"]),
  modelPath: Schema.optional(Schema.String),
  managedModelPath: Schema.String,
  engineAvailable: Schema.Boolean,
  vocabularyRevision: Schema.Int,
  vocabularyCount: Schema.Int,
  vocabularyInstalled: Schema.Boolean,
  message: Schema.optional(Schema.String),
  downloadedBytes: Schema.Number,
  totalBytes: Schema.Number,
});
export interface DictationState extends Schema.Schema.Type<typeof DictationState> {}

const speechProbabilityThreshold = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(0.05),
  Schema.isLessThanOrEqualTo(0.95),
);
export const SpeechDetectionThresholds = Schema.Struct({
  start: speechProbabilityThreshold,
  continuation: speechProbabilityThreshold,
}).check(Schema.makeFilter((thresholds) => thresholds.continuation <= thresholds.start));
export interface SpeechDetectionThresholds extends Schema.Schema.Type<
  typeof SpeechDetectionThresholds
> {}

export const SpeechRecognitionSettings = Schema.Struct({
  thresholds: SpeechDetectionThresholds,
  minimumSpeechMs: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(100),
    Schema.isLessThanOrEqualTo(1000),
  ),
  prerollMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1000)),
  maximumUtteranceSeconds: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(5),
    Schema.isLessThanOrEqualTo(60),
  ),
});
export interface SpeechRecognitionSettings extends Schema.Schema.Type<
  typeof SpeechRecognitionSettings
> {}

/** Bounded mono, 16 kHz, little-endian float32 PCM. Never persisted.
 * Both input workflows capture shared recognition settings for the utterance. */
export const DictationAudio = Schema.Struct({
  utteranceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  pcm: Schema.String.check(Schema.isMaxLength(854_000), Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/)),
  final: Schema.Boolean,
  settings: Schema.optionalKey(SpeechRecognitionSettings),
});
export interface DictationAudio extends Schema.Schema.Type<typeof DictationAudio> {}

/** One detector frame (at most 256 ms), scoped to a microphone capture generation.
 * Dictation and voice mode supply the same capture-local probability thresholds. */
export const SpeechDetectionAudio = Schema.Struct({
  captureId: DictationAudio.fields.utteranceId,
  pcm: Schema.String.check(Schema.isMaxLength(21_848), Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/)),
  thresholds: Schema.optionalKey(SpeechDetectionThresholds),
});
export interface SpeechDetectionAudio extends Schema.Schema.Type<typeof SpeechDetectionAudio> {}

export class DictationError extends Schema.TaggedError<DictationError>()("DictationError", {
  message: Schema.String,
}) {}
