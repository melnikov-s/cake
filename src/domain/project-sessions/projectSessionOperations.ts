import { Effect, Exit, Schedule, Stream } from "effect";
import type { SessionPurpose } from "../../contracts/project-sessions/session-purpose";
import type { ResultDelivery } from "../../contracts/conversations/result-delivery";
import { isCakeChatSessionId } from "../../contracts/cake-chats/cake-chat-identity";
import { projectChatSessionId } from "../cake-chats/cakeChatLocations";
import {
  ensureAdmittedSession as ensureSessionTodo,
  existingTaskScope,
  attachExisting,
  detachAdmission,
} from "../projects/projectTodos";
import { parseCrossSessionMessage } from "../../contracts/conversations/cross-session-message";
import type { JsonObject } from "../../contracts/serialization/json-contract";
import { SESSION_TITLE_MAX_LENGTH } from "../../contracts/conversations/session-contract";
import { setProjectSessionLabels } from "../application/application";
import * as managedWorktrees from "../worktrees/managedWorktrees";
import * as projectSessionLifecycle from "./projectSessionLifecycle";
import {
  TurnId,
  acquire as acquireConversation,
  deliverWhenAvailable,
  observe as observeConversationUpdates,
  projectAttachments,
  projectPreviewSnapshot,
  use as useConversation,
} from "../conversations/conversations";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import { prepareTaskInputs } from "../conversations/taskInputs";
import type { ProjectSessionLocation } from "../../contracts/project-sessions/project-session-data";
import * as projectSessionLocations from "./projectSessionLocations";
import { resolutionNamespace } from "./projectSessionResolution";
import { acquireOptions } from "./projectSessionRuntime";
import {
  ProjectSessionError,
  type ProjectSessionCompanionActionInput,
  type ProjectSessionPromptInput,
  type ProjectSessionStartInput,
  type ProjectSessionTarget,
} from "../../contracts/project-sessions/project-session-data";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import { ManagedWorktrees } from "../../services/worktrees/ManagedWorktrees";
import {
  archiveLocation,
  asError,
  findLocation,
  inspect,
  publishCatalogChange,
  publishTargetCatalogChange,
} from "./projectSessionMetadata";

export const acquireTarget = Effect.fn("ProjectSessions.acquireTarget")(function* (
  location: ProjectSessionLocation,
  sessionId: string,
  newSession: boolean,
) {
  const sessions = yield* CakeSessionRuntimes;
  // Older implicit restores could reactivate the transcript without recreating
  // its retired checkout. Preserve the binding and repair only that known state.
  if (!newSession && location.managedWorktree?.state === "resolved")
    yield* managedWorktrees.restoreResolved(location.workingDirectory).pipe(asError("acquire"));
  yield* (yield* ManagedWorktrees).awaitSetup(location.workingDirectory).pipe(asError("acquire"));
  const options = yield* acquireOptions({ location, sessionId, newSession }).pipe(
    asError("acquire"),
  );
  return yield* acquireConversation(sessions, options).pipe(asError("acquire"));
});

/** Maintenance may load resolved history but must never restore a retired checkout
 * or migrate legacy child resolution as a side effect of acquisition.
 */
export const acquireMaintenanceTarget = Effect.fn("ProjectSessions.acquireMaintenanceTarget")(
  function* (location: ProjectSessionLocation, sessionId: string) {
    yield* (yield* ManagedWorktrees).awaitSetup(location.workingDirectory).pipe(asError("acquire"));
    const options = yield* acquireOptions({
      location,
      sessionId,
      newSession: false,
      preserveResolution: true,
    }).pipe(asError("acquire"));
    return yield* acquireConversation(yield* CakeSessionRuntimes, options).pipe(asError("acquire"));
  },
);

const acquireExistingTarget = Effect.fn("ProjectSessions.acquireExistingTarget")(function* (
  target: ProjectSessionTarget,
) {
  const location = yield* findLocation(target);
  return yield* acquireTarget(location, target.sessionId, false);
});

export interface SessionPurposeActor {
  readonly kind: "user" | "project-session" | "cake-chat";
  readonly sessionId?: string;
  readonly title?: string;
}

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The one relationship conversion path for the interface and sessions.set-purpose, either
 * direction: metadata only, never acquire or interrupt Pi. Moving to User retires owed reports,
 * tells each other owner and cancels awaiting auto-merges; moving to Delegated makes the acting
 * session (a human's Project Chat) the owner of results from work running now. */
export const setPurpose = Effect.fn("ProjectSessions.setPurpose")(function* (
  target: ProjectSessionTarget,
  purpose: SessionPurpose,
  actor: SessionPurposeActor,
  resultDelivery: ResultDelivery = "notification",
) {
  const sessionId = target.sessionId;
  const location = yield* findLocation(target);
  // A human delegating from the interface hands the session to its project's Project Chat.
  const delegator =
    actor.kind === "user"
      ? {
          kind: "cake-chat" as const,
          sessionId: projectChatSessionId(location.projectPath),
          title: `${location.projectName} Project Chat`,
        }
      : actor;
  const ownerId = delegator.sessionId;
  if (purpose === "delegated" && (!ownerId || ownerId === sessionId))
    return yield* new ProjectSessionError({
      operation: "setPurpose",
      message: "A session cannot own itself; call from the session that will own it.",
    });
  const storage = yield* SessionFamilyStorage;
  const runtimes = yield* CakeSessionRuntimes;
  const runtime = {
    workingDirectory: location.workingDirectory,
    sessionDirectory: location.sessionDirectory,
    sessionId,
  };
  const running = Boolean((yield* runtimes.currentStatus(runtime))?.streaming);
  const title = (yield* runtimes
    .catalogEntry(
      { workingDirectory: location.workingDirectory, sessionDirectory: location.sessionDirectory },
      sessionId,
    )
    .pipe(Effect.catch(() => Effect.succeed(undefined))))?.title;
  const owner =
    purpose === "delegated" && ownerId
      ? {
          sessionId: ownerId,
          resultDelivery,
          turnIds: yield* runtimes.executingTurnIds(runtime),
          workingDirectory: location.workingDirectory,
          ...(title ? { title } : null),
          ...(delegator.kind === "cake-chat" && isCakeChatSessionId(ownerId)
            ? {
                requester: {
                  sessionId: ownerId,
                  kind: "cake-chat" as const,
                  title: delegator.title ?? ownerId,
                },
              }
            : null),
        }
      : undefined;
  const change = yield* storage
    .setPurpose({
      sessionId,
      projectPath: location.projectPath,
      purpose,
      ...(owner ? { owner } : null),
    })
    .pipe(asError("setPurpose"));
  // A turn that settled before its new obligation landed has nothing left to report.
  const executing = change.adoptedTurnIds.length ? yield* runtimes.executingTurnIds(runtime) : [];
  const adoptedTurnIds: string[] = [];
  for (const turnId of change.adoptedTurnIds)
    if (executing.includes(turnId)) adoptedTurnIds.push(turnId);
    else yield* storage.completeNotice(turnId).pipe(asError("setPurpose"));
  const noticed = new Set<string>();
  const who =
    actor.kind === "user" ? "the user" : actor.title?.trim() || `session ${actor.sessionId}`;
  const label = title ? `“${title}” (${sessionId})` : sessionId;
  for (const turn of change.retired) {
    if (turn.senderSessionId === actor.sessionId || noticed.has(turn.senderSessionId)) continue;
    noticed.add(turn.senderSessionId);
    yield* storage
      .deferPassiveNotice({
        id: crypto.randomUUID(),
        recipientSessionId: turn.senderSessionId,
        text: `Session ${label} was moved to a User Session by ${who}. The result it owed you was dropped and will not be sent; its work continues.`,
        crossSession: {
          version: 1,
          messageId: crypto.randomUUID(),
          threadId: uuidV4.test(turn.threadId) ? turn.threadId : crypto.randomUUID(),
          sequence: 1,
          expectsResponse: false,
          resultDelivery: "ignore",
          generatedNotice: true,
          sender: {
            sessionId,
            title: (title ?? `Session ${sessionId}`).slice(0, 500),
            kind: "project-session",
            workingDirectory: location.workingDirectory,
          },
        },
      })
      .pipe(asError("setPurpose"));
  }
  if (change.changed) {
    const resolved =
      (yield* (yield* SessionArchiveStorage)
        .locate(sessionId, archiveLocation(location))
        .pipe(asError("setPurpose"))) === "resolved";
    yield* publishCatalogChange(sessionId, location, resolved).pipe(asError("setPurpose"));
  }
  return {
    ok: true as const,
    command: "sessions.set-purpose" as const,
    sessionId,
    purpose,
    previousPurpose: change.previousPurpose,
    changed: change.changed,
    running,
    retiredReports: change.retired.map((turn) => ({
      turnId: turn.turnId,
      ownerSessionId: turn.senderSessionId,
      ...(turn.resultDelivery ? { resultDelivery: turn.resultDelivery } : null),
      noticed: noticed.has(turn.senderSessionId),
    })),
    ...(owner && change.changed ? { owner: { sessionId: owner.sessionId, resultDelivery } } : null),
    adoptedTurnIds,
    canceledAutoMergeIds: change.canceledAutoMergeIds,
  };
});

export const start = Effect.fn("ProjectSessions.start")(function* (
  input: ProjectSessionStartInput,
  onAccepted?: () => void,
) {
  const locations = yield* projectSessionLocations.locations().pipe(asError("start"));
  const location = locations.find(
    (item) =>
      (input.projectPath === undefined || item.projectPath === input.projectPath) &&
      item.workingDirectory === input.workingDirectory,
  );
  if (!location)
    return yield* new ProjectSessionError({
      operation: "start",
      message: "The Working Directory is not associated with that Project",
    });
  // Validate every selected input before creating/naming a Pi session.
  const attachments = yield* prepareTaskInputs(input.sessionId, false, input.attachments).pipe(
    asError("start"),
  );
  const todoScope = input.todoId
    ? yield* existingTaskScope(location.projectPath, input.todoId).pipe(asError("start"))
    : undefined;
  const association = {
    kind: "session" as const,
    sessionId: input.sessionId,
    title: input.name ?? "Project Session",
  };
  let accepted = false;
  let attached = false;
  return yield* Effect.gen(function* () {
    if (todoScope && input.todoId)
      attached = yield* attachExisting(todoScope, input.todoId, association).pipe(asError("start"));
    const purpose = input.purpose ?? "user";
    yield* (yield* SessionFamilyStorage)
      .registerPurpose({
        sessionId: input.sessionId,
        projectPath: location.projectPath,
        purpose,
        createdPurpose: purpose,
      })
      .pipe(asError("start"));
    const handle = yield* acquireTarget(location, input.sessionId, true);
    if (input.labelIds?.length)
      yield* setProjectSessionLabels(location.projectPath, input.sessionId, input.labelIds).pipe(
        asError("start"),
      );
    if (input.configuration)
      yield* handle.applyConfiguration(input.configuration).pipe(asError("start"));
    if (input.name?.trim()) yield* handle.rename(input.name.trim()).pipe(asError("start"));
    const brief = parseCrossSessionMessage(input.text)?.text ?? input.text;
    const turnId = yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const acceptedTurn = yield* restore(
          handle.prompt(
            input.text,
            projectAttachments(attachments),
            input.renderUserMessageAsMarkdown,
            input.presentationMode,
            input.automaticTitle,
          ),
        ).pipe(asError("start"));
        accepted = true;
        onAccepted?.();
        yield* ensureSessionTodo(
          location.projectPath,
          input.sessionId,
          input.name ?? brief.trim().split("\n")[0]?.slice(0, 120) ?? "New Project Session",
          brief,
        );
        return TurnId.make(acceptedTurn);
      }),
    );
    // The runtime publishes its initial catalog change at Pi's first durable
    // message, even if this caller disconnects after the turn was accepted.
    return turnId;
  }).pipe(
    Effect.onExit((exit) =>
      !accepted && attached && Exit.isFailure(exit) && todoScope && input.todoId
        ? detachAdmission(todoScope, input.todoId, association).pipe(Effect.orDie)
        : Effect.void,
    ),
  );
});

const restoreIfResolved = Effect.fn("ProjectSessions.restoreIfResolved")(function* (
  target: ProjectSessionTarget,
) {
  const location = yield* findLocation(target);
  if (
    (yield* resolutionNamespace(target.sessionId, archiveLocation(location)).pipe(
      asError("restore"),
    )) !== "resolved"
  )
    return;
  const family = yield* Effect.flatMap(SessionFamilyStorage, (storage) =>
    storage.familyForMember(target.sessionId),
  ).pipe(asError("restore"));
  if (family)
    return yield* new ProjectSessionError({
      operation: "restore",
      message: `Session Family ${family.familyId} is resolved; restore it explicitly from parent ${family.parentSessionId} before messaging`,
    });
  // Use the same locked checkout-before-transcript transition as explicit Restore.
  yield* projectSessionLifecycle.restore(target).pipe(asError("restore"));
});

const isSessionResolvedAt = Effect.fn("ProjectSessions.isSessionResolvedAt")(function* (
  target: ProjectSessionTarget,
  location: ProjectSessionLocation,
  allowCreate = false,
) {
  const namespace = yield* resolutionNamespace(target.sessionId, archiveLocation(location)).pipe(
    asError("observe"),
  );
  if (namespace) return namespace === "resolved";
  const sessions = yield* CakeSessionRuntimes;
  const activeRuntime = yield* sessions.currentStatus({
    workingDirectory: location.workingDirectory,
    sessionDirectory: location.sessionDirectory,
    sessionId: target.sessionId,
  });
  // A new runtime can accept its first turn before its JSONL is discoverable.
  // It accounts for that missing-file case, but never overrides root resolution.
  if (activeRuntime || allowCreate) return false;
  return yield* new ProjectSessionError({
    operation: "observe",
    message: "That session is no longer available",
  });
});

const isSessionResolved = Effect.fn("ProjectSessions.isSessionResolved")(function* (
  target: ProjectSessionTarget,
  allowCreate = false,
) {
  return yield* isSessionResolvedAt(target, yield* findLocation(target), allowCreate);
});

export const observeConversation = Effect.fn("ProjectSessions.observeConversation")(function* (
  target: ProjectSessionTarget,
  allowCreate = false,
) {
  const catalogs = yield* SessionCatalogChanges;
  const family = yield* (yield* SessionFamilyStorage)
    .familyForMember(target.sessionId)
    .pipe(asError("observeConversation"));
  const authoritySessionId = family?.parentSessionId ?? target.sessionId;
  const resolvedStates = catalogs
    .initialThenChanges(
      Stream.fromEffect(isSessionResolved(target, allowCreate)).pipe(
        Stream.map((resolved) => ({ _tag: "InitialResolved" as const, resolved })),
      ),
    )
    .pipe(
      Stream.mapEffect((item) =>
        item._tag === "InitialResolved"
          ? Effect.succeed(item.resolved)
          : (item._tag === "ProjectSessionStatusChanged" &&
                item.sessionId === authoritySessionId) ||
              (item._tag === "ProjectSessionsTransitioned" &&
                item.sessions.some(({ sessionId }) => sessionId === authoritySessionId))
            ? isSessionResolved(target, allowCreate)
            : Effect.succeed(undefined),
      ),
      Stream.filter((resolved): resolved is boolean => resolved !== undefined),
    );
  return resolvedStates.pipe(
    Stream.changes,
    Stream.switchMap((resolved) =>
      resolved
        ? Stream.fromEffect(
            inspect(target).pipe(Effect.map((preview) => projectPreviewSnapshot(preview))),
          ).pipe(Stream.map((snapshot) => ({ _tag: "Preview" as const, revision: 0, snapshot })))
        : Stream.unwrap(
            Effect.gen(function* () {
              const location = yield* findLocation(target);
              // Observation owns the lease before a command-only first turn can settle.
              // Reopening a known new identity must still prefer Pi's persisted transcript.
              const persisted = allowCreate
                ? yield* (yield* CakeSessionRuntimes)
                    .catalogEntry(
                      {
                        workingDirectory: location.workingDirectory,
                        sessionDirectory: location.sessionDirectory,
                      },
                      target.sessionId,
                    )
                    .pipe(asError("observe"))
                : undefined;
              const live = Stream.unwrap(
                acquireTarget(location, target.sessionId, allowCreate && !persisted).pipe(
                  Effect.map(observeConversationUpdates),
                ),
              );
              const sessions = yield* CakeSessionRuntimes;
              // New identities have no history. Already-live sessions must retain
              // their current streaming/queue state rather than replaying disk history.
              if (
                (allowCreate && !persisted) ||
                (yield* sessions.hasCurrent({
                  workingDirectory: location.workingDirectory,
                  sessionDirectory: location.sessionDirectory,
                  sessionId: target.sessionId,
                }))
              )
                return live;
              const preview = yield* sessions
                .inspect({
                  workingDirectory: location.workingDirectory,
                  sessionDirectory: location.sessionDirectory,
                  sessionId: target.sessionId,
                })
                .pipe(asError("observe"));
              return Stream.succeed({
                _tag: "Preview" as const,
                revision: 0,
                snapshot: projectPreviewSnapshot(preview),
              }).pipe(Stream.concat(live));
            }),
          ),
    ),
    Stream.mapError((error) =>
      error instanceof ProjectSessionError
        ? error
        : new ProjectSessionError({
            operation: "observeConversation",
            message: error instanceof Error ? error.message : String(error),
          }),
    ),
    Stream.mapAccum(
      () => 0,
      (revision, update) => {
        const nextRevision = revision + 1;
        return [nextRevision, [{ ...update, revision: nextRevision }]] as const;
      },
    ),
  );
});

/** Backend equivalent of preparing an existing Project Session for an agent command.
 * Restores standalone resolution, but never implicitly restores a Session Family.
 * No renderer observation, selection, or device binding is acquired.
 */
export const prepareAgentCommand = Effect.fn("ProjectSessions.prepareAgentCommand")(function* (
  target: ProjectSessionTarget,
) {
  yield* restoreIfResolved(target);
  return yield* acquireExistingTarget(target);
});

/** Delivers an unattended message now, queueing it as a follow-up when the target is busy. */
export const sendAutomatically = Effect.fn("ProjectSessions.sendAutomatically")(function* (
  input: ProjectSessionPromptInput,
) {
  yield* restoreIfResolved(promptTarget(input));
  const turnId = TurnId.make(
    yield* deliverWhenAvailable(
      acquireExistingTarget(promptTarget(input)),
      input.text,
      projectAttachments(
        yield* prepareTaskInputs(input.sessionId, false, input.attachments).pipe(
          asError("sendAutomatically"),
        ),
      ),
      input.renderUserMessageAsMarkdown,
    ).pipe(asError("sendAutomatically")),
  );
  yield* publishTargetCatalogChange(promptTarget(input));
  return turnId;
});

const promptTarget = (input: ProjectSessionPromptInput): ProjectSessionTarget => {
  const target: ProjectSessionTarget = { sessionId: input.sessionId };
  if (input.workingDirectory !== undefined)
    Object.assign(target, { workingDirectory: input.workingDirectory });
  return target;
};

export const awaitTurnSettled = Effect.fn("ProjectSessions.awaitTurnSettled")(function* (
  target: ProjectSessionTarget,
  turnId: TurnId,
) {
  const location = yield* findLocation(target);
  const sessions = yield* CakeSessionRuntimes;
  const pending = () =>
    sessions
      .currentTurnIds({
        workingDirectory: location.workingDirectory,
        sessionDirectory: location.sessionDirectory,
        sessionId: target.sessionId,
      })
      .pipe(Effect.map((turnIds) => turnIds.includes(turnId)));
  yield* pending().pipe(
    Effect.repeat({ while: (running) => running, schedule: Schedule.spaced("250 millis") }),
  );
});

export const getChangelog = Effect.fn("ProjectSessions.getChangelog")(function* (
  target: ProjectSessionTarget,
) {
  return yield* useConversation(acquireExistingTarget(target), (handle) =>
    handle.executeCommand("changelog", ""),
  ).pipe(
    asError("getChangelog"),
    Effect.map((markdown) => markdown ?? ""),
  );
});

export const navigate = Effect.fn("ProjectSessions.navigate")(function* (
  target: ProjectSessionTarget,
  entryId: string,
  options: { readonly summarize: boolean; readonly customInstructions?: string },
) {
  yield* useConversation(acquireExistingTarget(target), (handle) =>
    handle.navigate(entryId, options),
  ).pipe(asError("navigate"));
});

export const callCakeOperation = Effect.fn("ProjectSessions.callCakeOperation")(function* (
  target: ProjectSessionTarget,
  command: string,
  input: JsonObject,
) {
  const handle = yield* acquireExistingTarget(target);
  return yield* handle.callCakeOperation(command, input).pipe(asError("callCakeOperation"));
});

export const dispatchExtensionCompanionAction = Effect.fn(
  "ProjectSessions.dispatchExtensionCompanionAction",
)(function* (input: ProjectSessionCompanionActionInput) {
  const { companionId, action, value, ...target } = input;
  yield* useConversation(acquireExistingTarget(target), (handle) =>
    handle.dispatchExtensionCompanionAction(companionId, action, value),
  ).pipe(asError("dispatchExtensionCompanionAction"));
});

export const rename = Effect.fn("ProjectSessions.rename")(function* (
  target: ProjectSessionTarget,
  name: string,
  onlyIfUnnamed = false,
) {
  const normalized = name.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
  if (!normalized)
    return yield* new ProjectSessionError({ operation: "rename", message: "Name is required" });
  const location = yield* findLocation(target);
  const namespace = yield* resolutionNamespace(target.sessionId, archiveLocation(location)).pipe(
    asError("rename"),
  );
  const handle = yield* acquireTarget(location, target.sessionId, false);
  yield* handle.rename(normalized, onlyIfUnnamed).pipe(asError("rename"));
  if (namespace === "resolved") {
    // Re-capture the derived archive title before publishing a refreshed page.
    // Resolution is idempotent; this never restores the session or its checkout.
    const archive = yield* SessionArchiveStorage;
    const context = { projectPath: location.projectPath, projectName: location.projectName };
    if (location.worktreeName) Object.assign(context, { worktreeName: location.worktreeName });
    yield* archive
      .resolveProject(target.sessionId, archiveLocation(location), context)
      .pipe(asError("rename"));
  }
  yield* publishCatalogChange(target.sessionId, location, namespace === "resolved").pipe(
    asError("rename"),
  );
});
