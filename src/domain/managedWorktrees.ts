import { Effect, Option, Stream } from "effect";
import * as projectSessionLocations from "./projectSessionLocations";
import { defaultProjectSettings } from "./application-data";
import { getState, trustProject } from "./application";
import { generateWorktreeName, utilityModelSelection } from "./utilityWork";
import { PiSessions } from "../services/pi/PiSessions";
import { ProjectAccess } from "../services/projects/ProjectAccess";
import { SessionCatalogChanges } from "../services/session-catalogs/SessionCatalogChanges";
import {
  SessionArchiveStorage,
  type ProjectSessionArchiveMetadata,
  type ProjectSessionArchiveMigrationSource,
} from "../services/storage/SessionArchiveStorage";
import { Terminal } from "../services/terminal/Terminal";
import { ManagedWorktreeError, ManagedWorktrees } from "../services/worktrees/ManagedWorktrees";
import type { ResolvedManagedWorktreeCleanupFailure } from "./managed-worktree-cleanup-data";

const policyError = (operation: string, cause: unknown) =>
  new ManagedWorktreeError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const requireAllowed = Effect.fn("ManagedWorktrees.requireAllowed")(function* (
  workingDirectory: string,
) {
  const access = yield* ProjectAccess;
  if (!(yield* access.isAllowed(workingDirectory)))
    return yield* new ManagedWorktreeError({
      operation: "ManagedWorktrees.requireAllowed",
      message: "Project path was not selected by the user",
    });
});

const requireRecord = Effect.fn("ManagedWorktrees.requireRecord")(function* (
  workingDirectory: string,
  allowedStates: ReadonlySet<"active" | "landed">,
) {
  const service = yield* ManagedWorktrees;
  const record = (yield* service.records()).find((candidate) => {
    const state = candidate.state ?? "active";
    return (
      candidate.worktreePath === workingDirectory &&
      ((state === "active" && allowedStates.has("active")) ||
        (state === "landed" && allowedStates.has("landed")))
    );
  });
  if (!record)
    return yield* new ManagedWorktreeError({
      operation: "ManagedWorktrees.requireRecord",
      message: "Cake could not find that worktree",
    });
  return record;
});

export const create = Effect.fn("ManagedWorktrees.create")(function* (input: {
  readonly projectPath: string;
  readonly baseWorktreePath?: string;
  readonly worktreeName?: string;
  readonly firstUserMessage?: string;
}) {
  yield* requireAllowed(input.projectPath);
  const state = yield* getState();
  let worktreeName = input.worktreeName;
  if (!worktreeName && input.firstUserMessage && state.utilityModel) {
    worktreeName = yield* generateWorktreeName({
      selection: utilityModelSelection(state.utilityModel),
      firstUserMessage: input.firstUserMessage,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)));
  }
  const record = yield* (yield* ManagedWorktrees).create(
    input.projectPath,
    input.baseWorktreePath,
    worktreeName,
    state.projects.find((project) => project.path === input.projectPath)?.settings ??
      defaultProjectSettings(),
  );
  const access = yield* ProjectAccess;
  yield* access
    .allow(record.worktreePath)
    .pipe(Effect.mapError((cause) => policyError("ManagedWorktrees.create", cause)));
  if (state.trustedProjectPaths.includes(record.projectPath))
    yield* trustProject(record.worktreePath).pipe(
      Effect.mapError((cause) => policyError("ManagedWorktrees.create", cause)),
    );
  return record;
});

export const discard = Effect.fn("ManagedWorktrees.discard")(function* (
  workingDirectory: string,
  keepBranch: boolean,
) {
  yield* requireRecord(workingDirectory, new Set(["active", "landed"]));
  yield* (yield* Terminal)
    .closeWorkingDirectory(workingDirectory)
    .pipe(Effect.mapError((cause) => policyError("ManagedWorktrees.discard", cause)));
  yield* (yield* ManagedWorktrees).discard(workingDirectory, keepBranch);
});

const resolvedEntriesForProject = Effect.fn("ManagedWorktrees.resolvedEntriesForProject")(
  function* (projectPath: string) {
    const state = yield* getState();
    const project = state.projects.find((candidate) => candidate.path === projectPath);
    if (!project)
      return yield* new ManagedWorktreeError({
        operation: "ManagedWorktrees.resolvedEntriesForProject",
        message: "Cake could not find that Project",
      });
    yield* requireAllowed(projectPath);
    const archive = yield* SessionArchiveStorage;
    const locations = yield* projectSessionLocations
      .locations({ includeInactive: true })
      .pipe(
        Effect.mapError((cause) =>
          policyError("ManagedWorktrees.resolvedEntriesForProject", cause),
        ),
      );
    const migrationComplete = yield* archive
      .projectMigrationComplete(projectPath)
      .pipe(
        Effect.mapError((cause) =>
          policyError("ManagedWorktrees.resolvedEntriesForProject", cause),
        ),
      );
    const entries = migrationComplete
      ? archive.resolvedProjects(projectPath)
      : archive.migrateProject(
          projectPath,
          project.name,
          locations
            .filter((location) => location.projectPath === projectPath)
            .map((location) => {
              const source: ProjectSessionArchiveMigrationSource = {
                location: {
                  cwd: location.workingDirectory,
                  activeRoot: location.sessionDirectory,
                  resolvedRoot: location.resolvedSessionDirectory,
                },
              };
              if (location.managedWorktree)
                Object.assign(source, {
                  worktreeName: location.managedWorktree.branch.replace(/^agent\//, ""),
                });
              return source;
            }),
        );
    return {
      locations,
      entries: yield* entries.pipe(
        Stream.runCollect,
        Effect.map((items) => Array.from(items)),
        Effect.mapError((cause) =>
          policyError("ManagedWorktrees.resolvedEntriesForProject", cause),
        ),
      ),
    };
  },
);

const activeSessionInWorkingDirectory = Effect.fn(
  "ManagedWorktrees.activeSessionInWorkingDirectory",
)(function* (workingDirectory: string, sessionDirectory: string) {
  return yield* (yield* PiSessions).catalog({ workingDirectory, sessionDirectory }).pipe(
    Stream.runHead,
    Effect.map(Option.isSome),
    Effect.mapError((cause) =>
      policyError("ManagedWorktrees.activeSessionInWorkingDirectory", cause),
    ),
  );
});

const discoverResolvedForProject = Effect.fn("ManagedWorktrees.discoverResolvedForProject")(
  function* (projectPath: string) {
    const worktrees = yield* ManagedWorktrees;
    const { entries, locations } = yield* resolvedEntriesForProject(projectPath);
    const resolvedWorkingDirectories = new Set(entries.map((entry) => entry.workingDirectory));
    const candidates = (yield* worktrees.records()).filter(
      (record) =>
        record.projectPath === projectPath &&
        record.state === "landed" &&
        resolvedWorkingDirectories.has(record.worktreePath),
    );
    const eligible = yield* Effect.forEach(candidates, (record) =>
      Effect.gen(function* () {
        const location = locations.find(
          (candidate) =>
            candidate.projectPath === projectPath &&
            candidate.workingDirectory === record.worktreePath,
        );
        if (!location)
          return yield* new ManagedWorktreeError({
            operation: "ManagedWorktrees.discoverResolvedForProject",
            message: `Cake could not locate Working Directory ${record.worktreePath}`,
          });
        return (yield* activeSessionInWorkingDirectory(
          location.workingDirectory,
          location.sessionDirectory,
        ))
          ? undefined
          : record.worktreePath;
      }),
    );
    return {
      entries,
      locations,
      workingDirectories: eligible.filter(
        (workingDirectory): workingDirectory is string => workingDirectory !== undefined,
      ),
    };
  },
);

/** Authoritatively previews landed Managed Worktrees containing only resolved sessions. */
export const inspectResolvedForProject = Effect.fn("ManagedWorktrees.inspectResolvedForProject")(
  function* (projectPath: string) {
    const discovered = yield* discoverResolvedForProject(projectPath);
    return { projectPath, workingDirectories: discovered.workingDirectories };
  },
);

/**
 * Rediscovers and discards eligible Managed Worktrees sequentially. Per-worktree
 * failures are returned so successful cleanup remains visible and retryable.
 */
export const discardResolvedForProject = Effect.fn("ManagedWorktrees.discardResolvedForProject")(
  function* (projectPath: string) {
    const discovered = yield* discoverResolvedForProject(projectPath);
    const worktrees = yield* ManagedWorktrees;
    const terminals = yield* Terminal;
    const catalogs = yield* SessionCatalogChanges;
    const discardedWorkingDirectories: string[] = [];
    const failures: ResolvedManagedWorktreeCleanupFailure[] = [];
    for (const workingDirectory of discovered.workingDirectories) {
      const outcome = yield* Effect.gen(function* () {
        const currentRecord = (yield* worktrees.records()).find(
          (record) =>
            record.projectPath === projectPath &&
            record.worktreePath === workingDirectory &&
            record.state === "landed",
        );
        const location = discovered.locations.find(
          (candidate) =>
            candidate.projectPath === projectPath &&
            candidate.workingDirectory === workingDirectory,
        );
        if (
          !currentRecord ||
          !location ||
          (yield* activeSessionInWorkingDirectory(
            location.workingDirectory,
            location.sessionDirectory,
          ))
        )
          return yield* new ManagedWorktreeError({
            operation: "ManagedWorktrees.discardResolvedForProject",
            message: "Working Directory is no longer eligible for resolved worktree cleanup",
          });
        const runningProgramCount = yield* terminals.runningProgramCount(workingDirectory);
        if (runningProgramCount > 0)
          return yield* new ManagedWorktreeError({
            operation: "ManagedWorktrees.discardResolvedForProject",
            message: "Running terminal programs require confirmation before cleanup",
          });
        yield* terminals.closeWorkingDirectory(workingDirectory);
        yield* worktrees.discard(workingDirectory, false);
      }).pipe(
        Effect.mapError((cause) =>
          policyError("ManagedWorktrees.discardResolvedForProject", cause),
        ),
        Effect.match({
          onFailure: (error) => ({ _tag: "Failure" as const, error }),
          onSuccess: () => ({ _tag: "Success" as const }),
        }),
      );
      if (outcome._tag === "Failure") {
        failures.push({ workingDirectory, message: outcome.error.message });
        continue;
      }
      discardedWorkingDirectories.push(workingDirectory);
      const entries = discovered.entries.filter(
        (entry: ProjectSessionArchiveMetadata) => entry.workingDirectory === workingDirectory,
      );
      for (const entry of entries)
        yield* catalogs.publish({
          _tag: "ProjectSessionChanged",
          sessionId: entry.sessionId,
          projectPath,
          workingDirectory,
          resolved: true,
        });
    }
    return { projectPath, discardedWorkingDirectories, failures };
  },
);

/** Retires a landed checkout once its final active Project Session has been resolved. */
export const cleanupResolved = Effect.fn("ManagedWorktrees.cleanupResolved")(function* (
  workingDirectory: string,
  sessionDirectory: string,
) {
  const worktrees = yield* ManagedWorktrees;
  const record = (yield* worktrees.records()).find(
    (candidate) => candidate.worktreePath === workingDirectory && candidate.state === "landed",
  );
  if (!record) return;

  const activeSession = yield* (yield* PiSessions)
    .catalog({ workingDirectory, sessionDirectory })
    .pipe(
      Stream.runHead,
      Effect.mapError((cause) => policyError("ManagedWorktrees.cleanupResolved", cause)),
    );
  if (Option.isSome(activeSession)) return;

  yield* (yield* Terminal)
    .closeWorkingDirectory(workingDirectory)
    .pipe(Effect.mapError((cause) => policyError("ManagedWorktrees.cleanupResolved", cause)));
  yield* worktrees.cleanupResolved(workingDirectory);
});

/** Recreates a checkout retired by resolution before its first transcript is restored. */
export const restoreResolved = Effect.fn("ManagedWorktrees.restoreResolved")(function* (
  workingDirectory: string,
) {
  const worktrees = yield* ManagedWorktrees;
  const record = (yield* worktrees.records()).find(
    (candidate) => candidate.worktreePath === workingDirectory && candidate.state === "resolved",
  );
  if (record) yield* worktrees.restoreResolved(workingDirectory);
});
