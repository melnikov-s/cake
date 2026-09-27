import * as sessionFamilies from "../session-families/sessionFamilies";
import * as projectSessionLocations from "./projectSessionLocations";
import * as managedWorktrees from "../worktrees/managedWorktrees";
import * as worktreeLandings from "../worktrees/worktreeLandings";
import { WorktreeLandingCoordinator } from "../../services/worktrees/WorktreeLandingCoordinator";
import { WorktreeLandingAgent } from "../../services/worktrees/WorktreeLandingAgent";
import { WorktreeLandingCompletion } from "../../services/worktrees/WorktreeLandingCompletion";
import * as projectSessionCreation from "./projectSessionCreation";
import * as savedDrafts from "./savedDrafts";
import { SavedDraftStorage } from "../../services/storage/SavedDraftStorage";
import * as projectSessionContinuations from "./projectSessionContinuations";
import * as projectSessionOperations from "./projectSessionOperations";
import * as sessionChats from "../conversations/sessionChats";
import { Effect, Option, Schema, Schedule } from "effect";
import {
  deleteSessionPlugin,
  setProjectSessionLabelsIfUnlabelled,
  setSessionFastMode,
  setSessionPluginState,
  patchSessionPluginState,
  upsertSessionPlugin,
} from "../application/application";
import {
  crossSessionContextSnapshot,
  encodeCrossSessionMessage,
  type CrossSessionContextSnapshot,
} from "../conversations/cross-session-coordination";
import type { ProjectSessionLocation } from "./project-session-data";
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
import { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import { ArtifactStorage } from "../../services/storage/ArtifactStorage";
import { resolutionNamespace } from "./projectSessionResolution";
import {
  SessionFamilyStorage,
  familyChildren,
  familyMember,
} from "../../services/storage/SessionFamilyStorage";
import type { SubagentCoordinator } from "../../services/subagents/SubagentCoordinator";
import type { SubagentEnvironment } from "../../services/subagents/SubagentEnvironment";
import { VsCodeServer } from "../../services/vscode/VsCodeServer";
import { Browser } from "../../services/browser/Browser";
import { ManagedWorktrees } from "../../services/worktrees/ManagedWorktrees";
import type { Terminal } from "../../services/terminal/Terminal";
import { toJsonValue } from "../../utils/to-json-value";
import { agentEditorLocation } from "../../utils/agent-editor-location";
import type { JsonObject } from "../../ipc/json-contract";
import {
  EditorSelectionOpenResult,
  EditorSelectionState,
  EditorSelectionUpdate,
} from "../../ipc/editor-selection";

const FamilyMessageInput = Schema.Struct({
  sessionId: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
  delivery: Schema.optionalKey(Schema.Literals(["prompt", "queue", "steer"])),
  threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
  maxMessages: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000)),
  ),
  expectsResponse: Schema.optionalKey(Schema.Boolean),
  replyToMessageId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
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
  const artifactStorage = yield* Effect.serviceOption(ArtifactStorage);
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
  >();
  const run = makePiCallbackExecutor(context);
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
  // Child transcripts from the former per-member lifecycle may still be archived.
  // Moving one into Pi's runtime namespace does not change inherited resolution.
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
          parentSessionId: member.parentSessionId,
          workingDirectory: member.workingDirectory,
        })
      : renderProjectSessionPrompt(parentSessionFamilyPromptTemplate);
  const setupInstructions = location.managedWorktree
    ? application
        .snapshot()
        .projects.find((project) => project.path === location.projectPath)
        ?.settings?.worktreeSetupInstructions.trim()
    : undefined;
  const projectPrompt = setupInstructions
    ? `## Project worktree setup instructions\n\n${setupInstructions}`
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
      families.settleTurn(event.turnId, event.outcome).pipe(
        Effect.tapError((error) => Effect.logError("Retrying durable family settlement", error)),
        Effect.retry(Schedule.spaced("1 second")),
      ),
    runtime: {
      ...runtimeIntegrations,
      agentControl: agentControl(getRuntimeOptions, location.workingDirectory),
      cwd: location.workingDirectory,
      trusted: application.snapshot().trustedProjectPaths.includes(location.workingDirectory),
      agentDir: configuration.agentDirectory,
      additionalSystemPrompt: [relationshipPrompt, projectPrompt].filter(Boolean).join("\n\n"),
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
        familyInfo: family
          ? () => {
              const info = {
                familyId: family.familyId,
                parentSessionId: member?.parentSessionId ?? family.parentSessionId,
                role: isChild ? "child" : "root",
                childSessionIds: familyChildren(family, sessionId).map((child) => child.sessionId),
              };
              return toJsonValue(info);
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
          run(
            Effect.scoped(
              projectSessionCreation.createPrompted({
                ...input,
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
          const result = await run(
            Effect.scoped(
              sessionFamilies.createChild(
                sessionId,
                location,
                input,
                (childId, childLocation) =>
                  acquireOptions({
                    location: childLocation,
                    sessionId: childId,
                    newSession: true,
                  }),
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
              ),
            ),
            { signal },
          );
          // Pane placement is a best-effort client request, not an admission dependency.
          if (result.launch.status !== "failed" && input.placement !== "none")
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
        forkSession: family
          ? undefined
          : async (input) => {
              const destinationWorkingDirectory =
                input.destinationWorkingDirectory ?? location.workingDirectory;
              if (Option.isNone(artifactStorage))
                throw new Error("Artifact storage is unavailable");
              const result = await run(
                Effect.scoped(
                  projectSessionContinuations
                    .fork({
                      target: { sessionId, workingDirectory: location.workingDirectory },
                      entryId: input.entryId,
                      destinationWorkingDirectory,
                      resolveSource: input.resolveSource,
                    })
                    .pipe(Effect.provideService(ArtifactStorage, artifactStorage.value)),
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
                    yield* projectSessionOperations.acquireTarget(
                      destination,
                      result.sessionId,
                      false,
                    );
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
        routeFamilyMessage: (
          command,
          untrustedInput,
          signal,
          senderContext?: CrossSessionContextSnapshot,
        ) =>
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
                const executingTurnIds =
                  command === "sessions.reply"
                    ? yield* sessions.executingTurnIds({
                        sessionId,
                        workingDirectory: location.workingDirectory,
                        sessionDirectory: location.sessionDirectory,
                      })
                    : [];
                const pending =
                  command === "sessions.reply"
                    ? yield* families.pendingResponseRequest(
                        sessionId,
                        executingTurnIds,
                        input.threadId,
                        input.replyToMessageId,
                      )
                    : undefined;
                if (command === "sessions.reply" && !pending) return undefined;
                const targetSessionId = pending?.senderSessionId ?? input.sessionId;
                if (!targetSessionId)
                  return yield* compositionError("familyMessage", "A target session is required");
                const destinationMember = familyMember(family, targetSessionId);
                if (!destinationMember) return undefined;
                const destinationLocation = (yield* projectSessionLocations.locations({
                  includeInactive: true,
                })).find(
                  (candidate) =>
                    candidate.projectPath === family.projectPath &&
                    candidate.workingDirectory === destinationMember.workingDirectory,
                );
                if (!destinationLocation)
                  return yield* compositionError(
                    "familyMessage",
                    `Working Directory unavailable: ${destinationMember.workingDirectory}`,
                  );
                const namespace = yield* resolutionNamespace(targetSessionId, {
                  cwd: destinationMember.workingDirectory,
                  activeRoot: configuration.sessionDirectory,
                  resolvedRoot: configuration.resolvedSessionDirectory,
                }).pipe(Effect.mapError((cause) => compositionError("familyMessage", cause)));
                if (namespace === "resolved")
                  return yield* compositionError(
                    "familyMessage",
                    `Session Family ${family.familyId} is resolved; restore it explicitly before messaging`,
                  );
                if (!namespace)
                  return yield* compositionError(
                    "familyMessage",
                    `Family member ${targetSessionId} could not be found`,
                  );
                const destination = yield* sessions.acquire(
                  yield* acquireOptions({
                    location: destinationLocation,
                    sessionId: targetSessionId,
                    newSession: false,
                  }),
                );
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
                const threadId = pending?.threadId ?? input.threadId ?? crypto.randomUUID();
                const replyToMessageId = pending?.requestMessageId ?? input.replyToMessageId;
                const expectsResponse = input.expectsResponse ?? command === "sessions.send";
                const messageMetadata = {
                  version: 1 as const,
                  messageId,
                  threadId,
                  sequence: 1,
                  expectsResponse,
                  ...(replyToMessageId ? { replyToMessageId } : null),
                  ...(senderContext ? { context: senderContext } : null),
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
                if (
                  replyToMessageId &&
                  !(yield* families.prepareResponse(
                    sessionId,
                    targetSessionId,
                    replyToMessageId,
                    messageId,
                    executingTurnIds,
                  ))
                )
                  return yield* compositionError(
                    "familyMessage",
                    `Request ${replyToMessageId} is not awaiting a response from this session`,
                  );
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
                if (replyToMessageId) yield* families.confirmResponse(messageId);
                const pendingAfterSend =
                  delivery === "queue"
                    ? yield* destination
                        .pendingMessages()
                        .pipe(Effect.catch(() => Effect.succeed(undefined)))
                    : undefined;
                const queuedItem = pendingAfterSend?.items.find(
                  (item) => item.crossSession?.messageId === messageId,
                );
                const queue =
                  queuedItem && pendingAfterSend
                    ? {
                        itemId: queuedItem.itemId,
                        lane: queuedItem.lane,
                        position: queuedItem.position,
                        length: pendingAfterSend.items.filter(
                          (item) => item.lane === queuedItem.lane,
                        ).length,
                      }
                    : undefined;
                yield* catalogs.publish({
                  _tag: "ProjectSessionChanged",
                  sessionId: targetSessionId,
                  projectPath: location.projectPath,
                  workingDirectory: destinationLocation.workingDirectory,
                  resolved: false,
                });
                return toJsonValue({
                  ok: true,
                  command,
                  targetTitle: `Project Session ${targetSessionId}`,
                  messageId,
                  threadId,
                  turnId,
                  delivery,
                  expectsResponse,
                  ...(replyToMessageId ? { replyToMessageId } : null),
                  status: delivery === "queue" ? "queued" : "accepted",
                  recipientContext: crossSessionContextSnapshot(destinationSnapshot.usage?.context),
                  ...(queue ? { queue } : null),
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
