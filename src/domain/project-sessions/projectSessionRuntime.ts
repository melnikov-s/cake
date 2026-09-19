import * as sessionFamilies from "../session-families/sessionFamilies";
import * as projectSessionLocations from "./projectSessionLocations";
import * as managedWorktrees from "../worktrees/managedWorktrees";
import { Effect, Option, Schema, Schedule } from "effect";
import {
  setProjectSessionLabelsIfUnlabelled,
  setSessionFastMode,
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
import { Electron } from "../../services/electron/Electron";
import type { PiModels } from "../../services/pi/PiModels";
import { PiSessions, type PiSessionAcquireOptions } from "../../services/pi/PiSessions";
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
  const configuration = yield* ProjectSessionConfiguration;
  const electron = yield* Electron;
  const runtimeHost = yield* ProjectSessionRuntimeHost;
  const sessions = yield* PiSessions;
  const families = yield* SessionFamilyStorage;
  const catalogs = yield* SessionCatalogChanges;
  const browser = yield* Effect.serviceOption(Browser);
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
  const runtimeOptions: PiSessionAcquireOptions = {
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
          runtimeIntegrations.requestApplicationControl(
            { _tag: "CreateSession", ...input },
            signal,
          ),
        createDraftSession: (input, signal) =>
          runtimeIntegrations.requestApplicationControl({ _tag: "CreateDraft", ...input }, signal),
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
          if (result.launch.status === "failed") return toJsonValue(result);
          const presentation = await runtimeIntegrations
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
          return runtimeIntegrations.requestApplicationControl(
            {
              _tag: "InvokeAppControl",
              command: "worktrees.merge",
              input: {
                sessionId: target.sessionId,
                workingDirectory: target.location.workingDirectory,
              },
            },
            signal,
          );
        },
        discardSession: async (targetSessionId, keepBranch, signal) => {
          const target = await run(worktreeOperationTarget(targetSessionId), { signal });
          return runtimeIntegrations.requestApplicationControl(
            {
              _tag: "InvokeAppControl",
              command: "worktrees.discard",
              input: {
                sessionId: target.sessionId,
                workingDirectory: target.location.workingDirectory,
                keepBranch,
              },
            },
            signal,
          );
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
