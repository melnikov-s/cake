import { acquireOptions as acquireProjectSessionOptions } from "../project-sessions/projectSessionRuntime";
import * as projectSessionLocations from "../project-sessions/projectSessionLocations";
import { DateTime, Effect, Exit, Schedule } from "effect";
import type { ChatConfiguration } from "../../ipc/session-contract";
import { PiModels } from "../../services/pi/PiModels";
import {
  CakeSessionRuntimes,
  type CakeSessionRuntimeAcquireOptions,
} from "../../services/pi/CakeSessionRuntimes";
import type { ProjectSessionLocation } from "../project-sessions/project-session-data";
import { resolutionNamespace } from "../project-sessions/projectSessionResolution";
import {
  SessionArchiveStorage,
  type SessionArchiveLocation,
} from "../../services/storage/SessionArchiveStorage";
import {
  SessionFamilyStorage,
  SessionFamilyStorageError,
  familyChildren,
  familyDepth,
  familyMember,
  type FamilyTurn,
} from "../../services/storage/SessionFamilyStorage";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import {
  encodeCrossSessionMessage,
  parseCrossSessionMessage,
  type CrossSessionContextSnapshot,
} from "../conversations/cross-session-coordination";

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
      if (
        family &&
        request &&
        !request.metadata.generatedNotice &&
        senderSessionId !== undefined &&
        familyMember(family, senderSessionId) !== undefined
      )
        yield* storage.recordTurn({
          sessionId,
          senderSessionId,
          turnId: input.turnId,
          requestMessageId: request.metadata.messageId,
          threadId: request.metadata.threadId,
          expectsResponse: request.metadata.expectsResponse,
          reported: false,
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
    expectsResponse: true,
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
        expectsResponse: true,
        reported: false,
        outcome: "failed",
      });
      yield* storage.removeUnmaterializedChild(child.sessionId);
    }
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
  if (!family || !turn.outcome || turn.reported) return;
  if (turn.outcome === "aborted") {
    yield* storage.completeNotice(turn.turnId);
    return;
  }
  const senderMember = familyMember(family, turn.senderSessionId);
  const childMember = familyMember(family, turn.sessionId);
  if (!senderMember || !childMember) return;
  // Outcome notices exist so a delegating parent learns when its child stops.
  // A child is never told about its parent's turns, and no member is told
  // about a session it does not own.
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
  const snapshot = yield* sender.snapshot();
  if (
    snapshot.parts.some(
      (part) =>
        part.kind === "text" &&
        part.crossSession &&
        (part.crossSession.messageId === turn.turnId ||
          turn.replyMessageIds?.includes(part.crossSession.messageId)) &&
        !part.deliveryState,
    )
  ) {
    yield* storage.completeNotice(turn.turnId);
    return;
  }
  const outcome = turn.outcome === "failed" ? "stopped with an error" : "stopped";
  const childSummary = yield* sessions
    .catalogEntry(
      {
        workingDirectory: childMember.workingDirectory,
        sessionDirectory: childLocation.sessionDirectory,
      },
      turn.sessionId,
    )
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  const missingResponse = turn.expectsResponse && turn.outcome === "complete";
  const text = encodeCrossSessionMessage(
    missingResponse
      ? `Session ${turn.sessionId} stopped without replying to request ${turn.requestMessageId}.`
      : `Session ${turn.sessionId} ${outcome} while processing message ${turn.requestMessageId}.`,
    {
      version: 1,
      messageId: turn.turnId,
      threadId: turn.threadId,
      sequence: 1,
      expectsResponse: false,
      generatedNotice: true,
      sender: {
        sessionId: turn.sessionId,
        title: childSummary?.title ?? `Session ${turn.sessionId}`,
        kind: "project-session",
        projectName: childLocation.projectName,
        workingDirectory: childLocation.workingDirectory,
      },
    },
  );
  const queue = yield* sender.listQueuedMessages();
  const queuedMessages = [...queue.steering, ...queue.followUp];
  if (
    queuedMessages.some((content) => {
      const reply = parseCrossSessionMessage(content);
      return reply && turn.replyMessageIds?.includes(reply.metadata.messageId);
    })
  ) {
    yield* storage.completeNotice(turn.turnId);
    return;
  }
  if (queuedMessages.includes(text)) return;
  if (
    turn.deliveryTurnId &&
    (yield* sessions.currentTurnIds({
      sessionId: turn.senderSessionId,
      workingDirectory: senderMember.workingDirectory,
      sessionDirectory: senderLocation.sessionDirectory,
    })).includes(turn.deliveryTurnId)
  )
    return;
  // Match ordinary user delivery: start an idle sender, or queue behind its
  // active turn without steering or interrupting it.
  const deliveryTurnId = snapshot.streaming
    ? yield* sender.followUp(text, [], false)
    : yield* sender.prompt(text, [], false);
  yield* storage.markNoticeAttempt(turn.turnId, deliveryTurnId);
});

const runPass = Effect.fn("SessionFamilies.deliverPendingNotices")(function* () {
  const storage = yield* SessionFamilyStorage;
  for (const turn of (yield* storage.state()).turns) {
    if (!turn.outcome || turn.reported) continue;
    yield* Effect.scoped(deliver(turn)).pipe(
      Effect.catch((error) => Effect.logError("Family outcome delivery will retry", error)),
    );
  }
});

export const runWorker = runPass().pipe(
  Effect.catch((error) => Effect.logError("Family delivery pass failed", error)),
  Effect.repeat(Schedule.spaced("1 second")),
);
