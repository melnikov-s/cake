import { Schema } from "effect";

/** Local tempo range; RPC accepts this envelope and the selected provider validates its limit. */
export const SpeechOutputSpeed = Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 2 }));
export const ElevenLabsSpeechSpeed = Schema.Number.check(
  Schema.isBetween({ minimum: 1, maximum: 1.2 }),
);
