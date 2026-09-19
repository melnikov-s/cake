import { Effect, Schedule, Stream } from "effect";
import type { JsonObject } from "../../ipc/json-contract";
import { SESSION_TITLE_MAX_LENGTH } from "../../ipc/session-contract";
import { getState, setProjectSessionLabels, trustProject } from "../application/application";
import {
  TurnId,
  acquire as acquireConversation,
  deliverWhenAvailable,
  observe as observeConversation,
  projectAttachments,
  projectPreviewSnapshot,
  use as useConversation,
} from "../conversations/conversations";
import { PiSessions } from "../../services/pi/PiSessions";
import type { ProjectSessionLocation } from "./project-session-data";
import * as projectSessionLocations from "./projectSessionLocations";
import { resolutionNamespace } from "./projectSessionResolution";
import { acquireOptions } from "./projectSessionRuntime";
import {
  ProjectSessionError,
  type ProjectSessionCompanionActionInput,
  type ProjectSessionPromptInput,
  type ProjectSessionSnapshot,
  type ProjectSessionStartInput,
  type ProjectSessionTarget,
  type ProjectSessionUpdate,
} from "./project-session-data";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import { ManagedWorktrees } from "../../services/worktrees/ManagedWorktrees";
import {
  archiveLocation,
  asError,
  findLocation,
  inspect,
  publishCatalogChange,
  publishCatalogStatus,
  publishTargetCatalogChange,
} from "./projectSessionMetadata";

export const acquireTarget = Effect.fn("ProjectSessions.acquireTarget")(function* (
  location: ProjectSessionLocation,
  sessionId: string,
  newSession: boolean,
) {
  const sessions = yield* PiSessions;
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
  const handle = yield* acquireTarget(location, input.sessionId, true);
  if (input.labelIds?.length)
    yield* setProjectSessionLabels(location.projectPath, input.sessionId, input.labelIds).pipe(
      asError("start"),
    );
  if (input.configuration)
    yield* handle.applyConfiguration(input.configuration).pipe(asError("start"));
  if (input.name?.trim()) yield* handle.rename(input.name.trim()).pipe(asError("start"));
  const turnId = TurnId.make(
    yield* handle
      .prompt(
        input.text,
        projectAttachments(input.attachments),
        input.renderUserMessageAsMarkdown,
        input.presentationMode,
      )
      .pipe(asError("start")),
  );
  yield* publishCatalogChange(input.sessionId, location, false).pipe(asError("start"));
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
  const restored = yield* projectSessionLocations
    .restore(target.sessionId, location)
    .pipe(asError("restore"));
  yield* trustProject(restored.workingDirectory).pipe(asError("restore"));
  yield* publishCatalogStatus(target.sessionId, restored, false).pipe(asError("restore"));
  yield* publishCatalogChange(target.sessionId, restored, false).pipe(asError("restore"));
});

const isSessionResolved = Effect.fn("ProjectSessions.isSessionResolved")(function* (
  target: ProjectSessionTarget,
) {
  const location = yield* findLocation(target);
  const namespace = yield* resolutionNamespace(target.sessionId, archiveLocation(location)).pipe(
    asError("observe"),
  );
  if (namespace) return namespace === "resolved";
  const sessions = yield* PiSessions;
  const activeRuntime = yield* sessions.currentStatus({
    workingDirectory: location.workingDirectory,
    sessionDirectory: location.sessionDirectory,
    sessionId: target.sessionId,
  });
  // A new runtime can accept its first turn before its JSONL is discoverable.
  // It accounts for that missing-file case, but never overrides root resolution.
  if (activeRuntime) return false;
  return yield* new ProjectSessionError({
    operation: "observe",
    message: "That session is no longer available",
  });
});

export const observe = Effect.fn("ProjectSessions.observe")(function* (
  target: ProjectSessionTarget,
) {
  const catalogs = yield* SessionCatalogChanges;
  const family = yield* (yield* SessionFamilyStorage)
    .familyForMember(target.sessionId)
    .pipe(asError("observe"));
  const authoritySessionId = family?.parentSessionId ?? target.sessionId;
  const resolvedStates = catalogs
    .initialThenChanges(
      Stream.fromEffect(isSessionResolved(target)).pipe(
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
            ? isSessionResolved(target)
            : Effect.succeed(undefined),
      ),
      Stream.filter((resolved): resolved is boolean => resolved !== undefined),
    );
  const updates = resolvedStates.pipe(
    Stream.changes,
    Stream.mapAccum(
      () => true,
      (initial, resolved) => [false, [{ initial, resolved }]] as const,
    ),
    Stream.switchMap(({ initial, resolved }) =>
      resolved
        ? initial
          ? Stream.fromEffect(
              Effect.gen(function* () {
                const preview = yield* inspect(target);
                const snapshot: ProjectSessionSnapshot = {
                  identity: {
                    _tag: "ProjectSession",
                    sessionId: target.sessionId,
                    projectPath: preview.projectPath,
                    workingDirectory: preview.workingDirectory,
                  },
                  projectName: (yield* findLocation(target)).projectName,
                  resolved: true,
                  unread: false,
                  conversation: projectPreviewSnapshot({
                    ...preview,
                    workspacePath: preview.workingDirectory,
                  }),
                };
                if (preview.managedWorktree !== undefined)
                  Object.assign(snapshot, { managedWorktree: preview.managedWorktree });
                return { _tag: "Snapshot", revision: 0, snapshot } satisfies ProjectSessionUpdate;
              }),
            )
          : Stream.succeed({
              _tag: "LifecycleChanged",
              revision: 0,
              sessionId: target.sessionId,
              resolved: true,
            } satisfies ProjectSessionUpdate)
        : Stream.unwrap(
            Effect.gen(function* () {
              const location = yield* findLocation(target);
              const state = yield* getState();
              const identity = {
                _tag: "ProjectSession" as const,
                sessionId: target.sessionId,
                projectPath: location.projectPath,
                workingDirectory: location.workingDirectory,
              };
              const live = Stream.unwrap(
                acquireTarget(location, target.sessionId, false).pipe(
                  Effect.map((handle) =>
                    observeConversation(handle).pipe(
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
                      Stream.map((update): ProjectSessionUpdate => {
                        if (update._tag === "Event")
                          return {
                            _tag: "Event",
                            revision: update.revision,
                            sessionId: target.sessionId,
                            event: update.event,
                          };
                        const snapshot: ProjectSessionSnapshot = {
                          identity,
                          projectName: location.projectName,
                          resolved: false,
                          unread: state.unreadSessionIds.includes(target.sessionId),
                          conversation: update.snapshot,
                        };
                        if (location.managedWorktree !== undefined)
                          Object.assign(snapshot, { managedWorktree: location.managedWorktree });
                        return { _tag: "Snapshot", revision: update.revision, snapshot };
                      }),
                    ),
                  ),
                ),
              );
              const worktrees = yield* ManagedWorktrees;
              if (!(yield* worktrees.hasDeferredSetup(location.workingDirectory))) return live;

              // A continuation can be displayed from its durable transcript while checkout
              // setup runs. Runtime acquisition above remains gated until setup completes.
              const preview = yield* inspect(target);
              const snapshot: ProjectSessionSnapshot = {
                identity,
                projectName: location.projectName,
                resolved: false,
                unread: state.unreadSessionIds.includes(target.sessionId),
                conversation: projectPreviewSnapshot({
                  ...preview,
                  workspacePath: preview.workingDirectory,
                }),
              };
              if (location.managedWorktree !== undefined)
                Object.assign(snapshot, { managedWorktree: location.managedWorktree });
              return Stream.succeed({
                _tag: "Snapshot",
                revision: 0,
                snapshot,
              } satisfies ProjectSessionUpdate).pipe(Stream.concat(live));
            }),
          ),
    ),
    Stream.mapError((error) =>
      error instanceof ProjectSessionError
        ? error
        : new ProjectSessionError({
            operation: "observe",
            message: error instanceof Error ? error.message : String(error),
          }),
    ),
    Stream.mapAccum(
      () => 0,
      (revision, update) => {
        const nextRevision = revision + 1;
        const revised: ProjectSessionUpdate = { ...update, revision: nextRevision };
        return [nextRevision, [revised]] as const;
      },
    ),
  );
  return updates;
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
      projectAttachments(input.attachments),
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
  const sessions = yield* PiSessions;
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
) {
  const normalized = name.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
  if (!normalized)
    return yield* new ProjectSessionError({ operation: "rename", message: "Name is required" });
  const location = yield* findLocation(target);
  const namespace = yield* resolutionNamespace(target.sessionId, archiveLocation(location)).pipe(
    asError("rename"),
  );
  const handle = yield* acquireTarget(location, target.sessionId, false);
  yield* handle.rename(normalized).pipe(asError("rename"));
  yield* publishCatalogChange(target.sessionId, location, namespace === "resolved").pipe(
    asError("rename"),
  );
});
