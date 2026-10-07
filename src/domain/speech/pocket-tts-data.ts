import { Schema } from "effect";

/** Native desktop authority; model bytes and installation selection live in desktop-private storage.
 * Download progress and availability are process-lifetime facts, not renderer preferences.
 */
export const PocketTtsState = Schema.Struct({
  supported: Schema.Boolean,
  engineAvailable: Schema.Boolean,
  selected: Schema.Boolean,
  installed: Schema.Boolean,
  installing: Schema.Boolean,
  downloadedBytes: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  totalBytes: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  message: Schema.optionalKey(Schema.String),
});
export interface PocketTtsState extends Schema.Schema.Type<typeof PocketTtsState> {}

export const SpeechOutputProvider = Schema.Literals(["elevenlabs", "pocket-tts"]);
export type SpeechOutputProvider = Schema.Schema.Type<typeof SpeechOutputProvider>;
