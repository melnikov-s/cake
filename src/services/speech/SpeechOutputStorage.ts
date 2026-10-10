import { Context, Schema, type Effect } from "effect";
import { SpeechOutputSettings, type SpeechOutputError } from "./speech-output-data";

import { ElevenLabsSpeechSpeed } from "./speech-output-speed";

/** Main-only decrypted values. Never an RPC or renderer contract; key is memory-only here. */
export const StoredSpeechOutputSettings = Schema.Struct({
  apiKey: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096))),
  voiceId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  speed: Schema.optionalKey(ElevenLabsSpeechSpeed),
  voices: Schema.optionalKey(SpeechOutputSettings.fields.voices),
});
export interface StoredSpeechOutputSettings extends Schema.Schema.Type<
  typeof StoredSpeechOutputSettings
> {}

/** Concrete native encrypted-settings boundary, injectable independently of the provider. */
export class SpeechOutputStorage extends Context.Service<
  SpeechOutputStorage,
  {
    readonly load: () => Effect.Effect<StoredSpeechOutputSettings, SpeechOutputError>;
    readonly save: (settings: StoredSpeechOutputSettings) => Effect.Effect<void, SpeechOutputError>;
  }
>()("cake/services/speech/SpeechOutputStorage") {}
