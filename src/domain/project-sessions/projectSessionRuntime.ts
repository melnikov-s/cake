import * as sessionFamilies from "../session-families/sessionFamilies";
import { implicitTurnResultFor } from "../../contracts/pi/turn-result-data";
import * as sessionFamilyMessaging from "../session-families/sessionFamilyMessaging";
import * as projectSessionAgentPolicy from "./projectSessionAgentPolicy";
import { resolveCakeModelSelection } from "../model-presets/cake-model-selection";
import * as projectSessionLocations from "./projectSessionLocations";
import * as sessionReferences from "./sessionReferences";
import * as managedWorktrees from "../worktrees/managedWorktrees";
import * as worktreeLandings from "../worktrees/worktreeLandings";
import { WorktreeLandingCoordinator } from "../../services/worktrees/WorktreeLandingCoordinator";
import { WorktreeLandingAgent } from "../../services/worktrees/WorktreeLandingAgent";
import { WorktreeLandingCompletion } from "../../services/worktrees/WorktreeLandingCompletion";
import * as projectSessionCreation from "./projectSessionCreation";
import * as savedDrafts from "./savedDrafts";
import { SavedDraftStorage } from "../../services/storage/SavedDraftStorage";
import type { TaskInputStorage } from "../../services/storage/TaskInputStorage";
import * as projectSessionContinuations from "./projectSessionContinuations";
import * as projectSessionOperations from "./projectSessionOperations";
import * as sessionChats from "../conversations/sessionChats";
import { inheritTaskInputProtection } from "../conversations/taskInputs";
import { Context, Effect, Option, Schema, Schedule } from "effect";
import {
  deleteSessionPlugin,
  setProjectSessionLabelsIfUnlabelled,
  setSessionFastMode,
  setSessionPluginState,
  patchSessionPluginState,
  upsertSessionPlugin,
} from "../application/application";
import type { ProjectSessionLocation } from "../../contracts/project-sessions/project-session-data";
import {
  describeMessageReferences,
  validateMessageReferenceControl,
} from "../conversations/messageReferenceForwarding";
import { grantMessageAttachments } from "../conversations/messageReferenceAccess";
import * as messageReferences from "../conversations/messageReferences";
import { messageNavigationTarget } from "../../contracts/conversations/message-reference";
import { forwardTaskInputControl } from "../cake-chats/taskInputControls";
import { makeAttachmentReferenceControl } from "../conversations/attachmentReferences";
import { makeSubagentControl } from "../subagents/subagentControl";
import * as workflowControl from "../workflows/workflow-control";
import { WorkflowSupervisor } from "../../services/workflows/WorkflowSupervisor";
import * as workflowLifecycle from "../workflows/workflow-lifecycle";
import {
  generateSessionTitle,
  selectInitialSessionLabels,
  utilityModelSelection,
} from "../utility-work/utilityWork";
import type { PiModels } from "../../services/pi/PiModels";
import {
  CakeSessionRuntimes,
  type CakeSessionRuntimeAcquireOptions,
} from "../../services/pi/CakeSessionRuntimes";
import { ProjectSessionRuntimeHost } from "../../services/pi/ProjectSessionRuntimeHost";
import { makePiCallbackExecutor } from "../../services/pi/PiCallbackAdapter";
import childSessionFamilyPromptTemplate from "./prompts/child-session-family.md?raw";
import parentSessionFamilyPromptTemplate from "./prompts/parent-session-family.md?raw";
import { renderProjectSessionPrompt } from "./projectSessionPromptTemplate";
import { ProjectAccess } from "../../services/projects/ProjectAccess";
import { ProjectSessionConfiguration } from "../../services/project-sessions/ProjectSessionConfiguration";
import * as projectSessionLifecycle from "./projectSessionLifecycle";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import { ArtifactStorage } from "../../services/storage/ArtifactStorage";
import { resolutionNamespace } from "./projectSessionResolution";
import { SessionFamilyStorage, familyMember } from "../../services/storage/SessionFamilyStorage";
import type { SubagentCoordinator } from "../../services/subagents/SubagentCoordinator";
import type { SubagentEnvironment } from "../../services/subagents/SubagentEnvironment";
import { VsCodeServer } from "../../services/vscode/VsCodeServer";
import { Browser } from "../../services/browser/Browser";
import { ManagedWorktrees } from "../../services/worktrees/ManagedWorktrees";
import type { Terminal } from "../../services/terminal/Terminal";
import { toJsonValue } from "../../utils/to-json-value";
import { agentEditorLocation } from "../../utils/agent-editor-location";
import { jsonObjectSchema, type JsonObject } from "../../contracts/serialization/json-contract";
import { sessionReference } from "../../contracts/project-sessions/session-reference";
import {
  EditorSelectionOpenResult,
  EditorSelectionState,
  EditorSelectionUpdate,
} from "../../contracts/editor/editor-selection";

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
}): Effect.fn.Return<
  CakeSessionRuntimeAcquireOptions,
  ProjectSessionRuntimeCompositionError,
  | ApplicationState
  | PiModels
  | CakeSessionRuntimes
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
  | TaskInputStorage
  | Effect.Services<ReturnType<typeof workflowControl.invoke>>
> {
  const access = yield* ProjectAccess;
  const application = yield* ApplicationState;
  const archive = yield* SessionArchiveStorage;
  const artifactStorage = yield* Effect.serviceOption(ArtifactStorage);
  const savedDraftStorage = yield* Effect.serviceOption(SavedDraftStorage);
  const landingCoordinator = yield* Effect.serviceOption(WorktreeLandingCoordinator);
  const landingAgent = yield* Effect.serviceOption(WorktreeLandingAgent);
  const landingCompletion = yield* Effect.serviceOption(WorktreeLandingCompletion);
  const configuration = yield* ProjectSessionConfiguration;
  const runtimeHost = yield* ProjectSessionRuntimeHost;
  const sessions = yield* CakeSessionRuntimes;
  const workflowSupervisor = yield* WorkflowSupervisor;
  const families = yield* SessionFamilyStorage;
  const catalogs = yield* SessionCatalogChanges;
  const browser = yield* Effect.serviceOption(Browser);
  const vscode = yield* Effect.serviceOption(VsCodeServer);
  const worktrees = yield* ManagedWorktrees;
  const context = yield* Effect.context<
    | ApplicationState
    | PiModels
    | CakeSessionRuntimes
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
    | TaskInputStorage
    | Effect.Services<ReturnType<typeof workflowControl.invoke>>
  >();
  const run = makePiCallbackExecutor(
    Option.isSome(savedDraftStorage)
      ? Context.add(context, SavedDraftStorage, savedDraftStorage.value)
      : context,
  );
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
  const member = family && familyMember(family, sessionId);
  const isChild = member?.parentSessionId !== undefined;
  // Clear former per-member resolution metadata without changing inherited
  // family resolution. Storage migrates any old archived transcript in place.
  if (
    isChild &&
    !newSession &&
    (yield* archive
      .locate(sessionId, {
        cwd: location.workingDirectory,
        activeRoot: location.sessionDirectory,
        resolvedRoot: location.resolvedSessionDirectory,
      })
      .pipe(Effect.mapError((cause) => compositionError("acquireOptions", cause)))) === "resolved"
  ) {
    if (
      (yield* resolutionNamespace(sessionId, {
        cwd: location.workingDirectory,
        activeRoot: location.sessionDirectory,
        resolvedRoot: location.resolvedSessionDirectory,
      }).pipe(Effect.mapError((cause) => compositionError("acquireOptions", cause)))) === "active"
    )
      yield* managedWorktrees
        .restoreResolved(location.workingDirectory)
        .pipe(Effect.mapError((cause) => compositionError("acquireOptions", cause)));
    yield* archive
      .restoreProject(sessionId)
      .pipe(Effect.mapError((cause) => compositionError("acquireOptions", cause)));
  }
  const relationshipPrompt =
    family && member?.parentSessionId
      ? renderProjectSessionPrompt(childSessionFamilyPromptTemplate, {
          familyId: family.familyId,
          parentSessionId: sessionReference(
            member.parentSessionId,
            (yield* sessionReferences
              .catalog()
              .pipe(Effect.mapError((cause) => compositionError("relationshipPrompt", cause)))).map(
              (entry) => entry.sessionId,
            ),
          ),
          workingDirectory: member.workingDirectory,
        })
      : renderProjectSessionPrompt(parentSessionFamilyPromptTemplate);
  const appState = application.snapshot();
  const projectSettings = appState.projects.find(
    (project) => project.path === location.projectPath,
  )?.settings;
  const setupInstructions = location.managedWorktree
    ? projectSettings?.worktreeSetupInstructions.trim()
    : undefined;
  const globalInstructions = appState.globalCustomInstructions.trim();
  const projectInstructions = projectSettings?.customInstructions.trim();
  const projectPrompt = setupInstructions
    ? `<worktree_instructions>\n## Project worktree setup instructions\n\n${setupInstructions}\n</worktree_instructions>`
    : undefined;
  const worktreeOperationTarget = Effect.fn("ProjectSessions.worktreeOperationTarget")(function* (
    targetSessionId?: string,
  ) {
    const currentFamily = yield* families
      .familyForMember(sessionId)
      .pipe(Effect.mapError((cause) => compositionError("worktreeOperation", cause)));
    const targetId = targetSessionId ?? sessionId;
    let targetMember = currentFamily && familyMember(currentFamily, sessionId);
    if (targetSessionId !== undefined) {
      if (!currentFamily)
        return yield* compositionError(
          "worktreeOperation",
          "Only a Session Family parent can target a child session",
        );
      targetMember = currentFamily.children.find(
        (child) => child.sessionId === targetSessionId && child.parentSessionId === sessionId,
      );
      if (!targetMember)
        return yield* compositionError(
          "worktreeOperation",
          "The target must be an immediate child of the calling session",
        );
    }
    const workingDirectory = targetMember?.workingDirectory ?? location.workingDirectory;
    if (targetMember?.parentSessionId && currentFamily) {
      const parent = familyMember(currentFamily, targetMember.parentSessionId);
      if (parent?.workingDirectory === workingDirectory)
        return yield* compositionError(
          "worktreeOperation",
          "That session shares its parent's Working Directory and has no child worktree to merge or discard",
        );
    }
    const targetLocation = (yield* projectSessionLocations.locations({
      includeInactive: true,
    })).find(
      (candidate) =>
        candidate.projectPath === location.projectPath &&
        candidate.workingDirectory === workingDirectory,
    );
    if (!targetLocation?.managedWorktree)
      return yield* compositionError(
        "worktreeOperation",
        "That session does not have an isolated Cake-managed worktree",
      );
    return { sessionId: targetId, location: targetLocation };
  });
  const getRuntimeOptions = () => runtimeOptions;
  const requestEditorControl = async (command: string, input: JsonObject, signal: AbortSignal) => {
    if (Option.isNone(vscode)) throw new Error("VS Code is unavailable in this host");
    const response = await runtimeIntegrations.requestApplicationControl(
      { _tag: "InvokeAppControl", command, input },
      signal,
    );
    const status = await run(
      Schema.decodeUnknownEffect(
        Schema.Struct({ ok: Schema.Boolean, error: Schema.optionalKey(Schema.String) }),
      )(response),
      { signal },
    );
    if (!status.ok)
      throw new Error(status.error ?? "The owning renderer's VS Code controls are unavailable");
    return response;
  };
  const runtimeOptions: CakeSessionRuntimeAcquireOptions = {
    profile: { _tag: "ProjectSession" },
    onRelease: runtimeHost.releaseSession(sessionId),
    onSessionChanged: catalogs.publish({
      _tag: "ProjectSessionChanged",
      sessionId,
      projectPath: location.projectPath,
      workingDirectory: location.workingDirectory,
      resolved: false,
    }),
    onTurnActivityChanged: catalogs.publish({
      _tag: "ProjectSessionActivityChanged",
      sessionId,
      projectPath: location.projectPath,
      workingDirectory: location.workingDirectory,
      sessionDirectory: location.sessionDirectory,
    }),
    admitTurn: (input, accept) =>
      sessionFamilies
        .admitTurn(
          sessionId,
          {
            cwd: location.workingDirectory,
            activeRoot: configuration.sessionDirectory,
            resolvedRoot: configuration.resolvedSessionDirectory,
          },
          input,
          accept,
        )
        .pipe(
          Effect.provideService(SessionFamilyStorage, families),
          Effect.provideService(SessionArchiveStorage, archive),
        ),
    onTurnSettled: (event) =>
      Effect.gen(function* () {
        const workflowOwnsCompletion = yield* workflowLifecycle
          .holdsTurnCompletion(sessionId, event.turnId)
          .pipe(Effect.provideService(WorkflowSupervisor, workflowSupervisor));
        const familyTurn = (yield* families.state()).turns.find(
          (turn) => turn.turnId === event.turnId,
        );
        if (workflowOwnsCompletion && familyTurn?.completionContract) return;
        // Only an answer to the requester itself may become its implicit result.
        const text = familyTurn
          ? implicitTurnResultFor(event.result, familyTurn.senderSessionId)
          : undefined;
        const failed = event.outcome === "failed" || event.result?.stopReason === "error";
        const outcome = event.outcome === "aborted" ? "aborted" : failed ? "failed" : "complete";
        const diagnostic = (event.message ?? event.result?.errorMessage)?.trim().slice(0, 100_000);
        const report =
          failed && diagnostic
            ? { outcome: "failed" as const, text: diagnostic }
            : text
              ? { outcome: "result" as const, text }
              : undefined;
        yield* families.settleTurn(event.turnId, outcome, report).pipe(
          Effect.tapError((error) => Effect.logError("Retrying durable session settlement", error)),
          Effect.retry(Schedule.spaced("1 second")),
        );
      }),
    runtime: {
      ...runtimeIntegrations,
      sessionReferences: {
        resolve: (reference, signal) => run(sessionReferences.resolve(reference), { signal }),
        project: (value, signal) => run(sessionReferences.project(value), { signal }),
        ids: (signal) =>
          run(
            sessionReferences
              .catalog()
              .pipe(Effect.map((roster) => roster.map((entry) => entry.sessionId))),
            { signal },
          ),
      },
      agentControl: agentControl(getRuntimeOptions, location.workingDirectory),
      attachmentReferenceControl: makeAttachmentReferenceControl(sessionId, run),
      messageReferenceControl: {
        list: (input, signal) =>
          run(Effect.scoped(messageReferences.list(input).pipe(Effect.map(toJsonValue))), {
            signal,
          }),
        read: (input, signal) =>
          run(
            Effect.scoped(
              messageReferences.read(input).pipe(
                Effect.tap((result) => grantMessageAttachments(sessionId, result.message)),
                Effect.map(toJsonValue),
              ),
            ),
            { signal },
          ),
        open: (input, signal) =>
          runtimeIntegrations.requestApplicationControl(
            {
              _tag: "InvokeAppControl",
              command: "sessions.open",
              input: messageNavigationTarget(input.ref),
            },
            signal,
          ),
      },
      workflowControl: {
        isEnabled: () => application.snapshot().experimentalFeatures?.dynamicWorkflows === true,
        invoke: (command, input, signal) =>
          run(
            workflowControl.invoke(command, input, { _tag: "ProjectSession", sessionId }, signal),
            { signal },
          ),
      },
      cwd: location.workingDirectory,
      trusted: application.snapshot().trustedProjectPaths.includes(location.workingDirectory),
      agentDir: configuration.agentDirectory,
      additionalSystemPrompt: [
        relationshipPrompt,
        globalInstructions && `## Personal global instructions\n\n${globalInstructions}`,
        projectInstructions && `## Personal project instructions\n\n${projectInstructions}`,
        projectPrompt,
      ]
        .filter(Boolean)
        .join("\n\n"),
      sessionDir: configuration.sessionDirectory,
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
      autoLabelSession: async ({ utilityModel, firstUserMessage, signal }) => {
        const state = application.snapshot();
        const project = state.projects.find((candidate) => candidate.path === location.projectPath);
        const workflow = project?.workflow;
        if (
          !project ||
          workflow?.assignments.some(
            (assignment) => assignment.sessionId === sessionId && assignment.labelIds.length > 0,
          )
        )
          return;
        const labels = [...state.globalSessionLabels, ...(workflow?.labels ?? [])];
        const labelIds = await run(
          selectInitialSessionLabels({
            selection: utilityModelSelection(utilityModel),
            firstUserMessage,
            labels,
          }),
          { signal },
        );
        if (labelIds.length > 0)
          await run(
            setProjectSessionLabelsIfUnlabelled(location.projectPath, sessionId, labelIds),
            { signal },
          );
      },
      modelPresets,
      resolveModelSelection: (selection, fallback) =>
        resolveCakeModelSelection(selection, modelPresets(), fallback),
      nonChatModelPreferences: () => application.snapshot().nonChatModelPreferences ?? {},
      sessionPluginControl: {
        sessionId,
        present: (plugin) => run(upsertSessionPlugin(plugin)).then(() => undefined),
        setState: (pluginId, state) =>
          run(setSessionPluginState(sessionId, pluginId, state)).then(() => undefined),
        patchState: (pluginId, patch) =>
          run(patchSessionPluginState(sessionId, pluginId, patch)).then(() => undefined),
        delete: (pluginId) => run(deleteSessionPlugin(sessionId, pluginId)).then(() => undefined),
      },
      fastMode: {
        get: () => application.snapshot().fastModeSessionIds.includes(sessionId),
        set: (enabled) => run(setSessionFastMode(sessionId, enabled)).then(() => undefined),
      },
      currentSessionControl: {
        // Used only when deferring standalone resolution during an active turn.
        // Family lifecycle always goes through the root authority below.
        resolved: () => false,
        canResolve: () => true,
        readPolicy: () => run(projectSessionAgentPolicy.read(sessionId)),
        resolveDeferredStandalone: () =>
          run(
            projectSessionLifecycle.resolveDeferredStandalone({
              sessionId,
              workingDirectory: location.workingDirectory,
            }),
          ),
        setResolved: (resolved) =>
          run(
            (resolved ? projectSessionLifecycle.resolve : projectSessionLifecycle.restore)({
              sessionId,
              workingDirectory: location.workingDirectory,
            }),
          ).then(() => undefined),
        createSession: (input, signal) =>
          run(
            Effect.scoped(
              projectSessionCreation.createPrompted({
                ...input,
                sourceSessionId: sessionId,
                projectPath: location.projectPath,
              }),
            ),
            {
              signal,
            },
          ).then(toJsonValue),
        createDraftSession: async (input, signal) => {
          if (Option.isNone(savedDraftStorage))
            throw new Error("Saved Draft storage is unavailable");
          const record = await run(
            savedDrafts
              .create({
                projectPath: location.projectPath,
                title: input.name,
                text: input.initialPrompt,
                attachments: [],
                configuration: input.model,
              })
              .pipe(Effect.provideService(SavedDraftStorage, savedDraftStorage.value)),
            { signal },
          );
          await run(inheritTaskInputProtection(sessionId, record.sessionId), { signal });
          return toJsonValue({
            ok: true,
            command: "sessions.create-draft",
            workspacePath: record.projectPath,
            sessionId: record.sessionId,
            title: record.title,
            status: "saved-draft",
          });
        },
        createChildSession: async (input, signal) => {
          if (Option.isNone(artifactStorage)) throw new Error("Artifact storage is unavailable");
          const result = await run(
            Effect.scoped(
              sessionFamilies
                .createChild(
                  sessionId,
                  location,
                  input,
                  (childId, childLocation) =>
                    inheritTaskInputProtection(sessionId, childId).pipe(
                      Effect.mapError((error) => compositionError("createChild", error)),
                      Effect.andThen(
                        acquireOptions({
                          location: childLocation,
                          sessionId: childId,
                          newSession: true,
                        }),
                      ),
                    ),
                  (worktreeName) =>
                    managedWorktrees
                      .create({
                        projectPath: location.projectPath,
                        baseWorktreePath: location.workingDirectory,
                        worktreeName,
                        backgroundSetup: true,
                      })
                      .pipe(
                        Effect.map((record) => ({
                          ...location,
                          workingDirectory: record.worktreePath,
                          managedWorktree: record,
                        })),
                      ),
                  (workingDirectory) =>
                    projectSessionLocations.locations({ includeInactive: true }).pipe(
                      Effect.flatMap((locations) => {
                        const childLocation = locations.find(
                          (candidate) =>
                            candidate.projectPath === location.projectPath &&
                            candidate.workingDirectory === workingDirectory,
                        );
                        return childLocation
                          ? Effect.succeed(childLocation)
                          : Effect.fail(
                              compositionError(
                                "createChild",
                                `Child Working Directory unavailable: ${workingDirectory}`,
                              ),
                            );
                      }),
                    ),
                  (workingDirectory) => managedWorktrees.discard(workingDirectory, false),
                )
                .pipe(Effect.provideService(ArtifactStorage, artifactStorage.value)),
            ),
            { signal },
          );
          // Register background children for live observation too; pane placement is optional.
          // This best-effort client request is not an admission dependency.
          if (result.launch.status !== "failed")
            void runtimeIntegrations
              .requestApplicationControl(
                {
                  _tag: "ProjectChildSession",
                  childSessionId: result.childSessionId,
                  title: input.title,
                  familyId: result.familyId,
                  familyChildOrder: result.familyChildOrder,
                  familyDepth: result.familyDepth,
                  workingDirectory: result.workingDirectory,
                  placement: input.placement,
                },
                signal,
              )
              .catch(() => undefined);
          return toJsonValue(result);
        },
        forkSession: async (input) => {
          const destinationWorkingDirectory =
            input.destinationWorkingDirectory ?? location.workingDirectory;
          if (Option.isNone(artifactStorage)) throw new Error("Artifact storage is unavailable");
          const result = await run(
            Effect.scoped(
              projectSessionAgentPolicy.assertCanFork(sessionId).pipe(
                Effect.andThen(
                  projectSessionContinuations.fork({
                    target: { sessionId, workingDirectory: location.workingDirectory },
                    entryId: input.entryId,
                    destinationWorkingDirectory,
                    resolveSource: input.resolveSource,
                  }),
                ),
                Effect.provideService(ArtifactStorage, artifactStorage.value),
              ),
            ),
          );
          await run(
            Effect.scoped(
              Effect.gen(function* () {
                const destination = (yield* projectSessionLocations.locations()).find(
                  (candidate) =>
                    candidate.workingDirectory === destinationWorkingDirectory &&
                    candidate.projectPath === location.projectPath,
                );
                if (!destination)
                  return yield* compositionError(
                    "fork",
                    "Destination Working Directory unavailable",
                  );
                yield* projectSessionOperations.acquireTarget(destination, result.sessionId, false);
              }),
            ),
          );
          if (input.title)
            await run(
              Effect.scoped(
                projectSessionOperations.rename(
                  {
                    sessionId: result.sessionId,
                    workingDirectory: destinationWorkingDirectory,
                  },
                  input.title,
                ),
              ),
            );
          if (input.prompt)
            await run(
              Effect.scoped(
                sessionChats.deliver(
                  {
                    sessionId: result.sessionId,
                    text: input.prompt,
                    attachments: [],
                    renderUserMessageAsMarkdown: false,
                  },
                  "prompt",
                ),
              ),
            );
          if (input.placement !== "none")
            void runtimeIntegrations
              .requestApplicationControl(
                {
                  _tag: "PresentForkSession",
                  sourceSessionId: sessionId,
                  forkSessionId: result.sessionId,
                  workingDirectory: destinationWorkingDirectory,
                  placement: input.placement,
                },
                new AbortController().signal,
              )
              .catch(() => undefined);
          return toJsonValue({
            ok: true,
            sessionId: result.sessionId,
            placement: input.placement,
            sourceResolved: input.resolveSource,
          });
        },
        pendingMessages: (targetSessionId, signal) =>
          run(
            Effect.scoped(
              Effect.gen(function* () {
                const target = yield* sessions
                  .acquireSession(targetSessionId)
                  .pipe(Effect.mapError((cause) => compositionError("pendingMessages", cause)));
                if (target.profile !== "ProjectSession")
                  return yield* compositionError(
                    "pendingMessages",
                    "The target is not a Project Session",
                  );
                return yield* target
                  .pendingMessages()
                  .pipe(Effect.mapError((cause) => compositionError("pendingMessages", cause)));
              }),
            ),
            { signal },
          ),
        reorderPendingMessage: (targetSessionId, reorder, signal) =>
          run(
            Effect.scoped(
              Effect.gen(function* () {
                const target = yield* sessions
                  .acquireSession(targetSessionId)
                  .pipe(Effect.mapError((cause) => compositionError("reorderPending", cause)));
                if (target.profile !== "ProjectSession")
                  return yield* compositionError(
                    "reorderPending",
                    "The target is not a Project Session",
                  );
                return yield* target
                  .reorderPendingMessage(reorder)
                  .pipe(Effect.mapError((cause) => compositionError("reorderPending", cause)));
              }),
            ),
            { signal },
          ),
        mergeSession: async (targetSessionId, signal) => {
          const target = await run(worktreeOperationTarget(targetSessionId), { signal });
          if (
            Option.isNone(landingCoordinator) ||
            Option.isNone(landingAgent) ||
            Option.isNone(landingCompletion)
          )
            throw new Error("Managed Worktree landing is unavailable");
          const operationId = crypto.randomUUID();
          await run(
            Effect.scoped(
              worktreeLandings
                .start({
                  operationId,
                  workspacePath: target.location.workingDirectory,
                  sessionId: target.sessionId,
                  strategy: "preserve",
                  allowDirtyTarget: false,
                  commitBeforeLanding: true,
                  resolveAfterLanding: false,
                })
                .pipe(
                  Effect.provideService(WorktreeLandingCoordinator, landingCoordinator.value),
                  Effect.provideService(WorktreeLandingAgent, landingAgent.value),
                  Effect.provideService(WorktreeLandingCompletion, landingCompletion.value),
                ),
            ),
            { signal },
          );
          return toJsonValue({
            ok: true,
            command: "worktrees.merge",
            operationId,
            sessionId: target.sessionId,
            workingDirectory: target.location.workingDirectory,
          });
        },
        discardSession: async (targetSessionId, keepBranch, signal) => {
          const target = await run(worktreeOperationTarget(targetSessionId), { signal });
          await run(managedWorktrees.discard(target.location.workingDirectory, keepBranch), {
            signal,
          });
          return toJsonValue({
            ok: true,
            command: "worktrees.discard",
            sessionId: target.sessionId,
            workingDirectory: target.location.workingDirectory,
            keepBranch,
          });
        },
        routeFamilyMessage: (command, untrustedInput, signal, senderContext) =>
          run(
            Effect.scoped(
              Schema.decodeUnknownEffect(sessionFamilyMessaging.FamilyMessageInput)(
                untrustedInput,
              ).pipe(
                Effect.mapError((cause) => compositionError("familyMessage", cause)),
                Effect.tap((input) => describeMessageReferences(input.messageRefs ?? [])),
                Effect.flatMap((input) =>
                  sessionFamilyMessaging.route(
                    { sessionId, location },
                    command,
                    input,
                    senderContext,
                  ),
                ),
              ),
            ),
            { signal },
          ),
        invokeAppControl: async (command, input, signal) => {
          await run(
            Effect.scoped(validateMessageReferenceControl({ name: command, arguments: input })),
            { signal },
          );
          const invocation = await run(
            forwardTaskInputControl(sessionId, { name: command, arguments: input }),
            { signal },
          );
          return runtimeIntegrations.requestApplicationControl(
            {
              _tag: "InvokeAppControl",
              command,
              input: Schema.decodeUnknownSync(jsonObjectSchema)(invocation.arguments),
            },
            signal,
          );
        },
      },
      sessionTitleChanged: (targetSessionId, title) =>
        run(
          Effect.gen(function* () {
            const records = yield* worktrees.records();
            const projectPath =
              records.find((record) => record.worktreePath === location.workingDirectory)
                ?.projectPath ?? location.workingDirectory;
            yield* catalogs.publish({
              _tag: "ProjectSessionTitleChanged",
              sessionId: targetSessionId,
              projectPath,
              title,
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
      browserControl: Option.isSome(browser)
        ? {
            enter: (signal) =>
              run(browser.value.enterProjectBrowser(sessionId, location.workingDirectory), {
                signal,
              }),
            cdp: (method, params, signal) =>
              run(
                browser.value.sendProjectCdp(sessionId, location.workingDirectory, method, params),
                { signal },
              ),
            events: (methods, limit, clear, signal) =>
              run(
                browser.value.takeProjectCdpEvents(
                  sessionId,
                  location.workingDirectory,
                  methods,
                  limit,
                  clear,
                ),
                { signal },
              ),
          }
        : undefined,
      vscodeControl: {
        enter: async (signal) => {
          await requestEditorControl("vscode.enter", {}, signal);
        },
        open: async (sourceLocation, signal) => {
          try {
            const response = await requestEditorControl(
              "vscode.open",
              agentEditorLocation(sourceLocation),
              signal,
            );
            const { selection } = await run(
              Schema.decodeUnknownEffect(Schema.Struct({ selection: EditorSelectionOpenResult }))(
                response,
              ),
              { signal },
            );
            return { status: "completed" as const, value: selection };
          } catch (error) {
            if (error instanceof Error && error.message.startsWith("VSCODE_MODE_REQUIRED:"))
              return { status: "mode-required" as const };
            throw error;
          }
        },
        listSelections: async (signal) => {
          const response = await requestEditorControl("vscode.selections.list", {}, signal);
          return (
            await run(
              Schema.decodeUnknownEffect(Schema.Struct({ state: EditorSelectionState }))(response),
              { signal },
            )
          ).state;
        },
        removeSelection: async (id, signal) => {
          const response = await requestEditorControl("vscode.selections.remove", { id }, signal);
          return (
            await run(
              Schema.decodeUnknownEffect(Schema.Struct({ update: EditorSelectionUpdate }))(
                response,
              ),
              { signal },
            )
          ).update;
        },
        clearSelections: async (signal) => {
          const response = await requestEditorControl("vscode.selections.clear", {}, signal);
          return (
            await run(
              Schema.decodeUnknownEffect(Schema.Struct({ update: EditorSelectionUpdate }))(
                response,
              ),
              { signal },
            )
          ).update;
        },
        runScript: async (source, input, signal) => {
          if (Option.isNone(vscode)) throw new Error("VS Code is unavailable in this host");
          return run(vscode.value.runProjectScript(location.workingDirectory, source, input), {
            signal,
          });
        },
      },
    },
  };
  return runtimeOptions;
});
