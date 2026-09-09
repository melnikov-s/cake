import * as sessionFamilies from "../domain/sessionFamilies";
import { Effect, Layer, Schema, Schedule } from "effect";
import { makeSubagentControl } from "../domain/subagentControl";
import childSessionFamilyPromptTemplate from "../services/pi/runtime/prompts/child-session-family.md?raw";
import parentSessionFamilyPromptTemplate from "../services/pi/runtime/prompts/parent-session-family.md?raw";
import { renderPromptTemplate } from "../services/pi/runtime/prompt-template";
import { findSessionFile, forkWorkspaceSession } from "../services/pi/runtime/session-discovery";
import { PiSessions, type PiSessionAcquireOptions } from "../services/pi/PiSessions";
import type { PiModels } from "../services/pi/PiModels";
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
  ProjectSessionEnvironmentService,
  ProjectSessionLocation,
} from "../services/project-sessions/ProjectSessionEnvironment";
import {
  makeProjectSessionEnvironmentLayer,
  ProjectSessionEnvironmentError,
} from "../services/project-sessions/ProjectSessionEnvironment";
import { SessionFamilyStorage } from "../services/storage/SessionFamilyStorage";
import { SessionCatalogChanges } from "../services/session-catalogs/SessionCatalogChanges";
import { toJsonValue } from "../utils/to-json-value";
import { encodeCrossSessionMessage } from "../domain/cross-session-coordination";

export interface ProjectSessionEnvironmentLiveOptions {
  readonly agentDirectory: string;
  readonly sessionDirectory: string;
  readonly resolvedSessionDirectory: string;
}

const FamilyMessageInput = Schema.Struct({
  sessionId: Schema.String,
  text: Schema.String,
  delivery: Schema.optionalKey(Schema.Literals(["prompt", "queue", "steer"])),
  threadId: Schema.optionalKey(Schema.String),
  maxMessages: Schema.optionalKey(Schema.Int),
});

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
  | PiModels
  | PiSessions
  | ProjectAccess
  | ProjectSessionIntegrations
  | ProjectSessionRuntimeOptions
  | SessionArchiveStorage
  | SessionCatalogChanges
  | SessionFamilyStorage
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
      const sessions = yield* PiSessions;
      const families = yield* SessionFamilyStorage;
      const catalogs = yield* SessionCatalogChanges;
      const worktrees = yield* ManagedWorktrees;
      const context = yield* Effect.context<
        | ApplicationState
        | PiModels
        | PiSessions
        | SessionCatalogChanges
        | SessionFamilyStorage
        | SessionArchiveStorage
        | SubagentCoordinator
        | SubagentEnvironment
      >();
      const run = Effect.runPromiseWith(context);
      const agentControl = makeSubagentControl({
        runEffect: (effect, signal) => run(effect, { signal }),
      });
      const environmentService: ProjectSessionEnvironmentService = {
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
          const family = yield* families
            .familyForMember(sessionId)
            .pipe(Effect.mapError((cause) => environmentError("runtimeOptions", cause)));
          const isChild =
            family?.parentSessionId !== undefined && family.parentSessionId !== sessionId;
          const relationshipPrompt = isChild
            ? renderPromptTemplate(childSessionFamilyPromptTemplate, {
                familyId: family.familyId,
                parentSessionId: family.parentSessionId,
                workingDirectory: family.workingDirectory,
              })
            : renderPromptTemplate(parentSessionFamilyPromptTemplate);
          const getRuntimeOptions = () => runtimeOptions;
          const runtimeOptions: PiSessionAcquireOptions = {
            profile: { _tag: "ProjectSession" },
            onRelease: integrations.releaseSession(sessionId),
            admitTurn: (turnId, accept) =>
              sessionFamilies
                .admitTurn(
                  sessionId,
                  {
                    cwd: location.workingDirectory,
                    activeRoot: options.sessionDirectory,
                    resolvedRoot: options.resolvedSessionDirectory,
                  },
                  turnId,
                  accept,
                )
                .pipe(
                  Effect.provideService(SessionFamilyStorage, families),
                  Effect.provideService(SessionArchiveStorage, archive),
                ),
            onTurnSettled: isChild
              ? (event) =>
                  families.settleTurn(event.turnId, event.outcome).pipe(
                    Effect.tapError((error) =>
                      Effect.logError("Retrying durable child settlement", error),
                    ),
                    Effect.retry(Schedule.spaced("1 second")),
                  )
              : undefined,
            runtime: {
              ...runtimeIntegrations,
              agentControl: agentControl(getRuntimeOptions, location.workingDirectory),
              cwd: location.workingDirectory,
              trusted: base.isTrusted?.() ?? false,
              agentDir: base.agentDir,
              additionalSystemPrompt: relationshipPrompt,
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
                canResolve: () => !isChild,
                familyInfo: family
                  ? () => {
                      const info = {
                        familyId: family.familyId,
                        parentSessionId: family.parentSessionId,
                        role: isChild ? "child" : "parent",
                      };
                      return toJsonValue(
                        isChild
                          ? info
                          : {
                              ...info,
                              childSessionIds: family.children.map((child) => child.sessionId),
                            },
                      );
                    }
                  : undefined,
                deferResolution: family === undefined,
                setResolved: (resolved) =>
                  base.setSessionResolved?.(sessionId, resolved) ?? Promise.resolve(),
                createSession: (input, signal) =>
                  runtimeIntegrations.requestApplicationControl(
                    { _tag: "CreateSession", ...input },
                    signal,
                  ),
                createDraftSession: (input, signal) =>
                  runtimeIntegrations.requestApplicationControl(
                    { _tag: "CreateDraft", ...input },
                    signal,
                  ),
                createChildSession: isChild
                  ? undefined
                  : async (input, signal) => {
                      const result = await run(
                        Effect.scoped(
                          sessionFamilies.createChild(sessionId, location, input, (childId) =>
                            environmentService.runtimeOptions({
                              location,
                              sessionId: childId,
                              newSession: true,
                            }),
                          ),
                        ),
                        { signal },
                      );
                      if (result.launch.status === "failed") return toJsonValue(result);
                      const presentation = await runtimeIntegrations
                        .requestApplicationControl(
                          {
                            _tag: "ProjectChildSession",
                            childSessionId: result.childSessionId,
                            title: input.title,
                            familyId: result.familyId,
                            familyChildOrder: result.familyChildOrder,
                            placement: input.placement,
                          },
                          signal,
                        )
                        .catch((error) => ({
                          ok: false,
                          error: error instanceof Error ? error.message : String(error),
                        }));
                      return toJsonValue({ ...result, presentation });
                    },
                routeFamilyMessage: (untrustedInput, signal) =>
                  run(
                    Effect.scoped(
                      Effect.gen(function* () {
                        const input = yield* Schema.decodeUnknownEffect(FamilyMessageInput)(
                          untrustedInput,
                        ).pipe(
                          Effect.mapError((cause) => environmentError("familyMessage", cause)),
                        );
                        const family = yield* families
                          .familyForMember(sessionId)
                          .pipe(
                            Effect.mapError((cause) => environmentError("familyMessage", cause)),
                          );
                        if (!family) return undefined;
                        const memberIds = new Set([
                          family.parentSessionId,
                          ...family.children.map((child) => child.sessionId),
                        ]);
                        if (!memberIds.has(input.sessionId)) return undefined;
                        const namespace = yield* archive
                          .locate(input.sessionId, {
                            cwd: family.workingDirectory,
                            activeRoot: options.sessionDirectory,
                            resolvedRoot: options.resolvedSessionDirectory,
                          })
                          .pipe(
                            Effect.mapError((cause) => environmentError("familyMessage", cause)),
                          );
                        if (namespace === "resolved")
                          return yield* environmentError(
                            "familyMessage",
                            `Session Family ${family.familyId} is resolved; restore it explicitly before messaging`,
                          );
                        if (!namespace)
                          return yield* environmentError(
                            "familyMessage",
                            `Family member ${input.sessionId} could not be found`,
                          );
                        const destinationOptions = yield* environmentService.runtimeOptions({
                          location,
                          sessionId: input.sessionId,
                          newSession: false,
                        });
                        const destination = yield* sessions.acquire(destinationOptions);
                        const destinationSnapshot = yield* destination.snapshot();
                        const senderSummary = yield* sessions
                          .catalogEntry(
                            {
                              workingDirectory: location.workingDirectory,
                              sessionDirectory: location.sessionDirectory,
                            },
                            sessionId,
                          )
                          .pipe(Effect.catch(() => Effect.succeed(undefined)));
                        const messageId = crypto.randomUUID();
                        const threadId = input.threadId ?? crypto.randomUUID();
                        const messageMetadata = {
                          version: 1 as const,
                          messageId,
                          threadId,
                          sequence: 1,
                          sender: {
                            sessionId,
                            title: senderSummary?.title ?? `Project Session ${sessionId}`,
                            kind: "project-session" as const,
                            projectName: location.projectName,
                            workingDirectory: location.workingDirectory,
                          },
                        };
                        const encoded = encodeCrossSessionMessage(
                          input.text,
                          input.maxMessages === undefined
                            ? messageMetadata
                            : { ...messageMetadata, maxMessages: input.maxMessages },
                        );
                        const repliesToParent =
                          family.parentSessionId !== sessionId &&
                          input.sessionId === family.parentSessionId;
                        const sourceTurnIds = repliesToParent
                          ? yield* sessions.executingTurnIds({
                              workingDirectory: location.workingDirectory,
                              sessionDirectory: location.sessionDirectory,
                              sessionId,
                            })
                          : [];
                        if (repliesToParent)
                          yield* families.prepareReply(sessionId, sourceTurnIds, messageId);
                        // Ordinary family delivery starts an idle recipient or queues behind active
                        // work. An explicit steer deliberately interrupts and redirects the target.
                        const delivery =
                          input.delivery ?? (destinationSnapshot.streaming ? "queue" : "prompt");
                        const turnId =
                          delivery === "steer"
                            ? yield* destination.steer(encoded, [], false)
                            : delivery === "queue"
                              ? yield* destination.followUp(encoded, [], false)
                              : yield* destination.prompt(encoded, [], false);
                        if (repliesToParent) yield* families.reportTurns(sessionId, sourceTurnIds);
                        yield* catalogs.publish({
                          _tag: "ProjectSessionChanged",
                          sessionId: input.sessionId,
                          projectPath: location.projectPath,
                          workingDirectory: location.workingDirectory,
                          resolved: false,
                        });
                        return toJsonValue({
                          ok: true,
                          name: "send_session_message",
                          targetTitle: `Project Session ${input.sessionId}`,
                          messageId,
                          threadId,
                          turnId,
                          delivery,
                          status: delivery === "queue" ? "queued" : "accepted",
                        });
                      }),
                    ),
                    { signal },
                  ),
                invokeAppControl: (command, input, signal) =>
                  runtimeIntegrations.requestApplicationControl(
                    { _tag: "InvokeAppControl", command, input },
                    signal,
                  ),
              },
              sessionMetadata: {
                setTitle: (targetSessionId, title) =>
                  base.setSessionTitleMetadata?.(targetSessionId, title) ?? Promise.resolve(),
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
          function* ({ sessionId, title, source, destination }) {
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
                  title,
                );
              },
              catch: (cause) => environmentError("forkToWorkingDirectory", cause),
            });
            yield* access
              .rememberSessionLocation(destination.workingDirectory, forked.sessionId)
              .pipe(Effect.mapError((cause) => environmentError("forkToWorkingDirectory", cause)));
            yield* Effect.tryPromise({
              try: () =>
                projectRuntime
                  .forWorkingDirectory(destination.workingDirectory)
                  .setSessionTitleMetadata?.(forked.sessionId, title) ?? Promise.resolve(),
              catch: (cause) => environmentError("forkToWorkingDirectory", cause),
            });
            return forked.sessionId;
          },
        ),
      };
      return makeProjectSessionEnvironmentLayer(environmentService);
    }),
  );
