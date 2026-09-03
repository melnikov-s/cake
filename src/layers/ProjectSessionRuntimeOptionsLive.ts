import { Effect, Layer } from "effect";
import { setSessionFastMode } from "../domain/application";
import { generateSessionTitle, utilityModelSelection } from "../domain/utilityWork";
import { Electron } from "../services/electron/Electron";
import { ProjectSessionLifecycle } from "../services/project-sessions/ProjectSessionLifecycle";
import { ApplicationState } from "../services/storage/ApplicationState";
import { VsCodeServer } from "../services/vscode/VsCodeServer";
import { ManagedWorktrees } from "../services/worktrees/ManagedWorktrees";
import type { PiModels } from "../services/pi/PiModels";
import { ProjectSessionRuntimeOptions } from "../services/pi/ProjectSessionRuntimeOptions";
import { SessionMetadataStorage } from "../services/storage/SessionMetadataStorage";
import { SessionCatalogChanges } from "../services/session-catalogs/SessionCatalogChanges";

export interface ProjectSessionRuntimeOptionsLiveOptions {
  readonly agentDirectory: string;
  readonly sessionDirectory: string;
  readonly resolvedSessionDirectory: string;
  readonly widgetSessionDirectory: string;
}

export const makeProjectSessionRuntimeOptionsLive = (
  options: ProjectSessionRuntimeOptionsLiveOptions,
): Layer.Layer<
  ProjectSessionRuntimeOptions,
  never,
  | ApplicationState
  | Electron
  | ManagedWorktrees
  | PiModels
  | SessionMetadataStorage
  | ProjectSessionLifecycle
  | SessionCatalogChanges
  | VsCodeServer
> =>
  Layer.effect(
    ProjectSessionRuntimeOptions,
    Effect.gen(function* () {
      const application = yield* ApplicationState;
      const electron = yield* Electron;
      const lifecycle = yield* ProjectSessionLifecycle;
      const metadata = yield* SessionMetadataStorage;
      const catalogs = yield* SessionCatalogChanges;
      const vscode = yield* VsCodeServer;
      const worktrees = yield* ManagedWorktrees;
      const context = yield* Effect.context<
        | ApplicationState
        | ManagedWorktrees
        | PiModels
        | SessionMetadataStorage
        | ProjectSessionLifecycle
        | SessionCatalogChanges
        | VsCodeServer
      >();
      const run = Effect.runPromiseWith(context);
      const modelPresets = () => {
        const state = application.snapshot();
        return {
          presets: state.modelPresets.map(({ id, name, modelId }) => ({ id, name, modelId })),
          defaultPresetId: state.defaultModelPresetId,
        };
      };
      return ProjectSessionRuntimeOptions.of({
        forWorkingDirectory: (workingDirectory) => ({
          agentDir: options.agentDirectory,
          sessionDir: options.sessionDirectory,
          resolvedSessionDir: options.resolvedSessionDirectory,
          widgetSessionDir: options.widgetSessionDirectory,
          isTrusted: () => application.snapshot().trustedProjectPaths.includes(workingDirectory),
          utilityModel: () => application.snapshot().utilityModel,
          generateSessionTitle: ({ utilityModel, firstUserMessage, signal }) =>
            run(
              generateSessionTitle({
                selection: utilityModelSelection(utilityModel),
                firstUserMessage,
              }),
              { signal },
            ),
          modelPresets,
          worktreeLanding: {
            proposeSquashMessage: (input) => run(worktrees.proposeSquashMessage(input)),
          },
          fastMode: (sessionId) => application.snapshot().fastModeSessionIds.includes(sessionId),
          setFastMode: (sessionId, enabled) =>
            run(setSessionFastMode(sessionId, enabled)).then(() => undefined),
          // A running Project Session is necessarily in the active namespace.
          // Resolved sessions are opened as read-only previews without a Pi runtime.
          sessionResolved: () => false,
          setSessionResolved: (sessionId, resolved) =>
            run(lifecycle.setProjectSessionResolved(sessionId, resolved, workingDirectory)).then(
              () => undefined,
            ),
          setSessionTitleMetadata: (sessionId, title) =>
            run(
              metadata.setTitle(sessionId, title).pipe(
                Effect.flatMap((changed) =>
                  changed
                    ? Effect.gen(function* () {
                        const records = yield* worktrees.records();
                        const projectPath =
                          records.find((record) => record.worktreePath === workingDirectory)
                            ?.projectPath ?? workingDirectory;
                        yield* catalogs.publish({
                          _tag: "ProjectSessionChanged",
                          sessionId,
                          projectPath,
                          workingDirectory,
                          resolved: false,
                        });
                      })
                    : Effect.void,
                ),
              ),
            ),
          enterEditor: (signal) => run(vscode.enterProjectEditor(workingDirectory), { signal }),
          openInEditor: (location, signal) =>
            run(vscode.openProjectLocation(workingDirectory, location), { signal }),
          runEditorScript: (source, input, signal) =>
            run(vscode.runProjectScript(workingDirectory, source, input), { signal }),
          openExternal: (url) => run(electron.openExternal(url)),
        }),
      });
    }),
  );
