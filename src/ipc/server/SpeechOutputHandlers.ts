import { Effect, Stream } from "effect";
import { ElevenLabsSpeech } from "../../services/speech/ElevenLabsSpeech";
import { SpeechOutputRpc } from "../protocol/SpeechOutputRpc";

export const speechOutputHandlers = SpeechOutputRpc.of({
  "speechOutput.observeSettings": () =>
    Stream.unwrap(Effect.map(ElevenLabsSpeech, (service) => service.observeSettings())),
  "speechOutput.setApiKey": ({ key }) =>
    Effect.flatMap(ElevenLabsSpeech, (service) => service.setApiKey(key)),
  "speechOutput.setVoice": ({ voiceId }) =>
    Effect.flatMap(ElevenLabsSpeech, (service) => service.setVoice(voiceId)),
  "speechOutput.listVoices": () =>
    Effect.flatMap(ElevenLabsSpeech, (service) => service.listVoices()),
  "speechOutput.synthesize": (request) =>
    Stream.unwrap(Effect.map(ElevenLabsSpeech, (service) => service.synthesize(request))),
});
