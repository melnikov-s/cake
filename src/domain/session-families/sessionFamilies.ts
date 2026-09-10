import { acquireOptions as acquireProjectSessionOptions } from "../project-sessions/projectSessionRuntime";
import * as projectSessionLocations from "../project-sessions/projectSessionLocations";
import { DateTime, Effect, Schedule } from "effect";
import type { ChatConfiguration } from "../../ipc/session-contract";
import { PiModels } from "../../services/pi/PiModels";
import { PiSessions, type PiSessionAcquireOptions } from "../../services/pi/PiSessions";
import type { ProjectSessionLocation } from "../project-sessions/project-session-data";
import * as projectSessionLifecycle from "../project-sessions/projectSessionLifecycle";
import {
  SessionArchiveStorage,
  type SessionArchiveLocation,
} from "../../services/storage/SessionArchiveStorage";
import {
  SessionFamilyStorage,
  SessionFamilyStorageError,
  type FamilyTurn,
} from "../../services/storage/SessionFamilyStorage";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import {
  encodeCrossSessionMessage,
  parseCrossSessionMessage,
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
  const state = yield* storage.state();
  if (state.transitions.some((item) => item.parentSessionId === family.parentSessionId))
    return yield* failure(
      "The Session Family has an incomplete lifecycle operation; retry after recovery",
    );
  const archive = yield* SessionArchiveStorage;
  if ((yield* archive.locate(sessionId, location)) === "resolved")
    return yield* failure(
      `Restore the family explicitly from parent ${family.parentSessionId} before starting work`,
    );
});

export const admitTurn = Effect.fn("SessionFamilies.admitTurn")(function* (
  sessionId: string,
  location: SessionArchiveLocation,
  turnId: string,
  accept: Effect.Effect<void>,
) {
  const storage = yield* SessionFamilyStorage;
  yield* storage.withMemberLock(
    sessionId,
    Effect.gen(function* () {
      yield* assertAdmission(sessionId, location);
      const family = yield* storage.familyForMember(sessionId);
      if (family && family.parentSessionId !== sessionId)
        yield* storage.recordTurn({
          sessionId,
          parentSessionId: family.parentSessionId,
          turnId,
          reported: false,
        });
      yield* accept;
    }),
  );
});

export const createChild = Effect.fn("SessionFamilies.createChild")(function* <E, R, E2, R2>(
  parentSessionId: string,
  location: ProjectSessionLocation,
  input: { requestId: string; title: string; initialPrompt: string; model: ChatConfiguration },
  runtimeOptions: (sessionId: string) => Effect.Effect<PiSessionAcquireOptions, E, R>,
  persistAvatarSeed: (sessionId: string) => Effect.Effect<void, E2, R2>,
) {
  const storage = yield* SessionFamilyStorage;
  const sessions = yield* PiSessions;
  const models = yield* PiModels;
  const archive = yield* SessionArchiveStorage;
  const catalogs = yield* SessionCatalogChanges;
  const configuration = yield* models.resolve(input.model);
  const archiveLocation = {
    cwd: location.workingDirectory,
    activeRoot: location.sessionDirectory,
    resolvedRoot: location.resolvedSessionDirectory,
  };
  const publish = (sessionId: string) =>
    catalogs.publish({
      _tag: "ProjectSessionChanged",
      sessionId,
      projectPath: location.projectPath,
      workingDirectory: location.workingDirectory,
      resolved: false,
    });
  const prepared = yield* storage.withMemberLock(
    parentSessionId,
    Effect.gen(function* () {
      yield* assertAdmission(parentSessionId, archiveLocation);
      const existing = yield* storage.familyForMember(parentSessionId);
      if (existing && existing.parentSessionId !== parentSessionId)
        return yield* new SessionFamilyStorageError({
          operation: "createChild",
          message: "Children must ask their parent to create a session",
        });
      const reservation = {
        familyId: existing?.familyId ?? crypto.randomUUID(),
        parentSessionId,
        childSessionId: crypto.randomUUID(),
        requestId: input.requestId,
        projectPath: location.projectPath,
        workingDirectory: location.workingDirectory,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      };
      if (location.managedWorktree)
        Object.assign(reservation, { managedWorktreePath: location.managedWorktree.worktreePath });
      const family = yield* storage.addChild(reservation);
      const child = family.children.find((item) => item.requestId === input.requestId);
      if (!child)
        return yield* new SessionFamilyStorageError({
          operation: "createChild",
          message: "Child reservation missing",
        });
      yield* publish(parentSessionId);
      yield* persistAvatarSeed(child.sessionId);
      const target = {
        sessionId: child.sessionId,
        workingDirectory: location.workingDirectory,
        sessionDirectory: location.sessionDirectory,
      };
      const status = yield* sessions.currentStatus(target);
      if (status || (yield* archive.locate(child.sessionId, archiveLocation)))
        return { family, child, handle: undefined };
      const acquired = yield* Effect.result(
        Effect.gen(function* () {
          const handle = yield* sessions.acquire(yield* runtimeOptions(child.sessionId));
          yield* handle.applyConfiguration(configuration);
          yield* handle.rename(input.title);
          return handle;
        }),
      );
      if (acquired._tag === "Failure") {
        if (!(yield* archive.locate(child.sessionId, archiveLocation)))
          yield* storage.removeUnmaterializedChild(child.sessionId);
        yield* publish(parentSessionId);
        return { family, child, handle: undefined, error: String(acquired.failure) };
      }
      return { family, child, handle: acquired.success };
    }),
  );
  const identity = {
    familyId: prepared.family.familyId,
    parentSessionId,
    childSessionId: prepared.child.sessionId,
    familyChildOrder: prepared.family.children.findIndex(
      (child) => child.sessionId === prepared.child.sessionId,
    ),
  };
  if (!prepared.handle)
    return {
      ...identity,
      launch: prepared.error
        ? { status: "failed", message: prepared.error }
        : { status: "already-started" },
    };
  const launched = yield* Effect.result(prepared.handle.prompt(input.initialPrompt, [], false));
  if (launched._tag === "Failure") {
    yield* storage.withMemberLock(
      parentSessionId,
      Effect.gen(function* () {
        if (!(yield* archive.locate(prepared.child.sessionId, archiveLocation)))
          yield* storage.removeUnmaterializedChild(prepared.child.sessionId);
        yield* publish(parentSessionId);
      }),
    );
    return { ...identity, launch: { status: "failed", message: String(launched.failure) } };
  }
  yield* publish(prepared.child.sessionId);
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
          cwd: family.workingDirectory,
          activeRoot,
          resolvedRoot,
        })
      )
        continue;
      // The process ended before Pi materialized the reservation. It must not
      // remain a phantom member that prevents the family from being archived.
      yield* storage.recordTurn({
        sessionId: child.sessionId,
        parentSessionId: family.parentSessionId,
        turnId: child.sessionId,
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
  for (const journal of (yield* storage.state()).transitions)
    yield* projectSessionLifecycle.recoverFamilyTransition(
      journal.parentSessionId,
      journal.resolved,
    );
});

export const deliver = Effect.fn("SessionFamilies.deliverNotice")(function* (turn: FamilyTurn) {
  const storage = yield* SessionFamilyStorage;
  const family = yield* storage.familyForMember(turn.parentSessionId);
  if (!family || !turn.outcome || turn.reported) return;
  const state = yield* storage.state();
  if (state.transitions.some((item) => item.parentSessionId === family.parentSessionId)) return;
  const location = (yield* projectSessionLocations.locations()).find(
    (item) => item.workingDirectory === family.workingDirectory,
  );
  if (!location)
    return yield* new SessionFamilyStorageError({
      operation: "deliverNotice",
      message: `Working Directory unavailable: ${family.workingDirectory}`,
    });
  const archive = yield* SessionArchiveStorage;
  if (
    (yield* archive.locate(family.parentSessionId, {
      cwd: family.workingDirectory,
      activeRoot: location.sessionDirectory,
      resolvedRoot: location.resolvedSessionDirectory,
    })) !== "active"
  )
    return;
  const sessions = yield* PiSessions;
  yield* storage.withMemberLock(
    family.parentSessionId,
    Effect.gen(function* () {
      const status = yield* sessions.currentStatus({
        sessionId: turn.sessionId,
        workingDirectory: family.workingDirectory,
        sessionDirectory: location.sessionDirectory,
      });
      if (
        !status?.streaming &&
        !status?.pending &&
        !(yield* archive.locate(turn.sessionId, {
          cwd: family.workingDirectory,
          activeRoot: location.sessionDirectory,
          resolvedRoot: location.resolvedSessionDirectory,
        }))
      )
        yield* storage.removeUnmaterializedChild(turn.sessionId);
    }),
  );
  const parent = yield* sessions.acquire(
    yield* acquireProjectSessionOptions({
      location,
      sessionId: family.parentSessionId,
      newSession: false,
    }),
  );
  const snapshot = yield* parent.snapshot();
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
  const outcome =
    turn.outcome === "failed"
      ? "stopped with an error"
      : turn.outcome === "aborted"
        ? "was aborted"
        : "stopped";
  const childSummary = yield* sessions
    .catalogEntry(
      {
        workingDirectory: family.workingDirectory,
        sessionDirectory: location.sessionDirectory,
      },
      turn.sessionId,
    )
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  const text = encodeCrossSessionMessage(
    `Child session ${turn.sessionId} ${outcome} without sending a response to its parent.`,
    {
      version: 1,
      messageId: turn.turnId,
      threadId: turn.turnId,
      sequence: 1,
      sender: {
        sessionId: turn.sessionId,
        title: childSummary?.title ?? `Child session ${turn.sessionId}`,
        kind: "project-session",
        projectName: location.projectName,
        workingDirectory: location.workingDirectory,
      },
    },
  );
  const queue = yield* parent.listQueuedMessages();
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
      sessionId: family.parentSessionId,
      workingDirectory: family.workingDirectory,
      sessionDirectory: location.sessionDirectory,
    })).includes(turn.deliveryTurnId)
  )
    return;
  // Match ordinary user delivery: start an idle parent, or queue behind its
  // active turn without steering or interrupting it.
  const deliveryTurnId = snapshot.streaming
    ? yield* parent.followUp(text, [], false)
    : yield* parent.prompt(text, [], false);
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
