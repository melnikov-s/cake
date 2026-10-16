import { describeTurnStop, type TurnStop } from "../../contracts/conversations/turn-stop";
import { appendMessageReferences } from "../../contracts/conversations/message-reference-forwarding";
import { TaskInputStorage } from "../../services/storage/TaskInputStorage";
import { ensureBoard } from "../artifacts/messageBoards";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-data";
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
import * as workflowLifecycle from "../workflows/workflow-lifecycle";
import { DateTime, Effect, Exit, Option, Schedule } from "effect";
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
import { SessionFamilyStorageError } from "../../contracts/storage/session-family-storage-errors";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import {
  encodeCrossSessionMessage,
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

export const admitTurn = Effect.fn("SessionFamilies.admitTurn")(function* (
  sessionId: string,
  location: SessionArchiveLocation,
  input: { readonly turnId: string; readonly text: string },
  accept: Effect.Effect<void>,
) {
  const storage = yield* SessionFamilyStorage;
  yield* storage.withMemberLock(
    sessionId,
    Effect.gen(function* () {
      yield* assertAdmission(sessionId, location);
      const family = yield* storage.familyForMember(sessionId);
      const request = parseCrossSessionMessage(input.text);
      const senderSessionId = request?.metadata.sender.sessionId;
      const familyRequest =
        family &&
        senderSessionId !== undefined &&
        familyMember(family, senderSessionId) !== undefined;
      // Cake Chat may ask any Project Session for a result, whether or not it launched it.
      const coordinatorRequest =
        senderSessionId === CAKE_CHAT_SESSION_ID && request?.metadata.sender.kind === "cake-chat";
      // A reply obligation belongs to this one message, never to the session
      // relationship: user-started turns and messages that asked for no
      // response are not journaled and therefore never produce notices.
      if (
        (familyRequest || coordinatorRequest) &&
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
          ...(coordinatorRequest ? { reportPolicy: request.metadata.report ?? "interrupt" } : null),
        });
      yield* accept.pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? storage.completeNotice(input.turnId) : Effect.void,
        ),
      );
    }),
  );
});

export const createChild = Effect.fn("SessionFamilies.createChild")(function* <
  E,
  R,
  E2 = never,
  R2 = never,
  E3 = never,
  R3 = never,
  E4 = never,
  R4 = never,
>(
  parentSessionId: string,
  location: ProjectSessionLocation,
  input: {
    requestId: string;
    title: string;
    initialPrompt: string;
    model: ChatConfiguration;
    /** Whether the initial assignment owes the parent one result report; defaults to true. */
    expectsResponse?: boolean;
    worktreeName?: string;
    senderContext: CrossSessionContextSnapshot;
  },
  runtimeOptions: (
    sessionId: string,
    childLocation: ProjectSessionLocation,
  ) => Effect.Effect<CakeSessionRuntimeAcquireOptions, E, R>,
  createIsolatedLocation?: (worktreeName: string) => Effect.Effect<ProjectSessionLocation, E2, R2>,
  resolveLocation?: (workingDirectory: string) => Effect.Effect<ProjectSessionLocation, E3, R3>,
  discardIsolatedLocation?: (workingDirectory: string) => Effect.Effect<void, E4, R4>,
) {
  const storage = yield* SessionFamilyStorage;
  const sessions = yield* CakeSessionRuntimes;
  const models = yield* PiModels;
  const archive = yield* SessionArchiveStorage;
  const catalogs = yield* SessionCatalogChanges;
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
  const prepared = yield* storage.withMemberLock(
    parentSessionId,
    Effect.gen(function* () {
      yield* assertAdmission(parentSessionId, archiveLocation(location.workingDirectory));
      const existing = yield* storage.familyForMember(parentSessionId);
      const retriedChild = existing?.children.find((item) => item.requestId === input.requestId);
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
      const reservation = {
        familyId: existing?.familyId ?? crypto.randomUUID(),
        parentSessionId,
        parentWorkingDirectory: location.workingDirectory,
        childSessionId: crypto.randomUUID(),
        childWorkingDirectory: childLocation.workingDirectory,
        requestId: input.requestId,
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
            childLocation.workingDirectory !== location.workingDirectory && discardIsolatedLocation
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
      yield* ensureBoard(family, originatingSession?.title);
      const child = family.children.find((item) => item.requestId === input.requestId);
      if (!child)
        return yield* new SessionFamilyStorageError({
          operation: "createChild",
          message: "Child reservation missing",
        });
      yield* publish(parentSessionId, location.workingDirectory);
      const target = {
        sessionId: child.sessionId,
        workingDirectory: childLocation.workingDirectory,
        sessionDirectory: childLocation.sessionDirectory,
      };
      const status = yield* sessions.currentStatus(target);
      if (
        status ||
        (yield* archive.locate(child.sessionId, archiveLocation(childLocation.workingDirectory)))
      )
        return { family, child, childLocation, handle: undefined };
      const acquired = yield* Effect.result(
        Effect.gen(function* () {
          const handle = yield* sessions.acquire(
            yield* runtimeOptions(child.sessionId, childLocation),
          );
          yield* handle.applyConfiguration(configuration);
          yield* handle.rename(input.title);
          return handle;
        }),
      );
      if (acquired._tag === "Failure") {
        if (
          !(yield* archive.locate(child.sessionId, archiveLocation(childLocation.workingDirectory)))
        ) {
          yield* storage.removeUnmaterializedChild(child.sessionId);
          if (
            childLocation.workingDirectory !== location.workingDirectory &&
            discardIsolatedLocation
          )
            yield* discardIsolatedLocation(childLocation.workingDirectory);
        }
        yield* publish(parentSessionId, location.workingDirectory);
        return {
          family,
          child,
          childLocation,
          handle: undefined,
          error: String(acquired.failure),
        };
      }
      return { family, child, childLocation, handle: acquired.success };
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
  };
  if (!prepared.handle)
    return {
      ...identity,
      launch: prepared.error
        ? { status: "failed", message: prepared.error }
        : { status: "already-started" },
    };
  const initialMessage = encodeCrossSessionMessage(input.initialPrompt, {
    version: 1,
    messageId: prepared.child.sessionId,
    threadId: prepared.family.familyId,
    sequence: 1,
    expectsResponse: input.expectsResponse ?? true,
    context: input.senderContext,
    sender: {
      sessionId: parentSessionId,
      title: `Parent session ${parentSessionId}`,
      kind: "project-session",
      projectName: location.projectName,
      workingDirectory: location.workingDirectory,
    },
  });
  const launched = yield* Effect.result(prepared.handle.prompt(initialMessage, [], false));
  if (launched._tag === "Failure") {
    yield* storage.withMemberLock(
      parentSessionId,
      Effect.gen(function* () {
        if (
          !(yield* archive.locate(
            prepared.child.sessionId,
            archiveLocation(prepared.childLocation.workingDirectory),
          ))
        ) {
          yield* storage.removeUnmaterializedChild(prepared.child.sessionId);
          if (
            prepared.childLocation.workingDirectory !== location.workingDirectory &&
            discardIsolatedLocation
          )
            yield* discardIsolatedLocation(prepared.childLocation.workingDirectory);
        }
        yield* publish(parentSessionId, location.workingDirectory);
      }),
    );
    return { ...identity, launch: { status: "failed", message: String(launched.failure) } };
  }
  yield* publish(prepared.child.sessionId, prepared.childLocation.workingDirectory);
  return { ...identity, launch: { status: "accepted", turnId: launched.success } };
});

export const initialize = Effect.fn("SessionFamilies.initialize")(function* (
  activeRoot: string,
  resolvedRoot: string,
) {
  const storage = yield* SessionFamilyStorage;
  const archive = yield* SessionArchiveStorage;
  for (const family of yield* storage.list()) {
    for (const child of family.children) {
      if (
        yield* archive.locate(child.sessionId, {
          cwd: child.workingDirectory,
          activeRoot,
          resolvedRoot,
        })
      )
        continue;
      // The process ended before Pi materialized the reservation. It must not
      // remain a phantom member that prevents the family from being archived.
      yield* storage.recordTurn({
        sessionId: child.sessionId,
        senderSessionId: child.parentSessionId,
        turnId: child.sessionId,
        requestMessageId: child.sessionId,
        threadId: family.familyId,
        reported: false,
        outcome: "failed",
      });
      yield* storage.removeUnmaterializedChild(child.sessionId);
    }
  }
  const state = yield* storage.state();
  for (const spawn of state.spawnedSessions) {
    if (spawn.handoffSettled || state.turns.some((turn) => turn.sessionId === spawn.sessionId))
      continue;
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
      ...(spawn.reportPolicy ? { reportPolicy: spawn.reportPolicy } : null),
    });
  }
  for (const turn of (yield* storage.state()).turns) {
    // No process-local turn survives restart. Accepted-but-unsettled work is
    // reported as interrupted, never silently treated as complete.
    if (!turn.outcome) yield* storage.settleTurn(turn.turnId, "aborted");
  }
});

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
    if (turn.senderSessionId === CAKE_CHAT_SESSION_ID && spawn)
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
  if (turn.senderSessionId === CAKE_CHAT_SESSION_ID)
    return yield* deliverCoordinatorNotice(
      turn,
      (yield* storage.state()).spawnedSessions.find((item) => item.sessionId === turn.sessionId),
    );
  if (!family) return;
  const senderMember = familyMember(family, turn.senderSessionId);
  const childMember = familyMember(family, turn.sessionId);
  if (!senderMember || !childMember) return;
  // Automatic outcome notices exist so a delegating parent learns when its child
  // stops. Requests to a parent or sibling are answered only by explicit
  // sessions.reply; a child is never told about its parent's turns.
  if (childMember.parentSessionId !== turn.senderSessionId) {
    yield* storage.completeNotice(turn.turnId);
    return;
  }
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
  const outcome =
    turn.outcome === "aborted"
      ? turn.stop
        ? `was ${describeTurnStop(turn.stop, "agent")} (not completed)`
        : "was canceled or interrupted (not completed)"
      : turn.outcome === "failed"
        ? "stopped with an error"
        : "stopped";
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
  const missingResponse = turn.outcome === "complete";
  const text = encodeCrossSessionMessage(
    report
      ? `Session ${turn.sessionId} — ${report.outcome}\n\n${report.text}`
      : missingResponse
        ? `Session ${turn.sessionId} stopped without replying to request ${turn.requestMessageId}.`
        : `Session ${turn.sessionId} ${outcome} while processing message ${turn.requestMessageId}.`,
    {
      version: 1,
      messageId: turn.turnId,
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

/** One receipt/retry policy for family parents and the global coordinator. */
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
      if (turn.senderSessionId === CAKE_CHAT_SESSION_ID)
        text = yield* prepareCoordinatorNotice(turn.senderSessionId, text).pipe(
          Effect.mapError((error) => failure(error.message)),
        );
      else
        yield* inheritTaskInputProtection(turn.sessionId, turn.senderSessionId).pipe(
          Effect.mapError((error) => failure(error.message)),
        );
      const snapshot = yield* sender.snapshot();
      const receipt = snapshot.parts.find(
        (part) =>
          (part.kind === "context" || (part.kind === "text" && !part.deliveryState)) &&
          "crossSession" in part &&
          part.crossSession &&
          (part.crossSession.messageId === turn.turnId ||
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
      delivery?: "prompt" | "queue" | "steer";
      threadId?: string;
      replyToMessageId?: string;
      expectsResponse?: boolean;
      inputRefs?: readonly string[];
      messageRefs?: readonly string[];
      outcome?: SessionCompletionReport["outcome"];
    },
    location: ProjectSessionLocation,
    senderContext?: CrossSessionContextSnapshot,
  ) {
    const storage = yield* SessionFamilyStorage;
    const state = yield* storage.state();
    const spawn = state.spawnedSessions.find((item) => item.sessionId === sessionId);
    // A session Cake Chat did not launch still answers Cake Chat's own requests to it.
    const owesCoordinator =
      !spawn &&
      state.turns.some(
        (turn) =>
          turn.sessionId === sessionId &&
          turn.senderSessionId === CAKE_CHAT_SESSION_ID &&
          !turn.reported,
      ) &&
      !(yield* storage.familyForMember(sessionId));
    const requesterId =
      spawn?.requester.sessionId ?? (owesCoordinator ? CAKE_CHAT_SESSION_ID : undefined);
    const targetId = command === "sessions.reply" ? requesterId : input.sessionId;
    if (targetId !== CAKE_CHAT_SESSION_ID) return undefined;
    const sessions = yield* CakeSessionRuntimes;
    const executingIds = yield* sessions.executingTurnIds({
      sessionId,
      workingDirectory: location.workingDirectory,
      sessionDirectory: location.sessionDirectory,
    });
    const pending =
      command === "sessions.reply" ||
      input.replyToMessageId ||
      (requesterId !== undefined && !input.expectsResponse)
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
      !input.expectsResponse &&
      (input.threadId === undefined || input.threadId === spawn.sessionId) &&
      (input.replyToMessageId === undefined || input.replyToMessageId === spawn.sessionId)
    )
      return toJsonValue({ ok: true, command, status: "already-reported", expectsResponse: false });
    if (pending && pending.outcome === undefined && !input.expectsResponse) {
      if (!substantiveTurnResult({ stopReason: "stop", text: input.text }))
        return yield* failure(
          "A result report must contain substantive findings, changes, or a blocker—not an acknowledgment",
        );
      yield* storage.recordReport(pending.turnId, {
        outcome: input.outcome ?? "result",
        text: appendMessageReferences(input.text, input.messageRefs ?? []),
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
    const destination = yield* sessions.acquireSession(targetId);
    const snapshot = yield* destination.snapshot();
    const messageId = crypto.randomUUID();
    const replyToMessageId = pending?.requestMessageId ?? input.replyToMessageId;
    const metadata = {
      version: 1 as const,
      messageId,
      threadId: pending?.threadId ?? input.threadId ?? spawn?.sessionId ?? crypto.randomUUID(),
      sequence: 1,
      expectsResponse: input.expectsResponse ?? false,
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
    const delivery = input.delivery ?? (snapshot.streaming ? "queue" : "prompt");
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
      target: { kind: "cake-chat", sessionId: targetId },
      targetTitle: "Cake Chat",
      status: delivery === "queue" ? "queued" : "accepted",
      turnId,
      messageId,
      threadId: metadata.threadId,
      expectsResponse: metadata.expectsResponse,
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

/**
 * Cake Chat results follow the request's report policy. Digest settles the obligation into the
 * quiet inbox without starting a turn; a blocked report escalates to immediate delivery.
 * Immediate deliveries wait while the user has unsent Cake Chat text (bounded by the presence
 * timeout); the worker retries every pass.
 */
const deliverCoordinatorNotice = Effect.fn("SessionFamilies.deliverCoordinatorNotice")(function* (
  turn: FamilyTurn,
  spawn: SpawnedSession | undefined,
) {
  const storage = yield* SessionFamilyStorage;
  const sessions = yield* CakeSessionRuntimes;
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
  const publishLaunch = spawn
    ? catalogs.publish({
        _tag: "ProjectSessionChanged",
        sessionId: spawn.sessionId,
        projectPath: spawn.projectPath,
        workingDirectory: spawn.workingDirectory,
        resolved: false,
      })
    : Effect.void;
  if ((turn.reportPolicy ?? "interrupt") === "digest" && status !== "blocked") {
    const title = yield* sessionTitle(turn.sessionId, spawn?.workingDirectory).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    yield* storage.withNoticeDelivery(
      storage.digestNotice(turn.turnId, {
        id: turn.turnId,
        sessionId: turn.sessionId,
        title: (title ?? `Session ${turn.sessionId}`).slice(0, 500),
        ...launchReport,
      }),
    );
    yield* publishLaunch;
    return;
  }
  const presence = yield* Effect.serviceOption(CakeChatComposerPresence);
  if (!turn.deliveryTurnId && Option.isSome(presence) && (yield* presence.value.holdsInterrupts))
    return;
  // Cake Chat is a primary runtime destination, never a Project catalog lookup.
  // Until its owning surface assembles the runtime after startup, leave the outbox durable.
  const sender = yield* sessions.acquireSession(CAKE_CHAT_SESSION_ID);
  const text = encodeCrossSessionMessage(
    report
      ? `Session ${turn.sessionId} — ${report.outcome}\n\n${report.text}`
      : turn.outcome === "aborted"
        ? turn.stop
          ? `Session ${turn.sessionId} was ${describeTurnStop(turn.stop, "agent")}; no result handoff occurred.`
          : `Session ${turn.sessionId} was canceled or interrupted; no successful result handoff occurred.`
        : turn.outcome === "failed"
          ? `Session ${turn.sessionId} failed; no successful result handoff occurred.`
          : `Session ${turn.sessionId} stopped without a substantive result. This is not a successful completion.`,
    {
      version: 1,
      messageId: turn.turnId,
      threadId: turn.threadId,
      sequence: 1,
      expectsResponse: false,
      generatedNotice: !report,
      ...(report ? { replyToMessageId: turn.requestMessageId } : null),
      sender: {
        sessionId: turn.sessionId,
        title: `Session ${turn.sessionId}`,
        kind: "project-session",
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
  const storage = yield* SessionFamilyStorage;
  for (const turn of (yield* storage.state()).turns) {
    if (!turn.outcome || turn.reported) continue;
    yield* Effect.scoped(deliver(turn)).pipe(
      Effect.catch((error) => Effect.logError("Session result delivery will retry", error)),
    );
  }
});

export const runWorker = runPass().pipe(
  Effect.catch((error) => Effect.logError("Session result delivery pass failed", error)),
  Effect.repeat(Schedule.spaced("1 second")),
);
