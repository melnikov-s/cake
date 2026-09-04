import { Effect, Layer } from "effect";
import { makeSubagentControl } from "../domain/subagentControl";
import { findSessionFile, forkWorkspaceSession } from "../services/pi/runtime/session-discovery";
import type { PiSessions } from "../services/pi/PiSessions";
import type { PiSessionAcquireOptions } from "../services/pi/PiSessions";
import { ProjectSessionIntegrations } from "../services/pi/ProjectSessionIntegrations";
import { ProjectSessionRuntimeOptions } from "../services/pi/ProjectSessionRuntimeOptions";
import { ProjectAccess } from "../services/projects/ProjectAccess";
import { ApplicationState } from "../services/storage/ApplicationState";
import {
  SessionArchiveStorage,
  type ProjectSessionArchiveContext,
} from "../services/storage/SessionArchiveStorage";
import type { SubagentCoordinator } from "../services/subagents/SubagentCoordinator";
import type { SubagentEnvironment } from "../services/subagents/SubagentEnvironment";
import { ManagedWorktrees } from "../services/worktrees/ManagedWorktrees";
import type {
  ProjectSessionEnvironment,
  ProjectSessionLocation,
} from "../services/project-sessions/ProjectSessionEnvironment";
import {
  makeProjectSessionEnvironmentLayer,
  ProjectSessionEnvironmentError,
} from "../services/project-sessions/ProjectSessionEnvironment";

export interface ProjectSessionEnvironmentLiveOptions {
  readonly agentDirectory: string;
  readonly sessionDirectory: string;
  readonly resolvedSessionDirectory: string;
}

const environmentError = (operation: string, cause: unknown) =>
  new ProjectSessionEnvironmentError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const makeProjectSessionEnvironmentLive = (
  options: ProjectSessionEnvironmentLiveOptions,
): Layer.Layer<
  ProjectSessionEnvironment,
  never,
  | ApplicationState
  | ManagedWorktrees
  | PiSessions
  | ProjectAccess
  | ProjectSessionIntegrations
  | ProjectSessionRuntimeOptions
  | SessionArchiveStorage
  | SubagentCoordinator
  | SubagentEnvironment
> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const access = yield* ProjectAccess;
      const application = yield* ApplicationState;
      const archive = yield* SessionArchiveStorage;
      const integrations = yield* ProjectSessionIntegrations;
      const projectRuntime = yield* ProjectSessionRuntimeOptions;
      const worktrees = yield* ManagedWorktrees;
      const context = yield* Effect.context<
        ApplicationState | PiSessions | SubagentCoordinator | SubagentEnvironment
      >();
      const run = Effect.runPromiseWith(context);
      const agentControl = makeSubagentControl({
        runEffect: (effect, signal) => run(effect, { signal }),
      });
      return makeProjectSessionEnvironmentLayer({
        locations: Effect.fn("ProjectSessionEnvironment.locations")(function* (locationOptions) {
          const records = yield* worktrees
            .records()
            .pipe(Effect.mapError((cause) => environmentError("locations", cause)));
          const state = application.snapshot();
          return [
            ...state.projects.map((project) => ({
              projectPath: project.path,
              projectName: project.name,
              workingDirectory: project.path,
              sessionDirectory: options.sessionDirectory,
              resolvedSessionDirectory: options.resolvedSessionDirectory,
            })),
            ...records
              .filter(
                (record) =>
                  locationOptions?.includeInactive ||
                  ["active", "landed"].includes(record.state ?? "active"),
              )
              .flatMap((record) => {
                const project = state.projects.find((item) => item.path === record.projectPath);
                return project
                  ? [
                      {
                        projectPath: project.path,
                        projectName: project.name,
                        workingDirectory: record.worktreePath,
                        sessionDirectory: options.sessionDirectory,
                        resolvedSessionDirectory: options.resolvedSessionDirectory,
                        managedWorktree: record,
                      },
                    ]
                  : [];
              }),
          ];
        }),
        runtimeOptions: Effect.fn("ProjectSessionEnvironment.runtimeOptions")(function* ({
          location,
          sessionId,
          newSession,
        }) {
          yield* access
            .rememberSessionLocation(location.workingDirectory, sessionId)
            .pipe(Effect.mapError((cause) => environmentError("runtimeOptions", cause)));
          const runtimeIntegrations = yield* integrations
            .projectSessionRuntimeIntegrations(location.workingDirectory, sessionId)
            .pipe(Effect.mapError((cause) => environmentError("runtimeOptions", cause)));
          const base = projectRuntime.forWorkingDirectory(location.workingDirectory);
          const getRuntimeOptions = () => runtimeOptions;
          const runtimeOptions: PiSessionAcquireOptions = {
            profile: { _tag: "ProjectSession" },
            onRelease: integrations.releaseSession(sessionId),
            runtime: {
              ...runtimeIntegrations,
              agentControl: agentControl(getRuntimeOptions, location.workingDirectory),
              cwd: location.workingDirectory,
              trusted: base.isTrusted?.() ?? false,
              agentDir: base.agentDir,
              sessionDir: base.sessionDir,
              resolvedSessionDir: base.resolvedSessionDir,
              newSession,
              sessionId,
              utilityModel: base.utilityModel,
              generateSessionTitle: base.generateSessionTitle,
              modelPresets: base.modelPresets,
              fastMode: {
                get: () => base.fastMode?.(sessionId) ?? false,
                set: (enabled) => base.setFastMode?.(sessionId, enabled) ?? Promise.resolve(),
              },
              currentSessionControl: {
                resolved: () => base.sessionResolved?.(sessionId) ?? false,
                setResolved: (resolved) =>
                  base.setSessionResolved?.(sessionId, resolved) ?? Promise.resolve(),
                createDraftSession: (input, signal) =>
                  runtimeIntegrations.requestApplicationControl(
                    { _tag: "CreateDraft", ...input },
                    signal,
                  ),
                invokeAppControl: (command, input, signal) =>
                  runtimeIntegrations.requestApplicationControl(
                    { _tag: "InvokeAppControl", command, input },
                    signal,
                  ),
              },
              sessionMetadata: {
                setTitle: (title) =>
                  base.setSessionTitleMetadata?.(sessionId, title) ?? Promise.resolve(),
              },
              worktreeLandingControl: location.managedWorktree
                ? {
                    proposeSquashMessage: (message) =>
                      base.worktreeLanding?.proposeSquashMessage({
                        workspacePath: location.workingDirectory,
                        ...message,
                      }) ?? Promise.resolve(),
                  }
                : undefined,
              vscodeControl:
                base.enterEditor && base.openInEditor && base.runEditorScript
                  ? {
                      enter: base.enterEditor,
                      open: base.openInEditor,
                      runScript: base.runEditorScript,
                    }
                  : undefined,
              openExternal: base.openExternal,
            },
          };
          return runtimeOptions;
        }),
        archive: Effect.fn("ProjectSessionEnvironment.archive")(function* (sessionId, location) {
          const archiveContext: ProjectSessionArchiveContext = {
            projectPath: location.projectPath,
            projectName: location.projectName,
          };
          const worktreeName =
            location.managedWorktree?.branch.replace(/^agent\//, "") ?? location.worktreeName;
          const resolvedContext = worktreeName
            ? {
                ...archiveContext,
                worktreeName,
              }
            : archiveContext;
          yield* archive
            .resolveProject(
              sessionId,
              {
                cwd: location.workingDirectory,
                activeRoot: options.sessionDirectory,
                resolvedRoot: options.resolvedSessionDirectory,
              },
              resolvedContext,
            )
            .pipe(Effect.mapError((error) => environmentError("archive", error)));
        }),
        restore: Effect.fn("ProjectSessionEnvironment.restore")(function* (sessionId, location) {
          const restored = yield* archive
            .restoreProject(sessionId)
            .pipe(Effect.mapError((error) => environmentError("restore", error)));
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
        }),
        forkToWorkingDirectory: Effect.fn("ProjectSessionEnvironment.forkToWorkingDirectory")(
          function* ({ sessionId, source, destination }) {
            const forked = yield* Effect.tryPromise({
              try: async () => {
                const sourceFile = await findSessionFile(
                  source.workingDirectory,
                  sessionId,
                  options.sessionDirectory,
                );
                if (!sourceFile) throw new Error("Cake could not find the Project Session to fork");
                return forkWorkspaceSession(
                  sourceFile,
                  destination.workingDirectory,
                  options.sessionDirectory,
                );
              },
              catch: (cause) => environmentError("forkToWorkingDirectory", cause),
            });
            yield* access
              .rememberSessionLocation(destination.workingDirectory, forked.sessionId)
              .pipe(Effect.mapError((cause) => environmentError("forkToWorkingDirectory", cause)));
            return forked.sessionId;
          },
        ),
      });
    }),
  );
