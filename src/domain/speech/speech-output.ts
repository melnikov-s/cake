import { Effect, Stream } from "effect";
import { ElevenLabsSpeech } from "../../services/speech/ElevenLabsSpeech";
import { PocketTts } from "../../services/speech/PocketTts";
import type { SpeechOutputProvider } from "./pocket-tts-data";
import {
  SpeechOutputError,
  type SpeechOutputRequest,
  type SpeechOutputSettings,
} from "./speech-output-data";

const localVoices = [{ id: "alba", name: "Alba" }];

/** Native settings observation joins the two concrete providers, without copying credentials or
 * persisting a second projection. Selecting local never calls ElevenLabs synthesis/voice APIs.
 */
export const observeSettings = () =>
  Stream.unwrap(
    Effect.gen(function* () {
      const cloud = yield* ElevenLabsSpeech;
      const local = yield* PocketTts;
      return Stream.zipLatestWith(
        cloud.observeSettings(),
        local.observeState(),
        (cloudSettings, localModel): SpeechOutputSettings => {
          if (localModel.selected)
            return {
              ...cloudSettings,
              provider: "pocket-tts",
              modelId: "pocket-tts-8bit",
              voiceId: "alba",
              voices: localVoices,
              speed: localModel.speed,
              localModel,
            };
          return { ...cloudSettings, provider: "elevenlabs", localModel };
        },
      );
    }),
  );

export const setProvider = Effect.fn("speechOutput.setProvider")(function* (
  provider: SpeechOutputProvider,
) {
  const local = yield* PocketTts;
  yield* local.select(provider === "pocket-tts");
});
export const setVoice = Effect.fn("speechOutput.setVoice")(function* (voiceId: string) {
  const local = yield* PocketTts;
  if ((yield* local.getState()).selected) {
    if (voiceId !== "alba")
      return yield* new SpeechOutputError({
        kind: "not-configured",
        message: "Pocket TTS currently uses the Alba preset voice.",
      });
    return;
  }
  const cloud = yield* ElevenLabsSpeech;
  yield* cloud.setVoice(voiceId);
});
export const setSpeed = Effect.fn("speechOutput.setSpeed")(function* (speed: number) {
  const local = yield* PocketTts;
  if ((yield* local.getState()).selected) return yield* local.setSpeed(speed);
  const cloud = yield* ElevenLabsSpeech;
  yield* cloud.setSpeed(speed);
});
export const listVoices = Effect.fn("speechOutput.listVoices")(function* () {
  const local = yield* PocketTts;
  if ((yield* local.getState()).selected) return localVoices;
  const cloud = yield* ElevenLabsSpeech;
  return yield* cloud.listVoices();
});
export const synthesize = (request: SpeechOutputRequest) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const local = yield* PocketTts;
      if ((yield* local.getState()).selected) return local.synthesize(request);
      const cloud = yield* ElevenLabsSpeech;
      return cloud.synthesize(request);
    }),
  );
