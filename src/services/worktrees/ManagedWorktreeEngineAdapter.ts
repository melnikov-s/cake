import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Git } from "../git/Git";
import { WorktreeStorage } from "../storage/WorktreeStorage";
import { ManagedWorktreeEngine } from "./ManagedWorktreeEngine";

/** Final Promise adapter for the imperative engine; Cake-owned Services stay Effect-native. */
export const makeManagedWorktreeEngineAdapter = Effect.gen(function* () {
  const git = yield* Git;
  const storage = yield* WorktreeStorage;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const context = yield* Effect.context<
    Git | WorktreeStorage | ChildProcessSpawner.ChildProcessSpawner
  >();
  const run = Effect.runPromiseWith(context);
  return new ManagedWorktreeEngine(
    {
      load: () => run(storage.load()),
      save: (records) => run(storage.save(records)),
    },
    (workingDirectory, arguments_) => run(git.run(workingDirectory, arguments_)),
    (workingDirectory, script) =>
      run(
        spawner
          .string(
            ChildProcess.make("/bin/sh", ["-lc", `set -e\n${script}`], {
              cwd: workingDirectory,
            }),
          )
          .pipe(Effect.asVoid, Effect.scoped),
      ),
  );
});
