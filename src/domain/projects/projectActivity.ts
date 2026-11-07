import { Effect, Schema, Stream, SubscriptionRef } from "effect";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import { SubagentCoordinator } from "../../services/subagents/SubagentCoordinator";
import { ManagedWorktrees } from "../../services/worktrees/ManagedWorktrees";

const samePaths = Schema.toEquivalence(Schema.Array(Schema.String));

/** Project dots follow live work, without discovering every saved session's descendants. */
export const observeProjectActivity = Effect.fn("Projects.observeActivity")(function* () {
  const application = yield* ApplicationState;
  const sessions = yield* CakeSessionRuntimes;
  const changes = yield* SessionCatalogChanges;
  const workers = yield* SubagentCoordinator;
  const worktrees = yield* ManagedWorktrees;
  return Stream.mergeAll(
    [
      changes.initialThenChanges(Stream.empty).pipe(
        Stream.filter(
          (event) => event._tag.endsWith("ActivityChanged") || event._tag.startsWith("CakeChat"),
        ),
        Stream.map(() => undefined),
      ),
      SubscriptionRef.changes(workers.state).pipe(
        Stream.map((state) =>
          [
            ...new Set(
              [...state.handles.values()]
                .filter((handle) => handle.status === "queued" || handle.status === "running")
                .map((handle) => handle.projectPath ?? handle.workingDirectory),
            ),
          ].sort(),
        ),
        Stream.changesWith(samePaths),
        Stream.map(() => undefined),
      ),
      application.changes().pipe(
        Stream.map((projection) => projection.state.projects.map((project) => project.path)),
        Stream.changesWith(samePaths),
        Stream.map(() => undefined),
      ),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Stream.mapEffect(() =>
      Effect.gen(function* () {
        const projectPaths = new Set(
          application.snapshot().projects.map((project) => project.path),
        );
        const managed = new Map(
          (yield* worktrees.records()).map((record) => [record.worktreePath, record.projectPath]),
        );
        const active = new Set<string>();
        const add = (directory: string) => {
          const project = managed.get(directory) ?? directory;
          if (projectPaths.has(project)) active.add(project);
        };
        for (const directory of yield* sessions.activeWorkingDirectories()) add(directory);
        for (const handle of (yield* SubscriptionRef.get(workers.state)).handles.values())
          if (handle.status === "queued" || handle.status === "running")
            add(handle.projectPath ?? handle.workingDirectory);
        return [...active].sort();
      }),
    ),
    Stream.changesWith(samePaths),
  );
});
