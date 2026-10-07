import { Schema } from "effect";
import { PocketTtsState, SpeechOutputProvider } from "./pocket-tts-data";

const voiceId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

export const SpeechOutputSpeed = Schema.Number.check(
  Schema.isBetween({ minimum: 1, maximum: 1.2 }),
);

export const SpeechOutputVoice = Schema.Struct({
  id: voiceId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
});
export interface SpeechOutputVoice extends Schema.Schema.Type<typeof SpeechOutputVoice> {}

/** Main-owned, secret-free settings projection. The API key never comes back over RPC. */
export const ElevenLabsSpeechSettings = Schema.Struct({
  keyConfigured: Schema.Boolean,
  voiceId: Schema.optionalKey(voiceId),
  modelId: Schema.Literal("eleven_flash_v2_5"),
  speed: SpeechOutputSpeed,
  voices: Schema.Array(SpeechOutputVoice).check(Schema.isMaxLength(1_000)),
});
export interface ElevenLabsSpeechSettings extends Schema.Schema.Type<
  typeof ElevenLabsSpeechSettings
> {}

/** One coherent native settings projection: selected provider and actual local installation state.
 * Existing ElevenLabs credentials/voice preferences are preserved when selecting local output.
 */
export const SpeechOutputSettings = ElevenLabsSpeechSettings.pipe(
  Schema.fieldsAssign({
    provider: SpeechOutputProvider,
    modelId: Schema.Literals(["eleven_flash_v2_5", "pocket-tts-8bit"]),
    localModel: PocketTtsState,
  }),
);
export interface SpeechOutputSettings extends Schema.Schema.Type<typeof SpeechOutputSettings> {}

/** One bounded plain-language phrase. No provider override, credentials, or microphone audio. */
export const SpeechOutputRequest = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
});
export interface SpeechOutputRequest extends Schema.Schema.Type<typeof SpeechOutputRequest> {}

/** Ordered, bounded, mono signed 16-bit little-endian PCM. Never persisted.
 * Main aligns chunks to complete samples; renderer validates decoded size before scheduling.
 */
export const SpeechOutputAudio = Schema.Struct({
  encoding: Schema.Literal("pcm_s16le"),
  sampleRate: Schema.Literal(24_000),
  pcm: Schema.String.check(
    Schema.isMinLength(4),
    Schema.isMaxLength(87_384),
    Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/),
  ),
});
export interface SpeechOutputAudio extends Schema.Schema.Type<typeof SpeechOutputAudio> {}

export class SpeechOutputError extends Schema.TaggedError<SpeechOutputError>()(
  "SpeechOutputError",
  {
    kind: Schema.Literals([
      "not-configured",
      "authentication",
      "quota",
      "rate-limit",
      "network",
      "provider",
      "invalid-audio",
      "storage",
    ]),
    message: Schema.String,
  },
) {}
