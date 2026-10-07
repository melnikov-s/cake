import { Effect } from "effect";
import * as speechOutput from "../../domain/speech/speech-output";
import { PocketTts } from "../../services/speech/PocketTts";
import { ElevenLabsSpeech } from "../../services/speech/ElevenLabsSpeech";
import { SpeechOutputRpc } from "../protocol/SpeechOutputRpc";

export const speechOutputHandlers = SpeechOutputRpc.of({
  "speechOutput.observeSettings": () => speechOutput.observeSettings(),
  "speechOutput.setProvider": ({ provider }) => speechOutput.setProvider(provider),
  "speechOutput.installLocal": () => Effect.flatMap(PocketTts, (service) => service.install()),
  "speechOutput.removeLocal": () => Effect.flatMap(PocketTts, (service) => service.remove()),
  "speechOutput.setApiKey": ({ key }) =>
    Effect.flatMap(ElevenLabsSpeech, (service) => service.setApiKey(key)),
  "speechOutput.setVoice": ({ voiceId }) => speechOutput.setVoice(voiceId),
  "speechOutput.setSpeed": ({ speed }) => speechOutput.setSpeed(speed),
  "speechOutput.listVoices": () => speechOutput.listVoices(),
  "speechOutput.synthesize": (request) => speechOutput.synthesize(request),
});
