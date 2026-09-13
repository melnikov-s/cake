import { ManagedRuntime } from "effect";
import type { ProjectSettings } from "../../src/domain/application/application-data";
import type { WorktreeLandRequest } from "../../src/ipc/worktree-contract";
import { BootstrapLive } from "../../src/main/BootstrapLive";
import { makeGitLive } from "../../src/services/git/GitLive";
import { makeWorktreeStorageLive } from "../../src/services/storage/WorktreeStorageLive";
import { ManagedWorktrees } from "../../src/services/worktrees/ManagedWorktrees";
import { ManagedWorktreesLive } from "../../src/services/worktrees/ManagedWorktreesLive";
import { Effect, Layer } from "effect";

/** Test-only imperative harness for real Git integration tests. Production has no Promise facade. */
export const makeTestWorktreeService = (storagePath: string) => {
  const dependencies = Layer.mergeAll(
    BootstrapLive,
    makeGitLive(),
    makeWorktreeStorageLive(storagePath),
  ).pipe(Layer.provide(BootstrapLive));
  const runtime = ManagedRuntime.make(ManagedWorktreesLive.pipe(Layer.provide(dependencies)));
  const run = <A, E>(effect: Effect.Effect<A, E, ManagedWorktrees>) => runtime.runPromise(effect);
  const withService = <A, E>(
    operation: (service: ManagedWorktrees["Service"]) => Effect.Effect<A, E>,
  ) => run(Effect.flatMap(ManagedWorktrees, operation));

  return {
    records: () => withService((service) => service.records()),
    create: (
      projectPath: string,
      baseWorktreePath?: string,
      worktreeName?: string,
      settings?: ProjectSettings,
    ) =>
      withService((service) =>
        service.create(projectPath, baseWorktreePath, worktreeName, settings),
      ),
    createBranchOff: (worktreePath: string, worktreeName?: string) =>
      withService((service) =>
        service.records().pipe(
          Effect.flatMap((records) => {
            const source = records.find((record) => record.worktreePath === worktreePath);
            return source
              ? service.create(source.projectPath, source.worktreePath, worktreeName)
              : Effect.fail(new Error("Cake could not find that worktree"));
          }),
        ),
      ),
    status: (worktreePath: string) => withService((service) => service.status(worktreePath)),
    land: (
      worktreePath: string,
      options: { readonly request: WorktreeLandRequest; readonly operationId?: string },
    ) =>
      withService((service) =>
        service.land(
          worktreePath,
          options.operationId ?? `direct:${worktreePath}`,
          options.request,
        ),
      ),
    rebase: (worktreePath: string) => withService((service) => service.rebase(worktreePath)),
    discard: (worktreePath: string, keepBranch: boolean) =>
      withService((service) => service.discard(worktreePath, keepBranch)),
    cleanupResolved: (worktreePath: string) =>
      withService((service) => service.cleanupResolved(worktreePath)),
    restoreResolved: (worktreePath: string) =>
      withService((service) => service.restoreResolved(worktreePath)),
    proposeSquashMessage: (input: {
      readonly workspacePath: string;
      readonly subject: string;
      readonly body?: string;
    }) => withService((service) => service.proposeSquashMessage(input)),
    dispose: () => runtime.dispose(),
  };
};

export type TestWorktreeService = ReturnType<typeof makeTestWorktreeService>;
