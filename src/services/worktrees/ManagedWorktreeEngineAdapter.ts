import { Effect } from "effect";
import { Git } from "../git/Git";
import { WorktreeStorage } from "../storage/WorktreeStorage";
import { ManagedWorktreeEngine } from "./ManagedWorktreeEngine";

/** Final Promise adapter for the imperative engine; Cake-owned Services stay Effect-native. */
export const makeManagedWorktreeEngineAdapter = Effect.gen(function* () {
  const git = yield* Git;
  const storage = yield* WorktreeStorage;
  const context = yield* Effect.context<Git | WorktreeStorage>();
  const run = Effect.runPromiseWith(context);
  return new ManagedWorktreeEngine(
    {
      load: () => run(storage.load()),
      save: (records) => run(storage.save(records)),
    },
    (workingDirectory, arguments_) => run(git.run(workingDirectory, arguments_)),
  );
});
