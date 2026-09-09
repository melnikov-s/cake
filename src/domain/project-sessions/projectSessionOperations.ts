import { Effect, Schedule, Stream } from "effect";
import * as subagents from "../subagents/subagents";
import {
  SESSION_TITLE_MAX_LENGTH,
  type ChatConfiguration,
  type PiSettingUpdate,
} from "../../ipc/session-contract";
import { getState, trustProject } from "../application/application";
import {
  TurnId,
  abort as abortConversation,
  acquire as acquireConversation,
  applyConfiguration as applyConversationConfiguration,
  authenticate as authenticateConversation,
  compact as compactConversation,
  deliver as deliverConversation,
  deliverWhenAvailable,
  editMessage as editConversationMessage,
  observe as observeConversation,
  projectAttachments,
  projectPreviewSnapshot,
  projectQueuedMessages,
  setFastMode as setConversationFastMode,
  setModel as setConversationModel,
  setPiSetting as setConversationPiSetting,
  setThinkingLevel as setConversationThinkingLevel,
  use as useConversation,
} from "../conversations/conversations";
import { PiSessions, type PiSessionHandle } from "../../services/pi/PiSessions";
import type { ProjectSessionLocation } from "./project-session-data";
import * as projectSessionLocations from "./projectSessionLocations";
import { acquireOptions } from "./projectSessionRuntime";
import {
  ProjectSessionError,
  type ProjectSessionPromptInput,
  type ProjectSessionSnapshot,
  type ProjectSessionStartInput,
  type ProjectSessionTarget,
  type ProjectSessionUpdate,
} from "./project-session-data";
import { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import { encodeCrossSessionMessage } from "../conversations/cross-session-coordination";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
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
  if (input.configuration)
    yield* handle.applyConfiguration(input.configuration).pipe(asError("start"));
  if (input.name?.trim()) yield* handle.rename(input.name.trim()).pipe(asError("start"));
  const turnId = TurnId.make(
    yield* handle
      .prompt(input.text, projectAttachments(input.attachments), input.renderUserMessageAsMarkdown)
      .pipe(asError("start")),
  );
  yield* publishCatalogChange(input.sessionId, location, false).pipe(asError("start"));
  return turnId;
});

const restoreIfResolved = Effect.fn("ProjectSessions.restoreIfResolved")(function* (
  target: ProjectSessionTarget,
) {
  const location = yield* findLocation(target);
  const archive = yield* SessionArchiveStorage;
  if (
    (yield* archive
      .locate(target.sessionId, archiveLocation(location))
      .pipe(asError("restore"))) !== "resolved"
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
  const sessions = yield* PiSessions;
  const activeRuntime = yield* sessions.currentStatus({
    workingDirectory: location.workingDirectory,
    sessionDirectory: location.sessionDirectory,
    sessionId: target.sessionId,
  });
  // A newly started Pi runtime can accept its first turn before its JSONL file
  // is discoverable. The live runtime is authoritative that this is an active
  // session; consulting storage first would permanently reject observation.
  if (activeRuntime) return false;
  const archive = yield* SessionArchiveStorage;
  const namespace = yield* archive
    .locate(target.sessionId, archiveLocation(location))
    .pipe(asError("observe"));
  if (!namespace)
    return yield* new ProjectSessionError({
      operation: "observe",
      message: "That session is no longer available",
    });
  return namespace === "resolved";
});

export const observe = Effect.fn("ProjectSessions.observe")(function* (
  target: ProjectSessionTarget,
) {
  const catalogs = yield* SessionCatalogChanges;
  const resolvedStates = catalogs
    .initialThenChanges(
      Stream.fromEffect(isSessionResolved(target)).pipe(
        Stream.map((resolved) => ({ _tag: "InitialResolved" as const, resolved })),
      ),
    )
    .pipe(
      Stream.map((item) =>
        item._tag === "InitialResolved"
          ? item.resolved
          : item._tag === "ProjectSessionStatusChanged" && item.sessionId === target.sessionId
            ? item.resolved
            : undefined,
      ),
      Stream.filter((resolved): resolved is boolean => resolved !== undefined),
    );
  const updates = resolvedStates.pipe(
    Stream.changes,
    Stream.switchMap((resolved) =>
      resolved
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
        : Stream.unwrap(
            Effect.gen(function* () {
              const location = yield* findLocation(target);
              const state = yield* getState();
              const handle = yield* acquireTarget(location, target.sessionId, false);
              const identity = {
                _tag: "ProjectSession" as const,
                sessionId: target.sessionId,
                projectPath: location.projectPath,
                workingDirectory: location.workingDirectory,
              };
              return observeConversation(handle).pipe(
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
              );
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

export const prompt = Effect.fn("ProjectSessions.prompt")(function* (
  input: ProjectSessionPromptInput,
) {
  yield* restoreIfResolved(promptTarget(input));
  const turnId = TurnId.make(
    yield* deliverConversation(
      acquireExistingTarget(promptTarget(input)),
      "prompt",
      input.crossSession ? encodeCrossSessionMessage(input.text, input.crossSession) : input.text,
      projectAttachments(input.attachments),
      input.renderUserMessageAsMarkdown,
    ).pipe(asError("prompt")),
  );
  yield* publishTargetCatalogChange(promptTarget(input));
  return turnId;
});

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

export const steer = Effect.fn("ProjectSessions.steer")(function* (
  input: ProjectSessionPromptInput,
) {
  const turnId = TurnId.make(
    yield* deliverConversation(
      acquireExistingTarget(promptTarget(input)),
      "steer",
      input.crossSession ? encodeCrossSessionMessage(input.text, input.crossSession) : input.text,
      projectAttachments(input.attachments),
      input.renderUserMessageAsMarkdown,
    ).pipe(asError("steer")),
  );
  yield* publishTargetCatalogChange(promptTarget(input));
  return turnId;
});

export const followUp = Effect.fn("ProjectSessions.followUp")(function* (
  input: ProjectSessionPromptInput,
) {
  const turnId = TurnId.make(
    yield* deliverConversation(
      acquireExistingTarget(promptTarget(input)),
      "follow-up",
      input.crossSession ? encodeCrossSessionMessage(input.text, input.crossSession) : input.text,
      projectAttachments(input.attachments),
      input.renderUserMessageAsMarkdown,
    ).pipe(asError("followUp")),
  );
  yield* publishTargetCatalogChange(promptTarget(input));
  return turnId;
});

export const listQueuedMessages = Effect.fn("ProjectSessions.listQueuedMessages")(function* (
  target: ProjectSessionTarget,
) {
  return yield* useConversation(acquireExistingTarget(target), (handle) =>
    handle.listQueuedMessages(),
  ).pipe(Effect.map(projectQueuedMessages), asError("listQueuedMessages"));
});

export const clearQueue = Effect.fn("ProjectSessions.clearQueue")(function* (
  target: ProjectSessionTarget,
) {
  return yield* useConversation(acquireExistingTarget(target), (handle) =>
    handle.clearQueue(),
  ).pipe(Effect.map(projectQueuedMessages), asError("clearQueue"));
});

export const cancelSteering = Effect.fn("ProjectSessions.cancelSteering")(function* (
  target: ProjectSessionTarget,
) {
  return yield* useConversation(acquireExistingTarget(target), (handle) =>
    handle.cancelSteering(),
  ).pipe(Effect.map(projectQueuedMessages), asError("cancelSteering"));
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
) {
  yield* useConversation(acquireExistingTarget(target), (handle) => handle.navigate(entryId)).pipe(
    asError("navigate"),
  );
});

export const setPiSetting = Effect.fn("ProjectSessions.setPiSetting")(function* (
  target: ProjectSessionTarget,
  update: PiSettingUpdate,
) {
  yield* setConversationPiSetting(acquireExistingTarget(target), update).pipe(
    asError("setPiSetting"),
  );
});

export const reload = Effect.fn("ProjectSessions.reload")(function* (target: ProjectSessionTarget) {
  yield* useConversation(acquireExistingTarget(target), (handle) => handle.reload()).pipe(
    asError("reload"),
  );
});

export const login = Effect.fn("ProjectSessions.login")(function* (
  target: ProjectSessionTarget,
  provider: string,
  authType: "api_key" | "oauth",
) {
  yield* authenticateConversation(acquireExistingTarget(target), {
    _tag: "Login",
    provider,
    authType,
  }).pipe(asError("login"));
});

export const logout = Effect.fn("ProjectSessions.logout")(function* (
  target: ProjectSessionTarget,
  provider: string,
) {
  yield* authenticateConversation(acquireExistingTarget(target), {
    _tag: "Logout",
    provider,
  }).pipe(asError("logout"));
});

export const compact = Effect.fn("ProjectSessions.compact")(function* (
  target: ProjectSessionTarget,
  instructions?: string,
) {
  yield* compactConversation(acquireExistingTarget(target), instructions).pipe(asError("compact"));
});

export const editMessage = Effect.fn("ProjectSessions.editMessage")(function* (
  input: ProjectSessionTarget & {
    readonly entryId: string;
    readonly text: ProjectSessionPromptInput["text"];
    readonly attachments: ProjectSessionPromptInput["attachments"];
    readonly renderUserMessageAsMarkdown: ProjectSessionPromptInput["renderUserMessageAsMarkdown"];
  },
) {
  yield* editConversationMessage(
    acquireExistingTarget(input),
    input.entryId,
    input.text,
    projectAttachments(input.attachments),
    input.renderUserMessageAsMarkdown,
  ).pipe(asError("editMessage"));
});

export const setUserMessageMarkdown = Effect.fn("ProjectSessions.setUserMessageMarkdown")(
  function* (target: ProjectSessionTarget, entryId: string, renderAsMarkdown: boolean) {
    yield* useConversation(acquireExistingTarget(target), (handle) =>
      handle.setUserMessageMarkdown(entryId, renderAsMarkdown),
    ).pipe(asError("setUserMessageMarkdown"));
  },
);

export const applyConfiguration = Effect.fn("ProjectSessions.applyConfiguration")(function* (
  target: ProjectSessionTarget,
  configuration: ChatConfiguration,
) {
  yield* applyConversationConfiguration(acquireExistingTarget(target), configuration).pipe(
    asError("applyConfiguration"),
  );
});

export const setModel = Effect.fn("ProjectSessions.setModel")(function* (
  target: ProjectSessionTarget,
  provider: string,
  modelId: string,
) {
  yield* setConversationModel(acquireExistingTarget(target), provider, modelId).pipe(
    asError("setModel"),
  );
});

export const setThinkingLevel = Effect.fn("ProjectSessions.setThinkingLevel")(function* (
  target: ProjectSessionTarget,
  level: Parameters<PiSessionHandle["setThinkingLevel"]>[0],
) {
  yield* setConversationThinkingLevel(acquireExistingTarget(target), level).pipe(
    asError("setThinkingLevel"),
  );
});

export const setFastMode = Effect.fn("ProjectSessions.setFastMode")(function* (
  target: ProjectSessionTarget,
  enabled: boolean,
) {
  yield* setConversationFastMode(acquireExistingTarget(target), enabled).pipe(
    asError("setFastMode"),
  );
});

export const abort = Effect.fn("ProjectSessions.abort")(function* (target: ProjectSessionTarget) {
  yield* subagents.abortParentChildren(target.sessionId).pipe(asError("abort"));
  yield* abortConversation(acquireExistingTarget(target)).pipe(asError("abort"));
});

export const rename = Effect.fn("ProjectSessions.rename")(function* (
  target: ProjectSessionTarget,
  name: string,
) {
  const normalized = name.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
  if (!normalized)
    return yield* new ProjectSessionError({ operation: "rename", message: "Name is required" });
  const location = yield* findLocation(target);
  const archive = yield* SessionArchiveStorage;
  const namespace = yield* archive
    .locate(target.sessionId, archiveLocation(location))
    .pipe(asError("rename"));
  const handle = yield* acquireTarget(location, target.sessionId, false);
  yield* handle.rename(normalized).pipe(asError("rename"));
  yield* publishCatalogChange(target.sessionId, location, namespace === "resolved").pipe(
    asError("rename"),
  );
});
