import * as sessionFamilies from "../session-families/sessionFamilies";
import { Effect, Schema, Schedule } from "effect";
import { setSessionFastMode } from "../application/application";
import { encodeCrossSessionMessage } from "../conversations/cross-session-coordination";
import type { ProjectSessionLocation } from "./project-session-data";
import { makeSubagentControl } from "../subagents/subagentControl";
import { generateSessionTitle, utilityModelSelection } from "../utility-work/utilityWork";
import { Electron } from "../../services/electron/Electron";
import type { PiModels } from "../../services/pi/PiModels";
import { PiSessions, type PiSessionAcquireOptions } from "../../services/pi/PiSessions";
import { ProjectSessionRuntimeHost } from "../../services/pi/ProjectSessionRuntimeHost";
import childSessionFamilyPromptTemplate from "../../services/pi/runtime/prompts/child-session-family.md?raw";
import parentSessionFamilyPromptTemplate from "../../services/pi/runtime/prompts/parent-session-family.md?raw";
import { renderPromptTemplate } from "../../services/pi/runtime/prompt-template";
import { ProjectAccess } from "../../services/projects/ProjectAccess";
import { ProjectSessionConfiguration } from "../../services/project-sessions/ProjectSessionConfiguration";
import * as projectSessionLifecycle from "./projectSessionLifecycle";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import type { SubagentCoordinator } from "../../services/subagents/SubagentCoordinator";
import type { SubagentEnvironment } from "../../services/subagents/SubagentEnvironment";
import { VsCodeServer } from "../../services/vscode/VsCodeServer";
import { ManagedWorktrees } from "../../services/worktrees/ManagedWorktrees";
import type { Terminal } from "../../services/terminal/Terminal";
import { toJsonValue } from "../../utils/to-json-value";

const FamilyMessageInput = Schema.Struct({
  sessionId: Schema.String,
  text: Schema.String,
  delivery: Schema.optionalKey(Schema.Literals(["prompt", "queue", "steer"])),
  threadId: Schema.optionalKey(Schema.String),
  maxMessages: Schema.optionalKey(Schema.Int),
});

class ProjectSessionRuntimeCompositionError extends Schema.TaggedError<ProjectSessionRuntimeCompositionError>()(
  "ProjectSessionRuntimeCompositionError",
  { operation: Schema.String, message: Schema.String },
) {}

const compositionError = (operation: string, cause: unknown) =>
  new ProjectSessionRuntimeCompositionError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

/** The single Cake-owned composition point for Project Session Pi acquisition. */
export const acquireOptions = Effect.fn("ProjectSessions.acquireOptions")(function* ({
  location,
  sessionId,
  newSession,
}: {
  readonly location: ProjectSessionLocation;
  readonly sessionId: string;
  readonly newSession: boolean;
}) {
  const access = yield* ProjectAccess;
  const application = yield* ApplicationState;
  const archive = yield* SessionArchiveStorage;
  const configuration = yield* ProjectSessionConfiguration;
  const electron = yield* Electron;
  const runtimeHost = yield* ProjectSessionRuntimeHost;
  const sessions = yield* PiSessions;
  const families = yield* SessionFamilyStorage;
  const catalogs = yield* SessionCatalogChanges;
  const vscode = yield* VsCodeServer;
  const worktrees = yield* ManagedWorktrees;
  const context = yield* Effect.context<
    | ApplicationState
    | Electron
    | PiModels
    | PiSessions
    | ProjectAccess
    | ProjectSessionConfiguration
    | ProjectSessionRuntimeHost
    | SessionCatalogChanges
    | SessionFamilyStorage
    | SessionArchiveStorage
    | SubagentCoordinator
    | SubagentEnvironment
    | ManagedWorktrees
    | Terminal
    | VsCodeServer
  >();
  const run = Effect.runPromiseWith(context);
  const agentControl = makeSubagentControl({
    runEffect: (effect, signal) => run(effect, { signal }),
  });
  const modelPresets = () => {
    const state = application.snapshot();
    return {
      presets: state.modelPresets.map((preset) => ({ ...preset })),
      defaultPresetId: state.defaultModelPresetId,
    };
  };

  yield* access
    .rememberSessionLocation(location.workingDirectory, sessionId)
    .pipe(Effect.mapError((cause) => compositionError("acquireOptions", cause)));
  const runtimeIntegrations = yield* runtimeHost
    .runtimeIntegrations(location.workingDirectory, sessionId)
    .pipe(Effect.mapError((cause) => compositionError("runtimeIntegrations", cause)));
  const family = yield* families
    .familyForMember(sessionId)
    .pipe(Effect.mapError((cause) => compositionError("acquireOptions", cause)));
  const isChild = family?.parentSessionId !== undefined && family.parentSessionId !== sessionId;
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
    onRelease: runtimeHost.releaseSession(sessionId),
    admitTurn: (turnId, accept) =>
      sessionFamilies
        .admitTurn(
          sessionId,
          {
            cwd: location.workingDirectory,
            activeRoot: configuration.sessionDirectory,
            resolvedRoot: configuration.resolvedSessionDirectory,
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
            Effect.tapError((error) => Effect.logError("Retrying durable child settlement", error)),
            Effect.retry(Schedule.spaced("1 second")),
          )
      : undefined,
    runtime: {
      ...runtimeIntegrations,
      agentControl: agentControl(getRuntimeOptions, location.workingDirectory),
      cwd: location.workingDirectory,
      trusted: application.snapshot().trustedProjectPaths.includes(location.workingDirectory),
      agentDir: configuration.agentDirectory,
      additionalSystemPrompt: relationshipPrompt,
      sessionDir: configuration.sessionDirectory,
      resolvedSessionDir: configuration.resolvedSessionDirectory,
      newSession,
      sessionId,
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
      fastMode: {
        get: () => application.snapshot().fastModeSessionIds.includes(sessionId),
        set: (enabled) => run(setSessionFastMode(sessionId, enabled)).then(() => undefined),
      },
      currentSessionControl: {
        // An acquired Project Session is necessarily in the active namespace.
        resolved: () => false,
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
          run(
            (resolved ? projectSessionLifecycle.resolve : projectSessionLifecycle.restore)({
              sessionId,
              workingDirectory: location.workingDirectory,
            }),
          ).then(() => undefined),
        createSession: (input, signal) =>
          runtimeIntegrations.requestApplicationControl(
            { _tag: "CreateSession", ...input },
            signal,
          ),
        createDraftSession: (input, signal) =>
          runtimeIntegrations.requestApplicationControl({ _tag: "CreateDraft", ...input }, signal),
        createChildSession: isChild
          ? undefined
          : async (input, signal) => {
              const result = await run(
                Effect.scoped(
                  sessionFamilies.createChild(sessionId, location, input, (childId) =>
                    acquireOptions({
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
        forkSession: family
          ? undefined
          : (input) =>
              runtimeIntegrations.requestApplicationControl(
                { _tag: "ForkSession", ...input },
                new AbortController().signal,
              ),
        routeFamilyMessage: (untrustedInput, signal) =>
          run(
            Effect.scoped(
              Effect.gen(function* () {
                const input = yield* Schema.decodeUnknownEffect(FamilyMessageInput)(
                  untrustedInput,
                ).pipe(Effect.mapError((cause) => compositionError("familyMessage", cause)));
                const family = yield* families
                  .familyForMember(sessionId)
                  .pipe(Effect.mapError((cause) => compositionError("familyMessage", cause)));
                if (!family) return undefined;
                const memberIds = new Set([
                  family.parentSessionId,
                  ...family.children.map((child) => child.sessionId),
                ]);
                if (!memberIds.has(input.sessionId)) return undefined;
                const namespace = yield* archive
                  .locate(input.sessionId, {
                    cwd: family.workingDirectory,
                    activeRoot: configuration.sessionDirectory,
                    resolvedRoot: configuration.resolvedSessionDirectory,
                  })
                  .pipe(Effect.mapError((cause) => compositionError("familyMessage", cause)));
                if (namespace === "resolved")
                  return yield* compositionError(
                    "familyMessage",
                    `Session Family ${family.familyId} is resolved; restore it explicitly before messaging`,
                  );
                if (!namespace)
                  return yield* compositionError(
                    "familyMessage",
                    `Family member ${input.sessionId} could not be found`,
                  );
                const destinationOptions = yield* acquireOptions({
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
      sessionTitleChanged: (targetSessionId) =>
        run(
          Effect.gen(function* () {
            const records = yield* worktrees.records();
            const projectPath =
              records.find((record) => record.worktreePath === location.workingDirectory)
                ?.projectPath ?? location.workingDirectory;
            yield* catalogs.publish({
              _tag: "ProjectSessionChanged",
              sessionId: targetSessionId,
              projectPath,
              workingDirectory: location.workingDirectory,
              resolved: false,
            });
          }),
        ),
      worktreeLandingControl: location.managedWorktree
        ? {
            proposeSquashMessage: (message) =>
              run(
                worktrees.proposeSquashMessage({
                  workspacePath: location.workingDirectory,
                  ...message,
                }),
              ),
          }
        : undefined,
      vscodeControl: {
        enter: (signal) => run(vscode.enterProjectEditor(location.workingDirectory), { signal }),
        open: (sourceLocation, signal) =>
          run(vscode.openProjectLocation(location.workingDirectory, sourceLocation), { signal }),
        runScript: (source, input, signal) =>
          run(vscode.runProjectScript(location.workingDirectory, source, input), { signal }),
      },
      openExternal: (url) => run(electron.openExternal(url)),
    },
  };
  return runtimeOptions;
});
