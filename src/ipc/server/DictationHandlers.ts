import { Effect, Stream } from "effect";
import { Dictation } from "../../services/dictation/Dictation";
import { DictationRpc } from "../protocol/DictationRpc";

export const dictationHandlers = DictationRpc.of({
  "dictation.observeState": () =>
    Stream.unwrap(Effect.map(Dictation, (service) => service.observeState())),
  "dictation.install": () => Effect.flatMap(Dictation, (service) => service.install()),
  "dictation.setModelPath": ({ path }) =>
    Effect.flatMap(Dictation, (service) => service.setModelPath(path)),
  "dictation.remove": () => Effect.flatMap(Dictation, (service) => service.remove()),
  "dictation.prepare": () => Effect.flatMap(Dictation, (service) => service.prepare()),
  "dictation.release": () => Effect.flatMap(Dictation, (service) => service.release()),
  "dictation.transcribe": (audio) =>
    Effect.flatMap(Dictation, (service) => service.transcribe(audio)),
});
