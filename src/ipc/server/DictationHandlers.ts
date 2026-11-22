import { Effect, Option, Stream } from "effect";
import { DictationError } from "../../contracts/dictation/dictation-data";
import { Dictation } from "../../services/dictation/Dictation";
import { DictationRpc } from "../protocol/DictationRpc";
import { RendererDocumentLifetime } from "../protocol/RendererConnectionMiddleware";

export const dictationHandlers = DictationRpc.of({
  "dictation.listVocabulary": (input) =>
    Effect.flatMap(Dictation, (service) => service.listVocabulary(input)),
  "dictation.changeVocabulary": (input) =>
    Effect.flatMap(Dictation, (service) => service.changeVocabulary(input)),
  "dictation.installVocabulary": () =>
    Effect.flatMap(Dictation, (service) => service.installVocabulary()),
  "dictation.observeState": () =>
    Stream.unwrap(Effect.map(Dictation, (service) => service.observeState())),
  "dictation.install": () => Effect.flatMap(Dictation, (service) => service.install()),
  "dictation.setModelPath": ({ path }) =>
    Effect.flatMap(Dictation, (service) => service.setModelPath(path)),
  "dictation.remove": () => Effect.flatMap(Dictation, (service) => service.remove()),
  "dictation.prepare": () => Effect.flatMap(Dictation, (service) => service.prepare()),
  "dictation.prepareSpeaker": () =>
    Effect.gen(function* () {
      const service = yield* Dictation;
      const document = Option.getOrUndefined(yield* Effect.serviceOption(RendererDocumentLifetime));
      if (!document) return yield* service.prepareSpeaker();
      const stopped = new DictationError({ code: "stopped", message: "Dictation stopped" });
      if (document.aborted) return yield* stopped;
      // Navigating or crashing can lose the renderer before it sends an RPC interrupt.
      const abandoned = Effect.callback<never, DictationError>((resume) => {
        const abort = () => resume(Effect.fail(stopped));
        if (document.aborted) abort();
        else document.addEventListener("abort", abort, { once: true });
        return Effect.sync(() => document.removeEventListener("abort", abort));
      });
      return yield* Effect.raceFirst(service.prepareSpeaker(), abandoned);
    }),
  "dictation.release": () => Effect.flatMap(Dictation, (service) => service.release()),
  "dictation.claim": ({ owner }) => Effect.flatMap(Dictation, (service) => service.claim(owner)),
  "dictation.setMuted": ({ muted }) =>
    Effect.flatMap(Dictation, (service) => service.setMuted(muted)),
  // Renderer startup breadcrumbs belong in the desktop log beside the engine's own lines.
  "dictation.trace": (trace) =>
    trace.step === "failed"
      ? Effect.logWarning("Dictation step", trace)
      : Effect.logInfo("Dictation step", trace),
  "dictation.detectSpeech": (audio) =>
    Effect.flatMap(Dictation, (service) => service.detectSpeech(audio)),
  "dictation.endRound": ({ speakerRoundId }) =>
    Effect.flatMap(Dictation, (service) => service.endRound(speakerRoundId)),
  "dictation.transcribe": (audio) =>
    Effect.gen(function* () {
      const service = yield* Dictation;
      const document = yield* Effect.serviceOption(RendererDocumentLifetime);
      return yield* service.transcribe(audio, Option.getOrUndefined(document));
    }),
});
