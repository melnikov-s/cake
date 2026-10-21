import { Effect, Layer } from "effect";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { upsertProject } from "../../../src/domain/application/application";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";

/** Real serialized application authority; only persistence is replaced. */
export const projectTodoLayer = () =>
  Layer.effectContext(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        ApplicationState.layer.pipe(
          Layer.provide(
            Layer.succeed(
              ApplicationStorage,
              ApplicationStorage.of({
                load: () => Effect.succeed({ state: defaultApplicationState(), source: "current" }),
                save: () => Effect.void,
              }),
            ),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        yield* upsertProject("/project", "Project");
        yield* (yield* ApplicationState).transact((state) =>
          Effect.succeed({ ...state, trustedProjectPaths: ["/project"] }),
        );
      }).pipe(Effect.provide(context));
      return context;
    }),
  );
