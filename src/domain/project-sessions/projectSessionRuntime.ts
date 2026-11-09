import type { MergeReadiness } from "../../contracts/worktrees/auto-merge";
import type { DiscussionTitleRequests } from "../../services/discussion-sessions/DiscussionTitleRequests";
import * as autoMergeReadiness from "../worktrees/autoMergeReadiness";
import { makeTurnLifecycle } from "./projectSessionTurnLifecycle";
import type { invokeGlobalArtifactCommand } from "../artifacts/globalArtifacts";
import type { AutomationRecords } from "../../services/automations/AutomationRecords";
import type { AutomationConfiguration } from "../../services/automations/AutomationConfiguration";
import type { OptMemory } from "../../services/opt-memory/OptMemory";
import * as sessionFamilyAdmission from "../session-families/sessionFamilyAdmission";
import * as backendAgentControl from "../application/agentControl";
import type { PiSettings } from "../../services/pi/PiSettings";
import type { McpSettings } from "../../services/pi/McpSettings";
import type { WidgetPackages } from "../../services/widgets/WidgetPackages";
import type { SessionCoordination } from "../../services/session-catalogs/SessionCoordination";
import { CakeChatConfiguration } from "../../services/pi-durable/CakeChatConfiguration";
import { ProjectTodoReports } from "../../services/projects/ProjectTodoReports";
import * as sessionFamilyMessaging from "../session-families/sessionFamilyMessaging";
import * as projectSessionAgentPolicy from "./projectSessionAgentPolicy";
import { cakeModelCatalog, resolveCakeModelSelection } from "../model-presets/cake-model-selection";
import * as projectSessionLocations from "./projectSessionLocations";
import * as projectChatInstructions from "../projects/projectChatInstructions";
import { reuseRecent } from "../../utils/reuse-recent";
import * as sessionReferences from "./sessionReferences";
import * as managedWorktrees from "../worktrees/managedWorktrees";
import * as worktreeMerges from "../worktrees/worktreeMerges";
import { WorktreeLandingCoordinator } from "../../services/worktrees/WorktreeLandingCoordinator";
import { WorktreeLandingAgent } from "../../services/worktrees/WorktreeLandingAgent";
import { WorktreeLandingCompletion } from "../../services/worktrees/WorktreeLandingCompletion";
import * as projectSessionCreation from "./projectSessionCreation";
import * as savedDrafts from "./savedDrafts";
import { SavedDraftStorage } from "../../services/storage/SavedDraftStorage";
import type { TaskInputStorage } from "../../services/storage/TaskInputStorage";
import { snapshotPromptFiles } from "../../services/filesystem/prompt-files";
import * as projectSessionContinuations from "./projectSessionContinuations";
import * as projectSessionOperations from "./projectSessionOperations";
import * as sessionChats from "../conversations/sessionChats";
import { inheritTaskInputProtection } from "../conversations/taskInputs";
import { Context, Effect, Option, Schema, type FileSystem, type Path } from "effect";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";
import type { ModelPresetPrompts } from "../../services/storage/ModelPresetPrompts";
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
import { browserStartupUrl } from "../../contracts/browser/browser-default-url";
import { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import { ArtifactStorage } from "../../services/storage/ArtifactStorage";
import { MessageBoardStorage } from "../../services/storage/MessageBoardStorage";
import { RuntimeRecoveryStorage } from "../../services/storage/RuntimeRecoveryStorage";
import { resolutionNamespace } from "./projectSessionResolution";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import { familyMember } from "../../contracts/session-families/session-family-document";
import type { SubagentCoordinator } from "../../services/subagents/SubagentCoordinator";
import type { SubagentEnvironment } from "../../services/subagents/SubagentEnvironment";
import { VsCodeServer } from "../../services/vscode/VsCodeServer";
import { Browser } from "../../services/browser/Browser";
import { ManagedWorktrees } from "../../services/worktrees/ManagedWorktrees";
import type { Terminal } from "../../services/terminal/Terminal";
import { toJsonValue } from "../../utils/to-json-value";
import { makeVscodeControl } from "../../services/pi/VscodeControlAdapter";
import { jsonObjectSchema } from "../../contracts/serialization/json-contract";

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
  preserveResolution = false,
  sideChatSessionId,
}: {
  readonly sideChatSessionId?: string;
  readonly preserveResolution?: boolean;
  readonly location: ProjectSessionLocation;
  readonly sessionId: string;
  readonly newSession: boolean;
}): Effect.fn.Return<
  CakeSessionRuntimeAcquireOptions,
  ProjectSessionRuntimeCompositionError,
  | AutomationRecords
  | AutomationConfiguration
  | OptMemory
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner
  | ModelPresetPrompts
  | ApplicationState
  | DiscussionTitleRequests
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
  | PiSettings
  | McpSettings
  | WidgetPackages
  | SessionCoordination
  | Effect.Services<ReturnType<typeof invokeGlobalArtifactCommand>>
> {
  const access = yield* ProjectAccess;
  const application = yield* ApplicationState;
  const archive = yield* SessionArchiveStorage;
  const artifactStorage = yield* Effect.serviceOption(ArtifactStorage);
  const messageBoardStorage = yield* Effect.serviceOption(MessageBoardStorage);
  const recoveryStorage = yield* Effect.serviceOption(RuntimeRecoveryStorage);
  const savedDraftStorage = yield* Effect.serviceOption(SavedDraftStorage);
  const landingCoordinator = yield* Effect.serviceOption(WorktreeLandingCoordinator);
  const landingAgent = yield* Effect.serviceOption(WorktreeLandingAgent);
  const landingCompletion = yield* Effect.serviceOption(WorktreeLandingCompletion);
  const configuration = yield* ProjectSessionConfiguration;
  const runtimeHost = yield* ProjectSessionRuntimeHost;
  const sessions = yield* CakeSessionRuntimes;
  const families = yield* SessionFamilyStorage;
  const catalogs = yield* SessionCatalogChanges;
  const browser = yield* Effect.serviceOption(Browser);
  const vscode = yield* Effect.serviceOption(VsCodeServer);
  const worktrees = yield* ManagedWorktrees;
  const context = yield* Effect.context<
    | AutomationRecords
    | AutomationConfiguration
    | OptMemory
    | FileSystem.FileSystem
    | Path.Path
    | HttpClient.HttpClient
    | ChildProcessSpawner.ChildProcessSpawner
    | ModelPresetPrompts
    | ApplicationState
    | DiscussionTitleRequests
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
    | PiSettings
    | McpSettings
    | WidgetPackages
    | SessionCoordination
    | Effect.Services<ReturnType<typeof invokeGlobalArtifactCommand>>
  >();
  const chatConfiguration = yield* Effect.serviceOption(CakeChatConfiguration);
  const todoReports = yield* Effect.serviceOption(ProjectTodoReports);
  const reportContext = Option.isSome(todoReports)
    ? Context.add(context, ProjectTodoReports, todoReports.value)
    : context;
  const configuredContext = Option.isSome(chatConfiguration)
    ? Context.add(reportContext, CakeChatConfiguration, chatConfiguration.value)
    : reportContext;
  const run = makePiCallbackExecutor(
    Option.isSome(savedDraftStorage)
      ? Context.add(configuredContext, SavedDraftStorage, savedDraftStorage.value)
      : configuredContext,
  );
  // Every model request whose context holds a cross-session message shortens its references
  // against all known sessions. Share one discovery per minute; the full ID always resolves.
  const sessionReferenceIds = reuseRecent(60_000, () =>
    run(
      sessionReferences
        .catalog()
        .pipe(Effect.map((roster) => roster.map((entry) => entry.sessionId))),
    ),
  );
  const agentControl = makeSubagentControl({
    runEffect: (effect, signal) => run(effect, { signal }),
  });
  const modelPresets = () => cakeModelCatalog(application.snapshot());

  yield* access
    .rememberSessionLocation(location.workingDirectory, sessionId)
    .pipe(Effect.mapError((cause) => compositionError("acquireOptions", cause)));
  const preparedRuntime = yield* runtimeHost
    .prepare(location.workingDirectory, sessionId)
    .pipe(Effect.mapError((cause) => compositionError("prepareRuntime", cause)));
  const runtimeIntegrations = preparedRuntime.integrations;
  const family = yield* families
    .familyForMember(sessionId)
    .pipe(Effect.mapError((cause) => compositionError("acquireOptions", cause)));
  const member = family && familyMember(family, sessionId);
  const isChild = member?.parentSessionId !== undefined;
  // Clear former per-member resolution metadata without changing inherited
  // family resolution. Storage migrates any old archived transcript in place.
  if (
    !preserveResolution &&
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
          // The binding already supplies the authoritative identity. A short ref
          // would require global discovery to exclude suffix collisions, blocking
          // cold opens on unrelated projects and archived sessions.
          parentSessionId: member.parentSessionId,
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
  const runtimeOptions: CakeSessionRuntimeAcquireOptions = {
    profile: { _tag: "ProjectSession" },
    onInitialize: preparedRuntime.initialize,
    onRelease: preparedRuntime.release,
    onSessionChanged: catalogs.publish({
      _tag: "ProjectSessionChanged",
      sessionId,
      projectPath: location.projectPath,
      workingDirectory: location.workingDirectory,
      resolved: false,
    }),
    ...(yield* makeTurnLifecycle({ sessionId, location })),
    runtime: {
      ...runtimeIntegrations,
      sessionReferences: {
        resolve: (reference, signal) =>
          reference === "parent" && sideChatSessionId
            ? Promise.resolve(sessionId)
            : run(sessionReferences.resolve(reference, sessionId), { signal }),
        project: (value, signal) => run(sessionReferences.project(value), { signal }),
        ids: () => sessionReferenceIds(),
      },
      agentControl: agentControl(getRuntimeOptions, location.workingDirectory),
      projectChatInstructions: {
        get: (input, signal) =>
          run(projectChatInstructions.get(input, location.projectPath), { signal }),
        update: (input, signal) =>
          run(projectChatInstructions.updateFromProjectSession(input, location.projectPath), {
            signal,
          }),
      },
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
      cwd: location.workingDirectory,
      agentDir: configuration.agentDirectory,
      additionalSystemPrompt: [
        relationshipPrompt,
        globalInstructions && `## Personal global instructions\n\n${globalInstructions}`,
        projectInstructions && `## Personal project instructions\n\n${projectInstructions}`,
        projectPrompt,
      ]
        .filter(Boolean)
        .join("\n\n"),
      worktreeLanding: projectSettings?.worktreeLanding ?? "merge",
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
      // The Subagent default model setting is Cake Chat-only: Project Session subagents
      // resolve an omitted model exactly like session launches (the default preset).
      resolveModelSelection: (selection, caller) =>
        resolveCakeModelSelection(selection, modelPresets(), caller),
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
        snapshotPromptFiles: (text, promptFiles, signal) =>
          run(
            snapshotPromptFiles({
              text,
              promptFiles,
              senderSessionId: sessionId,
              workingDirectory: location.workingDirectory,
            }),
            { signal },
          ),
        createSession: (input, signal) =>
          run(
            Effect.scoped(
              projectSessionCreation.createPrompted({
                ...input,
                source: {
                  sessionId: sideChatSessionId ?? sessionId,
                  kind: "project-session",
                  title: "Project Session",
                },
                senderWorkingDirectory: location.workingDirectory,
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
          await run(
            families.registerParent({
              sessionId: record.sessionId,
              parentSessionId: sideChatSessionId ?? sessionId,
              projectPath: location.projectPath,
            }),
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
          if (
            Option.isNone(artifactStorage) ||
            Option.isNone(messageBoardStorage) ||
            Option.isNone(recoveryStorage)
          )
            throw new Error("Child assignment launch storage is unavailable");
          const result = await run(
            Effect.scoped(
              sessionFamilyAdmission
                .createChild(
                  sessionId,
                  location,
                  input,
                  (childId, childLocation, newSession) =>
                    inheritTaskInputProtection(sessionId, childId).pipe(
                      Effect.mapError((error) => compositionError("createChild", error)),
                      Effect.andThen(
                        acquireOptions({
                          location: childLocation,
                          sessionId: childId,
                          newSession,
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
                .pipe(
                  Effect.provideService(ArtifactStorage, artifactStorage.value),
                  Effect.provideService(MessageBoardStorage, messageBoardStorage.value),
                  Effect.provideService(RuntimeRecoveryStorage, recoveryStorage.value),
                ),
            ),
            { signal },
          );
          // Register background children for live observation too; opening them is optional.
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
                  open: input.open,
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
                    title: input.title,
                    prompt: input.prompt,
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
          if (input.open)
            void runtimeIntegrations
              .requestApplicationControl(
                {
                  _tag: "PresentForkSession",
                  sourceSessionId: sessionId,
                  forkSessionId: result.sessionId,
                  workingDirectory: destinationWorkingDirectory,
                },
                new AbortController().signal,
              )
              .catch(() => undefined);
          return toJsonValue({
            ok: true,
            sessionId: result.sessionId,
            open: input.open,
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
        mergeSession:
          projectSettings?.worktreeLanding === "pull-request"
            ? undefined
            : async (targetSessionId, signal) => {
                const target = await run(worktreeOperationTarget(targetSessionId), { signal });
                if (
                  Option.isNone(landingCoordinator) ||
                  Option.isNone(landingAgent) ||
                  Option.isNone(landingCompletion)
                )
                  throw new Error("Managed Worktree landing is unavailable");
                return toJsonValue(
                  await run(
                    Effect.scoped(
                      worktreeMerges
                        .merge({
                          sessionId: target.sessionId,
                          workspacePath: target.location.workingDirectory,
                          callerSessionId: sessionId,
                        })
                        .pipe(
                          Effect.provideService(
                            WorktreeLandingCoordinator,
                            landingCoordinator.value,
                          ),
                          Effect.provideService(WorktreeLandingAgent, landingAgent.value),
                          Effect.provideService(WorktreeLandingCompletion, landingCompletion.value),
                        ),
                    ),
                    { signal },
                  ),
                );
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
        routeFamilyMessage: sideChatSessionId
          ? undefined
          : (command, untrustedInput, signal, senderContext, sourceEntryId) =>
              run(
                Effect.scoped(
                  Schema.decodeUnknownEffect(sessionFamilyMessaging.FamilyMessageInput)(
                    untrustedInput,
                  ).pipe(
                    Effect.mapError((cause) => compositionError("familyMessage", cause)),
                    Effect.tap((input) => describeMessageReferences(input.messageRefs ?? [])),
                    Effect.flatMap((input) =>
                      sessionFamilyMessaging.route(
                        { sessionId, location, sourceEntryId },
                        command,
                        input,
                        senderContext,
                      ),
                    ),
                  ),
                ),
                { signal },
              ),
        invokeAppControl: async (command, input, signal, sourceEntryId) => {
          if (command === "sessions.send")
            input = {
              ...input,
              sessionId: await run(
                sessionReferences.messageTarget(
                  Schema.decodeUnknownSync(
                    Schema.Struct({ sessionId: Schema.optionalKey(Schema.String) }),
                  )(input).sessionId,
                  sideChatSessionId ?? sessionId,
                ),
                { signal },
              ),
            };
          else if (
            command !== "sessions.compact" &&
            command !== "sessions.tool-compact" &&
            (backendAgentControl.handles(command) || command === "sessions.open") &&
            Schema.is(Schema.String)(input.sessionId)
          )
            input = {
              ...input,
              sessionId: await run(
                input.sessionId === "parent" && sideChatSessionId
                  ? Effect.succeed(sessionId)
                  : sessionReferences.resolve(input.sessionId, sessionId),
                {
                  signal,
                },
              ),
            };
          await run(
            Effect.scoped(validateMessageReferenceControl({ name: command, arguments: input })),
            { signal },
          );
          const invocation = await run(
            forwardTaskInputControl(sessionId, { name: command, arguments: input }),
            { signal },
          );
          const result = !backendAgentControl.handles(command)
            ? undefined
            : await run(
                Effect.scoped(
                  Effect.gen(function* () {
                    const summary = yield* sessions.catalogEntry(
                      {
                        workingDirectory: location.workingDirectory,
                        sessionDirectory: location.sessionDirectory,
                      },
                      sessionId,
                    );
                    return yield* backendAgentControl.invoke(command, invocation.arguments, {
                      kind: "project-session",
                      sourceEntryId,
                      sessionId:
                        sideChatSessionId &&
                        (command === "sessions.send" ||
                          command === "sessions.reply" ||
                          command === "sessions.thread" ||
                          command === "sessions.close-thread")
                          ? sideChatSessionId
                          : sessionId,
                      title: sideChatSessionId
                        ? `Side chat of ${summary?.title ?? sessionId}`
                        : (summary?.title ?? `Project Session ${sessionId}`),
                      projectPath: location.projectPath,
                      projectName: location.projectName,
                      workingDirectory: location.workingDirectory,
                    });
                  }),
                ),
                { signal },
              );
          if (result !== undefined) return result;
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
            reportReadiness:
              projectSettings?.worktreeLanding !== "pull-request" &&
              Option.isSome(landingCoordinator)
                ? (readiness: MergeReadiness) =>
                    run(
                      autoMergeReadiness
                        .report(
                          {
                            sessionId,
                            workingDirectory: location.workingDirectory,
                            sessionDirectory: location.sessionDirectory,
                          },
                          readiness,
                        )
                        .pipe(
                          Effect.provideService(
                            WorktreeLandingCoordinator,
                            landingCoordinator.value,
                          ),
                        ),
                    )
                : undefined,
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
              run(
                browser.value.enterProjectBrowser(
                  sessionId,
                  location.workingDirectory,
                  browserStartupUrl(
                    application
                      .snapshot()
                      .projects.find((project) => project.path === location.projectPath)?.settings
                      ?.browserDefaultUrl,
                  ),
                ),
                { signal },
              ),
            cdp: (method, params, signal, timeoutMs) =>
              run(
                browser.value.sendProjectCdp(
                  sessionId,
                  location.workingDirectory,
                  method,
                  params,
                  timeoutMs,
                ),
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
      vscodeControl: makeVscodeControl({
        request: async (command, input, signal) => {
          if (Option.isNone(vscode)) throw new Error("VS Code is unavailable in this host");
          return runtimeIntegrations.requestApplicationControl(
            { _tag: "InvokeAppControl", command, input },
            signal,
          );
        },
        runScript: async (source, input, signal) => {
          if (Option.isNone(vscode)) throw new Error("VS Code is unavailable in this host");
          return run(vscode.value.runProjectScript(location.workingDirectory, source, input), {
            signal,
          });
        },
      }),
    },
  };
  return runtimeOptions;
});
