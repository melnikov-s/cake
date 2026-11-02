import { Effect, Layer } from "effect";
import { makeOptMemoryLive } from "../services/opt-memory/OptMemoryLive";
import { ApplicationState } from "../services/storage/ApplicationState";
import { PiModels } from "../services/pi/PiModels";
import { makePiCallbackExecutor } from "../services/pi/PiCallbackAdapter";
import {
  cakeModelCatalog,
  resolveCakeModelChoice,
} from "../domain/model-presets/cake-model-selection";

/** One shared backend memory owner; every completion resolves the current utility-model policy. */
export const makeAutomationMemoryLive = (stateDirectory: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const application = yield* ApplicationState;
      const models = yield* PiModels;
      const run = makePiCallbackExecutor(yield* Effect.context<never>());
      return makeOptMemoryLive(stateDirectory, {
        summarize: async (input) => {
          const selection = resolveCakeModelChoice(
            { source: "utility" },
            cakeModelCatalog(application.snapshot()),
            undefined,
          );
          return run(
            models.complete({
              selection,
              instructions: input.instructions,
              context: input.context,
              chat: { tools: input.tools ?? [], previous: input.previous ?? [] },
              maximumOutputCharacters: 4_096,
            }),
            { signal: input.signal },
          );
        },
      });
    }),
  );
