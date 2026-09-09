import { Effect } from "effect";
import { findSessionFile, forkWorkspaceSession } from "../../services/pi/runtime/session-discovery";
import { ProjectAccess } from "../../services/projects/ProjectAccess";
import { ProjectSessionConfiguration } from "../../services/project-sessions/ProjectSessionConfiguration";
import { ApplicationState } from "../../services/storage/ApplicationState";
import {
  SessionArchiveStorage,
  type ProjectSessionArchiveContext,
} from "../../services/storage/SessionArchiveStorage";
import { ManagedWorktrees } from "../../services/worktrees/ManagedWorktrees";
import type { ProjectSessionLocation } from "./project-session-data";

export const locations = Effect.fn("ProjectSessions.locations")(function* (options?: {
  readonly includeInactive?: boolean;
}) {
  const application = yield* ApplicationState;
  const configuration = yield* ProjectSessionConfiguration;
  const worktrees = yield* ManagedWorktrees;
  const records = yield* worktrees.records();
  const state = application.snapshot();
  return [
    ...state.projects.map<ProjectSessionLocation>((project) => ({
      projectPath: project.path,
      projectName: project.name,
      workingDirectory: project.path,
      sessionDirectory: configuration.sessionDirectory,
      resolvedSessionDirectory: configuration.resolvedSessionDirectory,
    })),
    ...records
      .filter(
        (record) =>
          options?.includeInactive || ["active", "landed"].includes(record.state ?? "active"),
      )
      .flatMap<ProjectSessionLocation>((record) => {
        const project = state.projects.find((item) => item.path === record.projectPath);
        return project
          ? [
              {
                projectPath: project.path,
                projectName: project.name,
                workingDirectory: record.worktreePath,
                sessionDirectory: configuration.sessionDirectory,
                resolvedSessionDirectory: configuration.resolvedSessionDirectory,
                managedWorktree: record,
              },
            ]
          : [];
      }),
  ] satisfies ReadonlyArray<ProjectSessionLocation>;
});

export const archive = Effect.fn("ProjectSessions.archive")(function* (
  sessionId: string,
  location: ProjectSessionLocation,
) {
  const storage = yield* SessionArchiveStorage;
  const archiveContext: ProjectSessionArchiveContext = {
    projectPath: location.projectPath,
    projectName: location.projectName,
  };
  const worktreeName =
    location.managedWorktree?.branch.replace(/^agent\//, "") ?? location.worktreeName;
  yield* storage.resolveProject(
    sessionId,
    {
      cwd: location.workingDirectory,
      activeRoot: location.sessionDirectory,
      resolvedRoot: location.resolvedSessionDirectory,
    },
    worktreeName ? { ...archiveContext, worktreeName } : archiveContext,
  );
});

export const restore = Effect.fn("ProjectSessions.restoreLocation")(function* (
  sessionId: string,
  location: ProjectSessionLocation,
) {
  const storage = yield* SessionArchiveStorage;
  const restored = yield* storage.restoreProject(sessionId);
  if (!restored) return location;
  const restoredLocation: ProjectSessionLocation = {
    projectPath: restored.projectPath,
    projectName: restored.projectName,
    workingDirectory: restored.workingDirectory,
    sessionDirectory: restored.activeRoot,
    resolvedSessionDirectory: restored.resolvedRoot,
  };
  if (restored.worktreeName !== undefined)
    Object.assign(restoredLocation, { worktreeName: restored.worktreeName });
  return restoredLocation;
});

export const forkToWorkingDirectory = Effect.fn("ProjectSessions.forkToWorkingDirectory")(
  function* (input: {
    readonly sessionId: string;
    readonly entryId: string;
    readonly title: string;
    readonly source: ProjectSessionLocation;
    readonly destination: ProjectSessionLocation;
  }) {
    const access = yield* ProjectAccess;
    const configuration = yield* ProjectSessionConfiguration;
    const sourceFile = yield* Effect.tryPromise({
      try: () =>
        findSessionFile(
          input.source.workingDirectory,
          input.sessionId,
          configuration.sessionDirectory,
        ),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
    if (!sourceFile)
      return yield* Effect.fail(new Error("Cake could not find the Project Session to fork"));
    const forked = yield* Effect.try({
      try: () =>
        forkWorkspaceSession(
          sourceFile,
          input.destination.workingDirectory,
          configuration.sessionDirectory,
          input.title,
        ),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
    yield* access.rememberSessionLocation(input.destination.workingDirectory, forked.sessionId);
    return forked.sessionId;
  },
);
