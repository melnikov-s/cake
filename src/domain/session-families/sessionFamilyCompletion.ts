import { createHash } from "node:crypto";
import { describeTurnStop, type TurnStop } from "../../contracts/conversations/turn-stop";
import { appendMessageReferences } from "../../contracts/conversations/message-reference-forwarding";
import { isReferenceNotification } from "../../contracts/conversations/reference-notification";
import * as projectTodoAttention from "../projects/projectTodoAttention";
import * as completionInbox from "../conversations/completionInbox";
import { isCakeChatSessionId } from "../../contracts/cake-chats/cake-chat-identity";
import { inheritTaskInputProtection, prepareCoordinatorNotice } from "../conversations/taskInputs";
import type {
  CakeChatLaunchStatus,
  SessionCompletionReport,
} from "../../contracts/project-sessions/session-reporting";
import { acquireOptions as acquireProjectSessionOptions } from "../project-sessions/projectSessionRuntime";
import * as projectSessionLocations from "../project-sessions/projectSessionLocations";
import * as projectSessionMetadata from "../project-sessions/projectSessionMetadata";
import { DateTime, Effect, Option } from "effect";
import { CakeChatComposerPresence } from "../../services/session-catalogs/CakeChatComposerPresence";
import { CakeSessionRuntimes, type CakeSessionHandle } from "../../services/pi/CakeSessionRuntimes";
import { resolutionNamespace } from "../project-sessions/projectSessionResolution";
import { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import {
  familyMember,
  type FamilyTurn,
  type SpawnedSession,
} from "../../contracts/session-families/session-family-document";
import * as chatTargets from "../cake-chats/cakeChatTargets";
import { SessionFamilyStorageError } from "../../contracts/storage/session-family-storage-errors";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import {
  encodeCrossSessionMessage,
  formatCrossSessionNoticeText,
  formatCrossSessionReportText,
  parseCrossSessionMessage,
} from "../../contracts/conversations/cross-session-message";
const failure = (message: string) =>
  new SessionFamilyStorageError({ operation: "familyLifecycle", message });

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
  if (!turn.outcome || turn.reported) return;
  // Retain quiet results before touching either runtime or the source checkout.
  // A dead requester (including legacy Side Chats) must not hold this handoff open.
  if (
    !stoppedByRequester(turn) &&
    turn.resultDelivery === "notification" &&
    turn.report?.outcome !== "blocked"
  )
    return yield* (
      isCakeChatSessionId(turn.senderSessionId) ? deliverRequesterNotice : retainNotification
    )(
      turn,
      (yield* storage.state()).spawnedSessions.find((item) => item.sessionId === turn.sessionId),
    );
  const family =
    (yield* storage.familyForMember(turn.sessionId)) ??
    (yield* storage.familyForMember(turn.senderSessionId));
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
      ...(report?.resultMessageRef ? { sourceMessageRef: report.resultMessageRef } : null),
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

const queueTurnCompletion = Effect.fn("SessionFamilies.queueTurnCompletion")(function* (
  turn: FamilyTurn,
  spawn?: SpawnedSession,
  title?: string,
  isolated = false,
  notify?: boolean,
) {
  const report = turn.report;
  const status = launchStatus(turn, report);
  yield* completionInbox.queue({
    id: turn.turnId,
    coordinatorSessionId: turn.senderSessionId,
    sessionId: turn.sessionId,
    title: (title ?? spawn?.title ?? `Session ${turn.sessionId}`).slice(0, 500),
    summary: digestSummary(turn, report).slice(0, 500),
    notify: notify ?? (turn.resultDelivery === "notification" && report?.outcome !== "blocked"),
    ...(report?.resultMessageRef
      ? { resultMessageRef: report.resultMessageRef }
      : report
        ? { resultText: report.text }
        : null),
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

/** Durable quiet handling has no runtime/checkout dependency. The inbox retains
 * the exact source before settlement; both writes reconcile by the original turn ID. */
export const retainNotification = Effect.fn("SessionFamilies.retainNotification")(function* (
  turn: FamilyTurn,
  spawn?: SpawnedSession,
) {
  const storage = yield* SessionFamilyStorage;
  const current = (yield* storage.state()).turns.find(
    (item) => item.turnId === turn.turnId && !item.reported,
  );
  if (!current?.outcome) return;
  turn = current;
  yield* queueTurnCompletion(turn, spawn);
  yield* storage.digestNotice(turn.turnId, {
    id: turn.turnId,
    coordinatorSessionId: turn.senderSessionId,
    sessionId: turn.sessionId,
    title: (spawn?.title ?? `Session ${turn.sessionId}`).slice(0, 500),
    status: launchStatus(turn, turn.report),
    summary: digestSummary(turn, turn.report),
    reportedAt: DateTime.formatIso(yield* DateTime.now),
    ...(turn.report?.resultMessageRef ? { resultMessageRef: turn.report.resultMessageRef } : null),
  });
  if (spawn)
    yield* (yield* SessionCatalogChanges).publish({
      _tag: "ProjectSessionChanged",
      sessionId: spawn.sessionId,
      projectPath: spawn.projectPath,
      workingDirectory: spawn.workingDirectory,
      resolved: false,
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
      ...(report?.resultMessageRef ? { sourceMessageRef: report.resultMessageRef } : null),
      ...(report ? { replyToMessageId: turn.requestMessageId } : null),
      sender: {
        sessionId: turn.sessionId,
        title: `Session ${turn.sessionId}`,
        kind: isCakeChatSessionId(turn.sessionId) ? "cake-chat" : "project-session",
        ...(spawn ? { workingDirectory: spawn.workingDirectory } : null),
      },
    },
  );
  const held =
    turn.resultDelivery === "notification" && isCakeChatSessionId(turn.senderSessionId)
      ? yield* storage.withNoticeDelivery(
          projectTodoAttention.hold(
            { id: reportMessageId(turn.turnId), recipientSessionId: turn.senderSessionId, text },
            { sessionId: turn.sessionId, label: digestSummary(turn, report) },
            [turn.turnId],
          ),
        )
      : false;
  yield* queueTurnCompletion(turn, spawn, undefined, false, held ? false : undefined);
  const publishLaunch = spawn
    ? catalogs.publish({
        _tag: "ProjectSessionChanged",
        sessionId: spawn.sessionId,
        projectPath: spawn.projectPath,
        workingDirectory: spawn.workingDirectory,
        resolved: false,
      })
    : Effect.void;

  if (held) {
    if (spawn) yield* storage.recordLaunchReport(spawn.sessionId, launchReport);
    yield* publishLaunch;
    return;
  }
  if (turn.resultDelivery === "notification" && status !== "blocked")
    return yield* retainNotification(turn, spawn);
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

  if (spawn && !turn.deliveryTurnId)
    yield* storage.recordLaunchReport(spawn.sessionId, launchReport);
  yield* deliverOutcome(turn, sender, text);
  yield* publishLaunch;
});
