import { createHash } from "node:crypto";
import * as projectTodoUpdates from "../projects/projectTodoUpdates";
import { ensureAdmittedSession as ensureSessionTodo } from "../projects/projectTodos";
import { describeTurnStop, type TurnStop } from "../../contracts/conversations/turn-stop";
import { appendMessageReferences } from "../../contracts/conversations/message-reference-forwarding";
import type { ResultDelivery } from "../../contracts/conversations/result-delivery";
import {
  immediateDelivery,
  type SessionMessageDelivery,
  SessionMessageDeliveryOptions,
} from "../../contracts/conversations/session-message-delivery";
import { isReferenceNotification } from "../../contracts/conversations/reference-notification";
import { TaskInputStorage } from "../../services/storage/TaskInputStorage";
import * as workboardDeliveries from "./workboardDeliveries";
import * as updateBatches from "./updateBatches";
import { childSessionStartup } from "./childSessionStartup";
import * as completionInbox from "../conversations/completionInbox";
import {
  ensureBoard,
  boardIdFor,
  append as appendBoardAssignment,
} from "../artifacts/messageBoards";
import { ChildSessionAssignment } from "../../contracts/project-sessions/child-session-assignment";
import { MessageBoardStorage } from "../../services/storage/MessageBoardStorage";
import { RuntimeRecoveryStorage } from "../../services/storage/RuntimeRecoveryStorage";
import {
  CAKE_CHAT_SESSION_ID,
  isCakeChatSessionId,
} from "../../contracts/cake-chats/cake-chat-identity";
import { inheritTaskInputProtection, prepareCoordinatorNotice } from "../conversations/taskInputs";
import type {
  CakeChatLaunchStatus,
  SessionCompletionReport,
} from "../../contracts/project-sessions/session-reporting";
import { toJsonValue } from "../../utils/to-json-value";
import { crossSessionContextSnapshot } from "../../contracts/conversations/cross-session-message";
import { substantiveTurnResult } from "../../contracts/pi/turn-result-data";
import { acquireOptions as acquireProjectSessionOptions } from "../project-sessions/projectSessionRuntime";
import * as projectSessionLocations from "../project-sessions/projectSessionLocations";
import * as projectSessionMetadata from "../project-sessions/projectSessionMetadata";
import * as workflowLifecycle from "../workflows/workflow-lifecycle";
import { DateTime, Effect, Exit, Option, Schedule, Schema } from "effect";
import { CakeChatComposerPresence } from "../../services/session-catalogs/CakeChatComposerPresence";
import type { ChatConfiguration } from "../../contracts/conversations/session-contract";
import { PiModels } from "../../services/pi/PiModels";
import {
  CakeSessionRuntimes,
  type CakeSessionRuntimeAcquireOptions,
  type CakeSessionHandle,
} from "../../services/pi/CakeSessionRuntimes";
import type { ProjectSessionLocation } from "../../contracts/project-sessions/project-session-data";
import { resolutionNamespace } from "../project-sessions/projectSessionResolution";
import {
  SessionArchiveStorage,
  type SessionArchiveLocation,
} from "../../services/storage/SessionArchiveStorage";
import {
  SessionFamilyStorage,
  familyChildren,
  familyDepth,
  familyMember,
  type FamilyTurn,
  type SpawnedSession,
} from "../../services/storage/SessionFamilyStorage";
import * as chatTargets from "../cake-chats/cakeChatTargets";
import { SessionFamilyStorageError } from "../../contracts/storage/session-family-storage-errors";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import {
  encodeCrossSessionMessage,
  formatCrossSessionNoticeText,
  formatCrossSessionReportText,
  parseCrossSessionMessage,
  type CrossSessionContextSnapshot,
} from "../../contracts/conversations/cross-session-message";

const failure = (message: string) =>
  new SessionFamilyStorageError({ operation: "familyLifecycle", message });

/** Runs inside the same family lock as lifecycle and creation admission. */
const assertAdmission = Effect.fn("SessionFamilies.assertAdmission")(function* (
  sessionId: string,
  location: SessionArchiveLocation,
) {
  const storage = yield* SessionFamilyStorage;
  const family = yield* storage.familyForMember(sessionId);
  if (!family) return;
  if ((yield* resolutionNamespace(sessionId, location)) === "resolved")
    return yield* failure(
      `Restore the family explicitly from parent ${family.parentSessionId} before starting work`,
    );
});

export const admitTurn = Effect.fn("SessionFamilies.admitTurn")(function* <E, R>(
  sessionId: string,
  location: SessionArchiveLocation,
  input: { readonly turnId: string; readonly text: string },
  accept: Effect.Effect<void, E, R>,
) {
  const storage = yield* SessionFamilyStorage;
  yield* storage.withMemberLock(
    sessionId,
    Effect.gen(function* () {
      yield* assertAdmission(sessionId, location);

      const request = parseCrossSessionMessage(input.text);
      const senderSessionId = request?.metadata.sender.sessionId;

      // A reply obligation belongs to this one message, never to the session
      // relationship: user-started turns and messages that asked for no
      // response are not journaled and therefore never produce notices.
      if (
        request &&
        request.metadata.expectsResponse &&
        !request.metadata.generatedNotice &&
        senderSessionId !== undefined
      )
        yield* storage.recordTurn({
          sessionId,
          senderSessionId,
          turnId: input.turnId,
          requestMessageId: request.metadata.messageId,
          threadId: request.metadata.threadId,
          reported: false,
          resultDelivery: request.metadata.resultDelivery ?? "notification",
        });
      yield* accept.pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? storage.completeNotice(input.turnId) : Effect.void,
        ),
      );
    }),
  );
});

export const createChild = Effect.fn("SessionFamilies.createChild")(
  function* <E, R, E2 = never, R2 = never, E3 = never, R3 = never, E4 = never, R4 = never>(
    parentSessionId: string,
    location: ProjectSessionLocation,
    input: {
      requestId: string;
      title: string;
      assignment: ChildSessionAssignment;
      model: ChatConfiguration;
      resultDelivery?: ResultDelivery;
      worktreeName?: string;
      senderContext: CrossSessionContextSnapshot;
    },
    runtimeOptions: (
      sessionId: string,
      childLocation: ProjectSessionLocation,
      newSession: boolean,
    ) => Effect.Effect<CakeSessionRuntimeAcquireOptions, E, R>,
    createIsolatedLocation?: (
      worktreeName: string,
    ) => Effect.Effect<ProjectSessionLocation, E2, R2>,
    resolveLocation?: (workingDirectory: string) => Effect.Effect<ProjectSessionLocation, E3, R3>,
    discardIsolatedLocation?: (workingDirectory: string) => Effect.Effect<void, E4, R4>,
  ) {
    const storage = yield* SessionFamilyStorage;
    const sessions = yield* CakeSessionRuntimes;
    const models = yield* PiModels;
    const archive = yield* SessionArchiveStorage;
    const catalogs = yield* SessionCatalogChanges;
    // Validate even backend-direct callers before creating a reservation or runtime.
    const assignment = yield* Schema.decodeUnknownEffect(ChildSessionAssignment)(input.assignment);
    const configuration = yield* models.resolve(input.model);
    const archiveLocation = (workingDirectory: string) => ({
      cwd: workingDirectory,
      activeRoot: location.sessionDirectory,
      resolvedRoot: location.resolvedSessionDirectory,
    });
    const publish = (sessionId: string, workingDirectory: string) =>
      catalogs.publish({
        _tag: "ProjectSessionChanged",
        sessionId,
        projectPath: location.projectPath,
        workingDirectory,
        resolved: false,
      });
    const childLocationFor = Effect.fn("SessionFamilies.childLocationFor")(function* (
      workingDirectory: string,
    ) {
      if (workingDirectory === location.workingDirectory) return location;
      if (resolveLocation) return yield* resolveLocation(workingDirectory);
      return yield* new SessionFamilyStorageError({
        operation: "createChild",
        message: `Child Working Directory unavailable: ${workingDirectory}`,
      });
    });
    const requestId = createHash("sha256")
      .update(JSON.stringify([parentSessionId, input.requestId]))
      .digest("hex");
    const prepared = yield* storage.withMemberLock(
      parentSessionId,
      Effect.gen(function* () {
        yield* assertAdmission(parentSessionId, archiveLocation(location.workingDirectory));
        const existing = yield* storage.familyForMember(parentSessionId);
        const retriedChild = existing?.children.find((item) => item.requestId === requestId);
        let childLocation = retriedChild
          ? yield* childLocationFor(retriedChild.workingDirectory)
          : location;
        if (!retriedChild && input.worktreeName) {
          if (!createIsolatedLocation)
            return yield* new SessionFamilyStorageError({
              operation: "createChild",
              message: "Isolated child worktree creation is unavailable",
            });
          childLocation = yield* createIsolatedLocation(input.worktreeName);
        }
        const childSessionId = crypto.randomUUID();
        const reservation = {
          familyId: existing?.familyId ?? crypto.randomUUID(),
          parentSessionId,
          parentWorkingDirectory: location.workingDirectory,
          childSessionId,
          assignmentTopic: `child-${childSessionId}`,
          childWorkingDirectory: childLocation.workingDirectory,
          resultDelivery: input.resultDelivery ?? "notification",
          requestId,
          projectPath: location.projectPath,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        };
        if (location.managedWorktree)
          Object.assign(reservation, {
            parentManagedWorktreePath: location.managedWorktree.worktreePath,
          });
        if (childLocation.managedWorktree)
          Object.assign(reservation, {
            childManagedWorktreePath: childLocation.managedWorktree.worktreePath,
          });
        const family = yield* storage
          .addChild(reservation)
          .pipe(
            Effect.tapError(() =>
              !retriedChild &&
              childLocation.workingDirectory !== location.workingDirectory &&
              discardIsolatedLocation
                ? discardIsolatedLocation(childLocation.workingDirectory)
                : Effect.void,
            ),
          );
        const originatingSession = yield* sessions
          .catalogEntry(
            {
              workingDirectory: family.workingDirectory,
              sessionDirectory: location.sessionDirectory,
            },
            family.parentSessionId,
          )
          .pipe(Effect.catchTag("PiSessionError", () => Effect.succeed(undefined)));
        const child = family.children.find((item) => item.requestId === requestId);
        if (!child)
          return yield* new SessionFamilyStorageError({
            operation: "createChild",
            message: "Child reservation missing",
          });
        yield* publish(parentSessionId, location.workingDirectory);
        const assigned = yield* Effect.result(
          Effect.gen(function* () {
            if (!child.assignmentTopic)
              return yield* failure(
                "This is a bootstrap-first child; create a new assignment-first child instead",
              );
            yield* ensureBoard(family, originatingSession?.title);
            const boardId = boardIdFor(family.familyId);
            const previous = (yield* (yield* MessageBoardStorage).entries(boardId)).find(
              (entry) =>
                entry.topic === child.assignmentTopic && entry.authorSessionId === parentSessionId,
            );
            if (previous) {
              if (
                previous.description !== assignment.description ||
                previous.body !== assignment.body
              )
                return yield* failure(
                  "Retry must use the original assignment; publish later changes on the Workboard",
                );
              return { boardId, sequence: previous.sequence };
            }
            const posted = yield* appendBoardAssignment(parentSessionId, {
              ...assignment,
              audience: [child.sessionId],
              topic: child.assignmentTopic,
            });
            return { boardId, sequence: posted.entry.sequence };
          }),
        );
        if (assigned._tag === "Failure")
          return {
            family,
            child,
            childLocation,
            handle: undefined,
            error: String(assigned.failure),
            stage: "assignment" as const,
          };
        // A runtime or transcript alone is not evidence of initial-turn admission.
        // Any durable journal (including stopped/canceled work) forbids relaunch.
        const record = yield* (yield* RuntimeRecoveryStorage).get(child.sessionId);
        if (record) {
          yield* ensureSessionTodo(
            location.projectPath,
            child.sessionId,
            input.title,
            assignment.description,
          );
          return {
            family,
            child,
            childLocation,
            handle: undefined,
            assignmentReceipt: assigned.success,
            admissionState: record.state,
          };
        }
        const archived = yield* archive.locate(
          child.sessionId,
          archiveLocation(childLocation.workingDirectory),
        );
        const acquired = yield* Effect.result(
          Effect.gen(function* () {
            const handle = yield* sessions.acquire(
              yield* runtimeOptions(child.sessionId, childLocation, !archived),
            );
            yield* handle.applyConfiguration(configuration);
            yield* handle.rename(input.title);
            return handle;
          }),
        );
        if (acquired._tag === "Failure") {
          yield* publish(parentSessionId, location.workingDirectory);
          return {
            family,
            child,
            childLocation,
            handle: undefined,
            error: String(acquired.failure),
            stage: "runtime" as const,
            assignmentReceipt: assigned.success,
          };
        }
        return {
          family,
          child,
          childLocation,
          handle: acquired.success,
          assignmentReceipt: assigned.success,
        };
      }),
    );
    const identity = {
      familyId: prepared.family.familyId,
      parentSessionId,
      childSessionId: prepared.child.sessionId,
      workingDirectory: prepared.childLocation.workingDirectory,
      familyChildOrder: familyChildren(prepared.family, parentSessionId).findIndex(
        (child) => child.sessionId === prepared.child.sessionId,
      ),
      familyDepth: familyDepth(prepared.family, prepared.child.sessionId) ?? 0,
      resultDelivery: prepared.child.resultDelivery ?? "notification",
      requestId: input.requestId,
      assignment: prepared.assignmentReceipt,
    };
    if (!prepared.handle)
      return {
        ...identity,
        launch: prepared.error
          ? { status: "failed", stage: prepared.stage, message: prepared.error, retryable: true }
          : { status: "already-admitted", state: prepared.admissionState },
      };
    const assignmentTopic = prepared.child.assignmentTopic;
    if (!assignmentTopic)
      return yield* failure("Cannot render child startup without its persisted assignment topic");
    const initialMessage = encodeCrossSessionMessage(
      childSessionStartup({
        familyId: identity.familyId,
        childSessionId: identity.childSessionId,
        parentSessionId,
        rootSessionId: prepared.family.parentSessionId,
        workingDirectory: identity.workingDirectory,
        resultDelivery: identity.resultDelivery,
        assignmentReceipt: prepared.assignmentReceipt,
        assignmentTopic,
        assignment,
      }),
      {
        version: 1,
        messageId: prepared.child.sessionId,
        threadId: prepared.family.familyId,
        sequence: 1,
        expectsResponse: identity.resultDelivery !== "ignore",
        resultDelivery: identity.resultDelivery,
        context: input.senderContext,
        sender: {
          sessionId: parentSessionId,
          title: `Parent session ${parentSessionId}`,
          kind: "project-session",
          projectName: location.projectName,
          workingDirectory: location.workingDirectory,
        },
      },
    );
    const handle = prepared.handle;
    const launched = yield* Effect.result(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const turnId = yield* restore(handle.prompt(initialMessage, [], false));
          yield* ensureSessionTodo(
            location.projectPath,
            prepared.child.sessionId,
            input.title,
            input.assignment.description,
          );
          return turnId;
        }),
      ),
    );
    if (launched._tag === "Failure") {
      return {
        ...identity,
        launch: {
          status: "failed",
          stage: "admission",
          message: String(launched.failure),
          retryable: true,
        },
      };
    }
    yield* publish(prepared.child.sessionId, prepared.childLocation.workingDirectory);
    return { ...identity, launch: { status: "accepted", turnId: launched.success } };
  },
  (effect, parentSessionId, _location, input) =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      return yield* storage.withCreationLock(
        JSON.stringify([parentSessionId, input.requestId]),
        effect,
      );
    }),
);

export const initialize = Effect.fn("SessionFamilies.initialize")(function* <E, R>(
  activeRoot: string,
  resolvedRoot: string,
  isRecoverable: (sessionId: string, turnId?: string) => Effect.Effect<boolean, E, R>,
) {
  const storage = yield* SessionFamilyStorage;
  const archive = yield* SessionArchiveStorage;
  for (const family of yield* storage.list()) {
    for (const child of family.children) {
      // Durable admission can precede Pi's first transcript write. Recovery, not
      // transcript presence, decides whether this reservation is still live.
      if (yield* isRecoverable(child.sessionId)) continue;
      if (
        yield* archive.locate(child.sessionId, {
          cwd: child.workingDirectory,
          activeRoot,
          resolvedRoot,
        })
      )
        continue;
      // An existing obligation (including a settled report awaiting delivery)
      // must retain its member routing and must not gain a second failure notice.
      if ((yield* storage.state()).turns.some((turn) => turn.sessionId === child.sessionId))
        continue;
      // Assignment-first reservations are explicit retryable handoffs, not orphaned
      // bootstrap sessions. Never erase their request identity or restart them here.
      if (child.assignmentTopic) continue;
      if (child.resultDelivery === "ignore") {
        yield* storage.removeUnmaterializedChild(child.sessionId);
        continue;
      }

      // No accepted input or report remains for this unmaterialized reservation.
      yield* storage.recordTurn({
        sessionId: child.sessionId,
        senderSessionId: child.parentSessionId,
        turnId: child.sessionId,
        requestMessageId: child.sessionId,
        threadId: family.familyId,
        reported: false,
        resultDelivery: child.resultDelivery ?? "notification",
        outcome: "failed",
      });
      yield* storage.removeUnmaterializedChild(child.sessionId);
    }
  }
  const state = yield* storage.state();
  for (const spawn of state.spawnedSessions) {
    if (
      spawn.resultDelivery === "ignore" ||
      spawn.handoffSettled ||
      state.turns.some((turn) => turn.sessionId === spawn.sessionId)
    )
      continue;
    if (yield* isRecoverable(spawn.sessionId)) continue;
    // Covers a crash after recording the requester but before Pi accepted its initial input.
    // Spawns created without an initial obligation are registered already settled.
    yield* storage.recordTurn({
      sessionId: spawn.sessionId,
      senderSessionId: spawn.requester.sessionId,
      turnId: spawn.sessionId,
      requestMessageId: spawn.sessionId,
      threadId: spawn.sessionId,
      reported: false,
      outcome: "aborted",
      resultDelivery: spawn.resultDelivery ?? "notification",
    });
  }
  for (const turn of (yield* storage.state()).turns) {
    // Accepted primary inputs may resume after restart. Only genuinely orphaned
    // obligations become interrupted notices; settled reports are never rewritten.
    if (!turn.outcome && !(yield* isRecoverable(turn.sessionId, turn.turnId)))
      yield* storage.settleTurn(turn.turnId, "aborted");
  }
});

/** The report is a new admission, not the worker's input. Reusing that input ID
 * lets the recipient settle the worker's still-pending obligation a second time. */
const reportMessageId = (turnId: string) => {
  const bytes = createHash("sha256").update(`cake:automatic-report:${turnId}`).digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const deliver = Effect.fn("SessionFamilies.deliverNotice")(function* (turn: FamilyTurn) {
  const storage = yield* SessionFamilyStorage;
  const family =
    (yield* storage.familyForMember(turn.sessionId)) ??
    (yield* storage.familyForMember(turn.senderSessionId));
  if (
    !turn.outcome ||
    turn.reported ||
    (yield* workflowLifecycle.holdsCompletion(turn.sessionId, turn.turnId))
  )
    return;
  if (stoppedByRequester(turn)) {
    // The requester stopped this work itself; telling it so would be noise. The obligation
    // is settled, and Cake Chat's launch status still records the neutral stop.
    const spawn = (yield* storage.state()).spawnedSessions.find(
      (item) => item.sessionId === turn.sessionId,
    );
    if (isCakeChatSessionId(turn.senderSessionId) && spawn)
      yield* storage.recordLaunchReport(spawn.sessionId, {
        status: "stopped",
        summary: stoppedSummary(turn.stop),
        reportedAt: DateTime.formatIso(yield* DateTime.now),
      });
    yield* storage.completeNotice(turn.turnId);
    if (spawn)
      yield* (yield* SessionCatalogChanges).publish({
        _tag: "ProjectSessionChanged",
        sessionId: spawn.sessionId,
        projectPath: spawn.projectPath,
        workingDirectory: spawn.workingDirectory,
        resolved: false,
      });
    return;
  }
  if (isCakeChatSessionId(turn.senderSessionId))
    return yield* deliverRequesterNotice(
      turn,
      (yield* storage.state()).spawnedSessions.find((item) => item.sessionId === turn.sessionId),
    );
  if (!family) return yield* deliverRequesterNotice(turn, undefined);
  const senderMember = familyMember(family, turn.senderSessionId);
  const childMember = familyMember(family, turn.sessionId);
  if (!senderMember || !childMember) return yield* deliverRequesterNotice(turn, undefined);
  const locations = yield* projectSessionLocations.locations({ includeInactive: true });
  const senderLocation = locations.find(
    (item) =>
      item.projectPath === family.projectPath &&
      item.workingDirectory === senderMember.workingDirectory,
  );
  const childLocation = locations.find(
    (item) =>
      item.projectPath === family.projectPath &&
      item.workingDirectory === childMember.workingDirectory,
  );
  if (!senderLocation || !childLocation)
    return yield* new SessionFamilyStorageError({
      operation: "deliverNotice",
      message: `Session Family Working Directory unavailable: ${
        senderLocation ? childMember.workingDirectory : senderMember.workingDirectory
      }`,
    });
  const archive = yield* SessionArchiveStorage;
  if (
    (yield* resolutionNamespace(turn.senderSessionId, {
      cwd: senderMember.workingDirectory,
      activeRoot: senderLocation.sessionDirectory,
      resolvedRoot: senderLocation.resolvedSessionDirectory,
    })) !== "active"
  )
    return;
  const sessions = yield* CakeSessionRuntimes;
  yield* storage.withMemberLock(
    turn.senderSessionId,
    Effect.gen(function* () {
      const status = yield* sessions.currentStatus({
        sessionId: turn.sessionId,
        workingDirectory: childMember.workingDirectory,
        sessionDirectory: childLocation.sessionDirectory,
      });
      if (
        !status?.streaming &&
        !status?.pending &&
        !(yield* archive.locate(turn.sessionId, {
          cwd: childMember.workingDirectory,
          activeRoot: childLocation.sessionDirectory,
          resolvedRoot: childLocation.resolvedSessionDirectory,
        }))
      )
        yield* storage.removeUnmaterializedChild(turn.sessionId);
    }),
  );
  const sender = yield* sessions.acquire(
    yield* acquireProjectSessionOptions({
      location: senderLocation,
      sessionId: turn.senderSessionId,
      newSession: false,
    }),
  );
  const reason =
    turn.outcome === "aborted" ? "canceled" : turn.outcome === "failed" ? "failed" : "stopped";
  const stoppedBy =
    turn.outcome === "aborted" && turn.stop ? describeTurnStop(turn.stop, "agent") : undefined;
  const report =
    turn.outcome === "complete" || (turn.outcome === "failed" && turn.report?.outcome === "failed")
      ? turn.report
      : undefined;
  const childSummary = yield* sessions
    .catalogEntry(
      {
        workingDirectory: childMember.workingDirectory,
        sessionDirectory: childLocation.sessionDirectory,
      },
      turn.sessionId,
    )
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  yield* queueTurnCompletion(
    turn,
    undefined,
    childSummary?.title,
    childMember.workingDirectory !== senderMember.workingDirectory,
  );

  const missingResponse = turn.outcome === "complete";
  const text = encodeCrossSessionMessage(
    report
      ? formatCrossSessionReportText(
          turn.sessionId,
          report.outcome,
          appendMessageReferences(
            report.text,
            report.resultMessageRef ? [report.resultMessageRef] : [],
          ),
        )
      : formatCrossSessionNoticeText(
          turn.sessionId,
          missingResponse
            ? { kind: "no-reply", requestMessageId: turn.requestMessageId }
            : {
                kind: "interrupted",
                reason,
                requestMessageId: turn.requestMessageId,
                ...(stoppedBy ? { stoppedBy } : null),
              },
        ),
    {
      version: 1,
      messageId: reportMessageId(turn.turnId),
      threadId: turn.threadId,
      sequence: 1,
      expectsResponse: false,
      generatedNotice: !report,
      ...(report ? { replyToMessageId: turn.requestMessageId } : null),
      sender: {
        sessionId: turn.sessionId,
        title: childSummary?.title ?? `Session ${turn.sessionId}`,
        kind: "project-session",
        projectName: childLocation.projectName,
        workingDirectory: childLocation.workingDirectory,
      },
    },
  );
  yield* deliverOutcome(turn, sender, text);
});

/** One receipt/retry policy for family parents and permanent chats. */
const deliverOutcome = Effect.fn("SessionFamilies.deliverOutcome")(function* (
  turn: FamilyTurn,
  sender: CakeSessionHandle,
  text: string,
) {
  const storage = yield* SessionFamilyStorage;
  return yield* storage.withNoticeDelivery(
    Effect.gen(function* () {
      // Re-read the journal: a correlated explicit reply or queue withdrawal can have satisfied it since this pass began.
      const current = (yield* storage.state()).turns.find(
        (item) => item.turnId === turn.turnId && !item.reported,
      );
      if (!current) return;
      turn = current;
      const inputReceipt = sender.inputReceipt
        ? yield* sender.inputReceipt(reportMessageId(turn.turnId))
        : undefined;
      if (inputReceipt === "canceled" || inputReceipt === "consumed") {
        // Persisted admission receipts outlive queue edits and transcript compaction.
        yield* storage.completeNotice(turn.turnId);
        return;
      }
      if (inputReceipt === "pending") return;
      if (isCakeChatSessionId(turn.senderSessionId))
        text = yield* prepareCoordinatorNotice(turn.senderSessionId, text).pipe(
          Effect.mapError((error) => failure(error.message)),
        );
      else
        yield* inheritTaskInputProtection(turn.sessionId, turn.senderSessionId).pipe(
          Effect.mapError((error) => failure(error.message)),
        );
      if (turn.report?.outcome !== "blocked" && turn.resultDelivery === "notification") {
        yield* storage.completeNotice(turn.turnId);
        return;
      }
      const snapshot = yield* sender.snapshot();
      const receipt = snapshot.parts.find(
        (part) =>
          (part.kind === "context" || (part.kind === "text" && !part.deliveryState)) &&
          "crossSession" in part &&
          part.crossSession &&
          (part.crossSession.messageId === reportMessageId(turn.turnId) ||
            (turn.outcome === "complete" &&
              turn.replyMessageIds?.includes(part.crossSession.messageId))),
      );
      if (receipt && "crossSession" in receipt && receipt.crossSession) {
        if (turn.replyMessageIds?.includes(receipt.crossSession.messageId))
          yield* storage.confirmResponse(receipt.crossSession.messageId);
        else yield* storage.completeNotice(turn.turnId);
        return;
      }
      const queue = yield* sender.listQueuedMessages();
      const queuedMessages = [...queue.steering, ...queue.followUp];
      if (
        queuedMessages.some((content) => {
          const reply = parseCrossSessionMessage(content);
          return (
            turn.outcome === "complete" &&
            reply &&
            turn.replyMessageIds?.includes(reply.metadata.messageId)
          );
        })
      )
        return;
      if (queuedMessages.includes(text)) return;
      if (turn.deliveryTurnId && (yield* sender.currentTurnIds()).includes(turn.deliveryTurnId))
        return;
      // Match ordinary user delivery: start an idle sender, or queue behind its
      // active turn without steering or interrupting it.
      const deliveryTurnId = snapshot.streaming
        ? yield* sender.followUp(text, [], false)
        : yield* sender.prompt(text, [], false);
      yield* storage.markNoticeAttempt(turn.turnId, deliveryTurnId);
    }),
  );
});

/** Routes the coordinator as a primary Cake destination, not a Project catalog entry. */
export const routeCoordinatorMessage = Effect.fn("SessionFamilies.routeCoordinatorMessage")(
  function* (
    sessionId: string,
    command: "sessions.send" | "sessions.reply",
    input: {
      sessionId?: string;
      text: string;
      delivery?: SessionMessageDelivery;
      threadId?: string;
      replyToMessageId?: string;
      resultDelivery?: ResultDelivery;
      inputRefs?: readonly string[];
      messageRefs?: readonly string[];
      outcome?: SessionCompletionReport["outcome"];
      resultKind?: "ready" | "investigation";
    },
    location: ProjectSessionLocation,
    senderContext?: CrossSessionContextSnapshot,
  ) {
    yield* Schema.decodeUnknownEffect(SessionMessageDeliveryOptions)(input).pipe(
      Effect.mapError((error) => failure(error.message)),
    );
    const storage = yield* SessionFamilyStorage;
    const state = yield* storage.state();
    const expectsResponse =
      input.delivery !== "fyi" && (input.resultDelivery ?? "notification") !== "ignore";
    const spawn = state.spawnedSessions.find((item) => item.sessionId === sessionId);
    // A session Cake Chat did not launch still answers Cake Chat's own requests to it.
    const owedCoordinator =
      !spawn && !(yield* storage.familyForMember(sessionId))
        ? state.turns.find(
            (turn) =>
              turn.sessionId === sessionId &&
              isCakeChatSessionId(turn.senderSessionId) &&
              !turn.reported &&
              (!input.threadId || input.threadId === turn.threadId) &&
              (!input.replyToMessageId || input.replyToMessageId === turn.requestMessageId),
          )
        : undefined;
    const requesterId = spawn?.requester.sessionId ?? owedCoordinator?.senderSessionId;
    // Omitted send targets mean global Cake Chat; replies follow their originating chat.
    const targetId =
      command === "sessions.reply" ? requesterId : (input.sessionId ?? CAKE_CHAT_SESSION_ID);
    if (!targetId || !isCakeChatSessionId(targetId)) return undefined;
    const sessions = yield* CakeSessionRuntimes;
    const executingIds = yield* sessions.executingTurnIds({
      sessionId,
      workingDirectory: location.workingDirectory,
      sessionDirectory: location.sessionDirectory,
    });
    const pending =
      command === "sessions.reply" ||
      input.replyToMessageId ||
      (requesterId !== undefined && input.resultDelivery !== "reply")
        ? yield* storage.pendingResponseRequest(
            sessionId,
            executingIds,
            input.threadId,
            input.replyToMessageId,
          )
        : undefined;
    if (
      !pending &&
      command === "sessions.reply" &&
      spawn?.reportDelivered &&
      input.resultDelivery !== "reply" &&
      (input.threadId === undefined || input.threadId === spawn.sessionId) &&
      (input.replyToMessageId === undefined || input.replyToMessageId === spawn.sessionId)
    )
      return toJsonValue({ ok: true, command, status: "already-reported", expectsResponse: false });
    if (pending && pending.outcome === undefined && input.resultDelivery !== "reply") {
      if (!substantiveTurnResult({ stopReason: "stop", text: input.text }))
        return yield* failure(
          "A result report must contain substantive findings, changes, or a blocker—not an acknowledgment",
        );
      yield* storage.recordReport(pending.turnId, {
        outcome: input.outcome ?? "result",
        ...(input.resultKind ? { resultKind: input.resultKind } : null),
        text: appendMessageReferences(input.text, input.messageRefs ?? []),
      });
      yield* projectTodoUpdates.offer({
        sessionId,
        projectPath: location.projectPath,
        text: input.text,
      });
      // Explicit input forwarding is delivered below rather than silently discarded.
      if (!input.inputRefs?.length)
        return toJsonValue({
          ok: true,
          command,
          status: "report-recorded",
          expectsResponse: false,
        });
    }
    const destination = yield* chatTargets.acquireAvailable(targetId);
    const snapshot = yield* destination.snapshot();
    const messageId = crypto.randomUUID();
    const replyToMessageId = pending?.requestMessageId ?? input.replyToMessageId;
    const metadata = {
      version: 1 as const,
      messageId,
      threadId: pending?.threadId ?? input.threadId ?? spawn?.sessionId ?? crypto.randomUUID(),
      sequence: 1,
      expectsResponse,
      resultDelivery:
        input.delivery === "fyi" ? ("ignore" as const) : (input.resultDelivery ?? "notification"),
      ...(replyToMessageId ? { replyToMessageId } : null),
      ...(senderContext ? { context: senderContext } : null),
      sender: {
        sessionId,
        title: `Session ${sessionId}`,
        kind: "project-session" as const,
        projectName: location.projectName,
        workingDirectory: location.workingDirectory,
      },
    };
    const encoded = yield* prepareCoordinatorNotice(
      targetId,
      encodeCrossSessionMessage(
        appendMessageReferences(input.text, input.messageRefs ?? []),
        metadata,
      ),
    ).pipe(Effect.mapError((error) => failure(error.message)));
    if (replyToMessageId && pending)
      yield* storage.prepareResponse(
        sessionId,
        targetId,
        replyToMessageId,
        messageId,
        executingIds,
      );
    const attachments = input.inputRefs?.length
      ? yield* Effect.gen(function* () {
          const inputs = yield* TaskInputStorage;
          const grants = yield* inputs.authorizeForward(sessionId, input.inputRefs ?? [], targetId);
          return yield* inputs.grant(targetId, grants);
        })
      : [];
    if (
      !expectsResponse &&
      (!pending || pending.resultDelivery === "notification") &&
      input.delivery !== "steer" &&
      !attachments.length &&
      input.outcome !== "blocked" &&
      input.outcome !== "failed" &&
      isReferenceNotification(input.text)
    ) {
      yield* storage.withNoticeDelivery(
        Effect.gen(function* () {
          const requests = pending
            ? (yield* storage.state()).turns.filter((turn) =>
                turn.replyMessageIds?.includes(messageId),
              )
            : [];
          yield* storage.deferReferenceNotice(
            {
              id: messageId,
              recipientSessionId: targetId,
              text: encoded,
            },
            requests.map((request) => request.turnId),
          );
        }),
      );
      yield* projectTodoUpdates.offer({
        sessionId,
        projectPath: location.projectPath,
        text: input.text,
      });
      return toJsonValue({
        ok: true,
        command,
        status: "deferred",
        target: {
          kind: "cake-chat",
          ...(targetId === CAKE_CHAT_SESSION_ID ? null : { sessionId: targetId }),
        },
        targetTitle: targetId === CAKE_CHAT_SESSION_ID ? "Cake Chat" : "Project Chat",
        messageId,
        threadId: metadata.threadId,
        delivery: input.delivery ?? (snapshot.streaming ? "queue" : "prompt"),
        expectsResponse: false,
        recipientContext: crossSessionContextSnapshot(snapshot.usage?.context),
      });
    }
    const delivery = immediateDelivery(snapshot.streaming, input.delivery);
    if (delivery === "fyi") {
      const prepared = parseCrossSessionMessage(encoded);
      yield* storage.deferPassiveNotice({
        id: messageId,
        recipientSessionId: targetId,
        text: prepared?.text ?? input.text,
        crossSession: metadata,
      });
      if (substantiveTurnResult({ stopReason: "stop", text: input.text }))
        yield* projectTodoUpdates.offer({
          sessionId,
          projectPath: location.projectPath,
          text: input.text,
        });
      return toJsonValue({
        ok: true,
        command,
        status: "deferred",
        messageId,
        threadId: metadata.threadId,
        delivery,
        resultDelivery: "ignore",
        expectsResponse: false,
      });
    }
    const turnId =
      delivery === "steer"
        ? yield* destination.steer(encoded, attachments, false)
        : delivery === "queue"
          ? yield* destination.followUp(encoded, attachments, false)
          : yield* destination.prompt(encoded, attachments, false);
    if (replyToMessageId && pending)
      for (const request of (yield* storage.state()).turns)
        if (request.replyMessageIds?.includes(messageId))
          yield* storage.markNoticeAttempt(request.turnId, turnId);
    return toJsonValue({
      ok: true,
      command,
      target: {
        kind: "cake-chat",
        ...(targetId === CAKE_CHAT_SESSION_ID ? null : { sessionId: targetId }),
      },
      targetTitle: targetId === CAKE_CHAT_SESSION_ID ? "Cake Chat" : "Project Chat",
      status: delivery === "queue" ? "queued" : "accepted",
      delivery,
      turnId,
      messageId,
      threadId: metadata.threadId,
      expectsResponse: metadata.expectsResponse,
      resultDelivery: metadata.resultDelivery,
      recipientContext: crossSessionContextSnapshot(snapshot.usage?.context),
    });
  },
);

/** A deliberate stop by the session that is owed the result settles without a notice. */
const stoppedByRequester = (turn: FamilyTurn) =>
  turn.outcome === "aborted" &&
  turn.stop?.by === "session" &&
  turn.stop.sessionId === turn.senderSessionId;

const stoppedSummary = (stop: TurnStop | undefined) => {
  const text = stop ? describeTurnStop(stop, "agent") : "stopped";
  return (text.charAt(0).toUpperCase() + text.slice(1)).slice(0, 500);
};

const launchStatus = (
  turn: FamilyTurn,
  report: SessionCompletionReport | undefined,
): CakeChatLaunchStatus =>
  report
    ? report.outcome === "failed"
      ? "failed"
      : report.outcome === "blocked"
        ? "blocked"
        : "completed"
    : turn.outcome === "failed"
      ? "failed"
      : turn.outcome === "aborted" && !turn.stop
        ? "interrupted"
        : "stopped";

/** One compact status line; Cake Chat reads the full report on demand. */
const digestSummary = (turn: FamilyTurn, report: SessionCompletionReport | undefined) => {
  if (!report)
    return turn.outcome === "aborted"
      ? turn.stop
        ? stoppedSummary(turn.stop)
        : "canceled or interrupted"
      : "";
  const line = report.text
    .split("\n")
    .map((candidate) =>
      candidate
        .replace(/^[#>*\-\s]+/, "")
        .replaceAll("**", "")
        .trim(),
    )
    .find((candidate) => candidate.length > 0);
  if (!line) return "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
};

const sessionTitle = Effect.fn("SessionFamilies.sessionTitle")(function* (
  sessionId: string,
  workingDirectory: string | undefined,
) {
  const sessions = yield* CakeSessionRuntimes;
  const locations = yield* projectSessionLocations.locations({ includeInactive: true });
  for (const location of locations) {
    if (workingDirectory !== undefined && location.workingDirectory !== workingDirectory) continue;
    const entry = yield* sessions.catalogEntry(
      { workingDirectory: location.workingDirectory, sessionDirectory: location.sessionDirectory },
      sessionId,
    );
    if (entry) return entry.title;
  }
  return undefined;
});

const queueTurnCompletion = Effect.fn("SessionFamilies.queueTurnCompletion")(function* (
  turn: FamilyTurn,
  spawn?: SpawnedSession,
  title?: string,
  isolated = false,
) {
  const report = turn.report;
  const status = launchStatus(turn, report);
  yield* completionInbox.queue({
    id: turn.turnId,
    coordinatorSessionId: turn.senderSessionId,
    sessionId: turn.sessionId,
    title: (
      title ??
      (yield* sessionTitle(turn.sessionId, spawn?.workingDirectory).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )) ??
      `Session ${turn.sessionId}`
    ).slice(0, 500),
    summary: digestSummary(turn, report).slice(0, 500),
    notify: turn.resultDelivery === "notification" && report?.outcome !== "blocked",
    ...(report?.resultMessageRef ? { resultMessageRef: report.resultMessageRef } : null),
    ...(report && isReferenceNotification(report.text)
      ? { references: report.text.replace(/\s+/g, " ").slice(0, 6000) }
      : null),
    reportedAt: DateTime.formatIso(yield* DateTime.now),
    status,
    kind:
      status !== "completed"
        ? "blocked"
        : (report?.resultKind ?? (report?.outcome === "completed" ? "ready" : "investigation")),
    isolated: isolated || (spawn !== undefined && spawn.workingDirectory !== spawn.projectPath),
  });
});

/**
 * Correlated results follow the chosen delivery mode. Notification settles into the quiet
 * inbox without starting a turn; explicit blockers retain actionable escalation.
 * Immediate deliveries wait while the user has unsent Cake Chat text (bounded by the presence
 * timeout); the worker retries every pass.
 */
const deliverRequesterNotice = Effect.fn("SessionFamilies.deliverRequesterNotice")(function* (
  turn: FamilyTurn,
  spawn: SpawnedSession | undefined,
) {
  const storage = yield* SessionFamilyStorage;
  const catalogs = yield* SessionCatalogChanges;
  const report =
    turn.outcome === "complete" || (turn.outcome === "failed" && turn.report?.outcome === "failed")
      ? turn.report
      : undefined;
  const status = launchStatus(turn, report);
  const launchReport = {
    status,
    summary: digestSummary(turn, report),
    reportedAt: DateTime.formatIso(yield* DateTime.now),
  };
  yield* queueTurnCompletion(turn, spawn);
  const publishLaunch = spawn
    ? catalogs.publish({
        _tag: "ProjectSessionChanged",
        sessionId: spawn.sessionId,
        projectPath: spawn.projectPath,
        workingDirectory: spawn.workingDirectory,
        resolved: false,
      })
    : Effect.void;

  if (turn.resultDelivery === "notification" && status !== "blocked") {
    const title = yield* sessionTitle(turn.sessionId, spawn?.workingDirectory).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    yield* storage.withNoticeDelivery(
      storage.digestNotice(turn.turnId, {
        id: turn.turnId,
        coordinatorSessionId: turn.senderSessionId,
        sessionId: turn.sessionId,
        title: (title ?? `Session ${turn.sessionId}`).slice(0, 500),
        ...launchReport,
        ...(report?.resultMessageRef ? { resultMessageRef: report.resultMessageRef } : null),
      }),
    );
    yield* publishLaunch;
    return;
  }
  const presence = yield* Effect.serviceOption(CakeChatComposerPresence);
  if (
    !turn.deliveryTurnId &&
    Option.isSome(presence) &&
    (yield* presence.value.holdsInterrupts(turn.senderSessionId))
  )
    return;
  // Cold permanent chats use their primary runtime; independent Project requesters use normal acquisition.
  const sender = isCakeChatSessionId(turn.senderSessionId)
    ? yield* chatTargets.acquireAvailable(turn.senderSessionId)
    : yield* Effect.gen(function* () {
        const target = yield* projectSessionMetadata.findLocation({
          sessionId: turn.senderSessionId,
        });
        const location = (yield* projectSessionLocations.locations({ includeInactive: true })).find(
          (item) => item.workingDirectory === target.workingDirectory,
        );
        if (!location) return yield* failure("Requester Working Directory unavailable");
        return yield* (yield* CakeSessionRuntimes).acquire(
          yield* acquireProjectSessionOptions({
            location,
            sessionId: turn.senderSessionId,
            newSession: false,
          }),
        );
      });
  const text = encodeCrossSessionMessage(
    report
      ? formatCrossSessionReportText(
          turn.sessionId,
          report.outcome,
          appendMessageReferences(
            report.text,
            report.resultMessageRef ? [report.resultMessageRef] : [],
          ),
        )
      : formatCrossSessionNoticeText(
          turn.sessionId,
          turn.outcome === "aborted" && turn.stop
            ? { kind: "stopped", stoppedBy: describeTurnStop(turn.stop, "agent") }
            : {
                kind:
                  turn.outcome === "aborted"
                    ? "canceled"
                    : turn.outcome === "failed"
                      ? "failed"
                      : "no-result",
              },
        ),
    {
      version: 1,
      messageId: reportMessageId(turn.turnId),
      threadId: turn.threadId,
      sequence: 1,
      expectsResponse: false,
      generatedNotice: !report,
      ...(report ? { replyToMessageId: turn.requestMessageId } : null),
      sender: {
        sessionId: turn.sessionId,
        title: `Session ${turn.sessionId}`,
        kind: isCakeChatSessionId(turn.sessionId) ? "cake-chat" : "project-session",
        ...(spawn ? { workingDirectory: spawn.workingDirectory } : null),
      },
    },
  );
  if (spawn && !turn.deliveryTurnId)
    yield* storage.recordLaunchReport(spawn.sessionId, launchReport);
  yield* deliverOutcome(turn, sender, text);
  yield* publishLaunch;
});

const runPass = Effect.fn("SessionFamilies.deliverPendingNotices")(function* () {
  yield* workboardDeliveries.runPass();
  const storage = yield* SessionFamilyStorage;
  for (const turn of (yield* storage.state()).turns) {
    if (!turn.outcome || turn.reported) continue;
    yield* Effect.scoped(deliver(turn)).pipe(
      Effect.catch((error) => Effect.logError("Session result delivery will retry", error)),
    );
  }
  // After results settle into deferred stores, so a completion opens its batch this pass.
  yield* updateBatches
    .runPass()
    .pipe(Effect.catch((error) => Effect.logError("Batched update pass will retry", error)));
});

export const runWorker = runPass().pipe(
  Effect.catch((error) => Effect.logError("Session result delivery pass failed", error)),
  Effect.repeat(Schedule.spaced("1 second")),
);
