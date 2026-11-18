import { Effect } from "effect";
import { PiModelCatalogError } from "../../contracts/pi/model-data";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { PiModels } from "../../services/pi/PiModels";

export const refreshModelCatalog = Effect.fn("Models.refreshCatalog")(function* () {
  const sessions = yield* CakeSessionRuntimes;
  const models = yield* PiModels;
  // Pi commits provider shards independently. Rehydrate from disk even on
  // failure or caller cancellation, since some shards may already be saved.
  yield* models
    .refreshCatalog()
    .pipe(
      Effect.onExit(() =>
        sessions
          .refreshModels()
          .pipe(
            Effect.mapError(
              (error) => new PiModelCatalogError({ operation: "refresh", message: error.message }),
            ),
          ),
      ),
    );
});
