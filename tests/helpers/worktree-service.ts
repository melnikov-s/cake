import { ManagedRuntime } from "effect";
import { createCheckout } from "../../src/domain/worktrees/worktreeCreation";
import type { ProjectSettings } from "../../src/contracts/application/application-data";
import type { WorktreeLandRequest } from "../../src/contracts/worktrees/worktree-contract";
import { BootstrapLive } from "../../src/main/BootstrapLive";
import { makeGitLive } from "../../src/services/git/GitLive";
import { makeWorktreeStorageLive } from "../../src/services/storage/WorktreeStorageLive";
import { ManagedWorktrees } from "../../src/services/worktrees/ManagedWorktrees";
import { ManagedWorktreesLive } from "../../src/services/worktrees/ManagedWorktreesLive";
import { makeWorktreeCommandsLive } from "../../src/services/worktrees/WorktreeCommandsLive";
import { lifecycleFromSettings } from "../../src/domain/worktrees/worktreeLifecycle";
import { Effect, Layer } from "effect";
import { dirname, join } from "node:path";

/** Test-only imperative harness for real Git integration tests. Production has no Promise facade. */
export const makeTestWorktreeService = (
  storagePath: string,
  /** Lifecycle commands used by removal and restore, as a Project's settings would supply. */
  settings?: ProjectSettings,
) => {
  const lifecycle = settings ? lifecycleFromSettings(settings) : {};
  const dependencies = Layer.mergeAll(
    BootstrapLive,
    makeGitLive(),
    makeWorktreeStorageLive(storagePath),
    makeWorktreeCommandsLive(join(dirname(storagePath), "worktree-logs")),
  ).pipe(Layer.provide(BootstrapLive));
  const runtime = ManagedRuntime.make(ManagedWorktreesLive.pipe(Layer.provide(dependencies)));
  const run = <A, E>(effect: Effect.Effect<A, E, ManagedWorktrees>) => runtime.runPromise(effect);
  const withService = <A, E>(
    operation: (service: ManagedWorktrees["Service"]) => Effect.Effect<A, E, ManagedWorktrees>,
  ) => run(Effect.flatMap(ManagedWorktrees, operation));

  return {
    records: () => withService((service) => service.records()),
    create: (
      projectPath: string,
      baseWorktreePath?: string,
      worktreeName?: string,
      settings?: ProjectSettings,
    ) => run(createCheckout(projectPath, baseWorktreePath, worktreeName, settings)),
    createBranchOff: (worktreePath: string, worktreeName?: string) =>
      withService((service) =>
        service.records().pipe(
          Effect.flatMap((records) => {
            const source = records.find((record) => record.worktreePath === worktreePath);
            return source
              ? createCheckout(source.projectPath, source.worktreePath, worktreeName)
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
      withService((service) => service.discard(worktreePath, keepBranch, lifecycle)),
    cleanupResolved: (worktreePath: string, options?: { readonly retireActive?: boolean }) =>
      withService((service) =>
        service.cleanupResolved(worktreePath, {
          lifecycle,
          retireActive: options?.retireActive ?? false,
        }),
      ),
    restoreResolved: (worktreePath: string) =>
      withService((service) => service.restoreResolved(worktreePath, lifecycle)),
    proposeSquashMessage: (input: {
      readonly workspacePath: string;
      readonly subject: string;
      readonly body?: string;
    }) => withService((service) => service.proposeSquashMessage(input)),
    dispose: () => runtime.dispose(),
  };
};

export type TestWorktreeService = ReturnType<typeof makeTestWorktreeService>;
