import { Effect, Layer } from "effect";
import { vi } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { postProcessDictation } from "../../../src/domain/dictation/post-process";
import { fakeApplicationState } from "../../helpers/fakes/applicationState";
import { fakePiModels } from "../../helpers/fakes/piModels";

/** Real shared cleanup policy; only application storage and model I/O are faked. */
export function speechCleanupFixture(minimumCharacters = 280) {
  const complete = vi.fn(() => Effect.succeed('{"text":"Cleaned speech."}'));
  const layer = Layer.merge(
    fakeApplicationState({
      snapshot: () => ({
        ...defaultApplicationState(),
        utilityModel: { provider: "fixture", modelId: "utility", thinkingLevel: "off" },
        dictationCleanupMinimumCharacters: minimumCharacters,
      }),
    }),
    fakePiModels({ complete }),
  );
  return {
    complete,
    postProcess: (text: string, options?: { signal?: AbortSignal }) =>
      Effect.runPromise(postProcessDictation(text).pipe(Effect.provide(layer)), options).then(
        (result) => result.text,
      ),
  };
}
