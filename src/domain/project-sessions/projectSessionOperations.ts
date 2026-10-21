import { Effect, Schedule, Stream } from "effect";
import { ensureSession as ensureSessionTodo } from "../projects/projectTodos";
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

const acquireExistingTarget = Effect.fn("ProjectSessions.acquireExistingTarget")(function* (
  target: ProjectSessionTarget,
) {
  const location = yield* findLocation(target);
  return yield* acquireTarget(location, target.sessionId, false);
});

export const start = Effect.fn("ProjectSessions.start")(function* (
  input: ProjectSessionStartInput,
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
      const accepted = yield* restore(
        handle.prompt(
          input.text,
          projectAttachments(attachments),
          input.renderUserMessageAsMarkdown,
          input.presentationMode,
          input.automaticTitle,
        ),
      ).pipe(asError("start"));
      yield* ensureSessionTodo(
        location.projectPath,
        input.sessionId,
        input.name ?? brief.trim().split("\n")[0]?.slice(0, 120) ?? "New Project Session",
        brief,
      ).pipe(asError("start"));
      return TurnId.make(accepted);
    }),
  );
  // The runtime publishes its initial catalog change at Pi's first durable
  // message, even if this caller disconnects after the turn was accepted.
  return turnId;
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
          ).pipe(Stream.map((snapshot) => ({ _tag: "Snapshot" as const, revision: 0, snapshot })))
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
                  Effect.map((handle) =>
                    observeConversationUpdates(handle).pipe(
                      Stream.tap((update) =>
                        update._tag === "Event" && update.event._tag === "TurnSettled"
                          ? catalogs.publish({
                              _tag: "ProjectSessionChanged",
                              sessionId: target.sessionId,
                              projectPath: location.projectPath,
                              workingDirectory: location.workingDirectory,
                              resolved: false,
                            })
                          : Effect.void,
                      ),
                    ),
                  ),
                ),
              );
              const worktrees = yield* ManagedWorktrees;
              // A new identity has no disk preview; readiness must come from
              // the live runtime, after checkout setup has completed.
              if (
                (allowCreate && !persisted) ||
                !(yield* worktrees.hasDeferredSetup(location.workingDirectory))
              )
                return live;
              const preview = yield* inspect(target);
              return Stream.succeed({
                _tag: "Snapshot" as const,
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
  yield* publishCatalogChange(target.sessionId, location, namespace === "resolved").pipe(
    asError("rename"),
  );
});
