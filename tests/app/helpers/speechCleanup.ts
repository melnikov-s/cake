import { Effect, Layer } from "effect";
import { vi } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { postProcessDictation } from "../../../src/domain/dictation/post-process";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { PiModels } from "../../../src/services/pi/PiModels";

/** Real shared cleanup policy; only application storage and model I/O are faked. */
export function speechCleanupFixture(minimumCharacters = 280) {
  const complete = vi.fn(() => Effect.succeed('{"text":"Cleaned speech."}'));
  const layer = Layer.merge(
    Layer.mock(ApplicationState, {
      snapshot: () => ({
        ...defaultApplicationState(),
        utilityModel: { provider: "fixture", modelId: "utility", thinkingLevel: "off" },
        dictationCleanupMinimumCharacters: minimumCharacters,
      }),
    }),
    Layer.mock(PiModels, { complete }),
  );
  return {
    complete,
    postProcess: (text: string, options?: { signal?: AbortSignal }) =>
      Effect.runPromise(postProcessDictation(text).pipe(Effect.provide(layer)), options).then(
        (result) => result.text,
      ),
  };
}
