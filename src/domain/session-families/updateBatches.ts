import { DateTime, Effect, Option } from "effect";
import {
  CAKE_CHAT_SESSION_ID,
  isCakeChatSessionId,
} from "../../contracts/cake-chats/cake-chat-identity";
import {
  passiveNoticeContext,
  type StoredPassiveNotice,
} from "../../contracts/conversations/passive-notice";
import {
  addReferenceNotifications,
  pendingReportPage,
} from "../../contracts/conversations/reference-notification";
import { updateBatchDueAt, updateBatchReminder } from "../../contracts/conversations/update-batch";
import type { SessionContextMetadata } from "../../contracts/conversations/session-context-metadata";
import { sessionContextCost } from "../../utils/session-context-cost";
import { CakeSessionRuntimes, type CakeSessionHandle } from "../../services/pi/CakeSessionRuntimes";
import { CakeChatConfiguration } from "../../services/pi-durable/CakeChatConfiguration";
import { CakeChatComposerPresence } from "../../services/session-catalogs/CakeChatComposerPresence";
import { RuntimeRecoveryStorage } from "../../services/storage/RuntimeRecoveryStorage";
import {
  SessionFamilyStorage,
  type SessionFamilyDocument,
  type UpdateBatch,
} from "../../services/storage/SessionFamilyStorage";
import * as cakeChatDigest from "../cake-chats/cakeChatDigest";
import * as chatMetadata from "../cake-chats/cakeChatMetadata";
import * as chatTargets from "../cake-chats/cakeChatTargets";
import { findLocation } from "../project-sessions/projectSessionMetadata";
import { resolutionNamespace } from "../project-sessions/projectSessionResolution";
import { acquireOptions } from "../project-sessions/projectSessionRuntime";

const UPDATE_BATCH_RETRY_MS = 60_000;

/**
 * Conversations with deferred updates that no input has carried yet: notification-mode
 * results (digest), passive notices (FYIs, routine Workboard posts) and never-admitted
 * reference reports. Reports already admitted once stay discoverable but do not rearm a timer.
 */
function pendingUpdateRecipients(document: SessionFamilyDocument): ReadonlySet<string> {
  const recipients = new Set<string>();
  for (const notice of document.passiveNotices ?? [])
    if (!notice.delivered) recipients.add(notice.recipientSessionId);
  for (const report of document.deferredReferences ?? [])
    if (!report.admissions) recipients.add(report.recipientSessionId);
  for (const item of document.coordinatorDigest ?? [])
    recipients.add(item.coordinatorSessionId ?? CAKE_CHAT_SESSION_ID);
  return recipients;
}

/**
 * Undelivered passive notices for one recipient. A notice whose earlier admission Pi already
 * recorded (including a canceled input) is settled instead of being carried again.
 */
export const takePassiveNotices = Effect.fn("UpdateBatches.takePassiveNotices")(function* (
  handle: CakeSessionHandle,
  sessionId: string,
) {
  const storage = yield* SessionFamilyStorage;
  const passive: StoredPassiveNotice[] = [];
  for (const notice of (yield* storage.state()).passiveNotices ?? []) {
    if (notice.recipientSessionId !== sessionId || notice.delivered) continue;
    const receipt =
      notice.admissionTurnId && handle.inputReceipt
        ? yield* handle.inputReceipt(notice.admissionTurnId)
        : undefined;
    if (receipt)
      yield* storage.markPassiveNoticeAdmission(
        [notice.id],
        notice.admissionTurnId ?? notice.id,
        true,
      );
    else passive.push(notice);
  }
  return passive;
});

/** Advisory cache facts, read the same way sessions.list reads them. Failure means unknown. */
const contextMetadata = Effect.fn("UpdateBatches.contextMetadata")(function* (sessionId: string) {
  if (isCakeChatSessionId(sessionId)) {
    const configuration = yield* Effect.serviceOption(CakeChatConfiguration);
    if (Option.isNone(configuration)) return undefined;
    return (yield* chatMetadata.catalog(configuration.value.location)).find(
      (chat) => chat.sessionId === sessionId,
    )?.contextMetadata;
  }
  const location = yield* findLocation({ sessionId });
  return (yield* (yield* CakeSessionRuntimes).inspect(
    {
      workingDirectory: location.workingDirectory,
      sessionDirectory: location.sessionDirectory,
      sessionId,
    },
    { includeParts: false },
  )).contextMetadata;
});

const cacheExpiry = (metadata: SessionContextMetadata | undefined, now: number) => {
  const context = sessionContextCost(metadata, now);
  return "estimatedExpiresAt" in context ? Date.parse(context.estimatedExpiresAt) : undefined;
};

/** Primary conversations only: global Cake Chat, Project Chats and Project Sessions. */
const acquireRecipient = Effect.fn("UpdateBatches.acquireRecipient")(function* (sessionId: string) {
  if (isCakeChatSessionId(sessionId)) return yield* chatTargets.acquireAvailable(sessionId);
  const location = yield* findLocation({ sessionId });
  return yield* (yield* CakeSessionRuntimes).acquire(
    yield* acquireOptions({ location, sessionId, newSession: false }),
  );
});

/** A batch turn was admitted: settle exactly the items it carried and cancel the timer. */
const settleAdmittedBatch = Effect.fn("UpdateBatches.settleAdmittedBatch")(function* (
  handle: CakeSessionHandle,
  batch: UpdateBatch & { readonly turnId: string },
) {
  const storage = yield* SessionFamilyStorage;
  const carried = ((yield* storage.state()).passiveNotices ?? []).filter(
    (notice) => notice.admissionTurnId === batch.turnId && !notice.delivered,
  );
  if (carried.length)
    yield* storage.markPassiveNoticeAdmission(
      carried.map((notice) => notice.id),
      batch.turnId,
      true,
    );
  // The digest reminder's receipts were journaled with the admitted input.
  const admitted = handle.admittedDigestIds ? yield* handle.admittedDigestIds() : [];
  if (admitted.length) yield* storage.removeDigest(admitted);
  yield* storage.closeUpdateBatch(batch.recipientSessionId);
});

const deliverBatch = Effect.fn("UpdateBatches.deliverBatch")(function* (
  recipientSessionId: string,
) {
  const storage = yield* SessionFamilyStorage;
  return yield* storage.withNoticeDelivery(
    Effect.gen(function* () {
      const batch = (yield* storage.state()).updateBatches?.find(
        (item) => item.recipientSessionId === recipientSessionId,
      );
      if (!batch) return;
      // An explicit stop or interrupted work awaiting review is not woken by deferred updates;
      // they ride along with the user's next message instead.
      const journal = yield* (yield* RuntimeRecoveryStorage).get(recipientSessionId);
      if (journal?.state === "stopped" || journal?.state === "blocked") return;
      const presence = yield* Effect.serviceOption(CakeChatComposerPresence);
      if (Option.isSome(presence) && (yield* presence.value.holdsInterrupts(recipientSessionId)))
        return;
      if (!isCakeChatSessionId(recipientSessionId)) {
        const location = yield* findLocation({ sessionId: recipientSessionId });
        const namespace = yield* resolutionNamespace(recipientSessionId, {
          cwd: location.workingDirectory,
          activeRoot: location.sessionDirectory,
          resolvedRoot: location.resolvedSessionDirectory,
        });
        if (namespace !== "active") return;
      }
      const handle = yield* acquireRecipient(recipientSessionId);
      if (batch.turnId) {
        const receipt = handle.inputReceipt ? yield* handle.inputReceipt(batch.turnId) : undefined;
        if (receipt) return yield* settleAdmittedBatch(handle, { ...batch, turnId: batch.turnId });
      }
      // Never steer or run beside active work; the batch waits and absorbs later items.
      if (
        (yield* handle.snapshot()).streaming ||
        (yield* handle.currentTurnIds()).length ||
        (yield* handle.pendingMessages()).items.length
      )
        return;
      const state = yield* storage.state();
      const references = (state.deferredReferences ?? []).filter(
        (item) => item.recipientSessionId === recipientSessionId,
      );
      const reportPage = pendingReportPage(references);
      const passive = yield* takePassiveNotices(handle, recipientSessionId);
      const digest = yield* cakeChatDigest.prepareUserMessage(handle, updateBatchReminder);
      if (
        !digest.digestIds.length &&
        !passive.length &&
        !references.some((item) => !item.admissions)
      )
        return yield* storage.closeUpdateBatch(recipientSessionId);
      const text = addReferenceNotifications(digest.text, reportPage, references.length);
      const turnId = crypto.randomUUID();
      // Record the attempt first so a restart reconciles this admission instead of resending.
      if (passive.length)
        yield* storage.markPassiveNoticeAdmission(
          passive.map((notice) => notice.id),
          turnId,
        );
      yield* storage.saveUpdateBatch({ ...batch, turnId });
      yield* handle.submit({
        turnId,
        delivery: "follow-up",
        text: passive.length ? `${text}\n\n${passiveNoticeContext(passive)}` : text,
        attachments: [],
        markdown: false,
        automaticTitle: false,
        internal: { _tag: "UpdateBatch", notices: passive },
      });
      if (passive.length)
        yield* storage.markPassiveNoticeAdmission(
          passive.map((notice) => notice.id),
          turnId,
          true,
        );
      if (digest.digestIds.length) yield* storage.removeDigest(digest.digestIds);
      // Admission is not user-facing handling; report obligations stay until acknowledged.
      if (reportPage.length)
        yield* storage.markReferenceAdmissions(reportPage.map((item) => item.id));
      yield* storage.closeUpdateBatch(recipientSessionId);
      yield* handle.publishSessionChanged();
    }),
  );
});

/**
 * One application-owned pass: open a timer for each conversation whose batch just received its
 * first item, cancel timers whose items were carried by a user message, and deliver due batches.
 * Timer records are durable, so a restart resumes the original deadline.
 */
export const runPass = Effect.fn("UpdateBatches.runPass")(function* () {
  const storage = yield* SessionFamilyStorage;
  const state = yield* storage.state();
  const pending = pendingUpdateRecipients(state);
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  for (const batch of state.updateBatches ?? [])
    if (!pending.has(batch.recipientSessionId) && !batch.turnId)
      yield* storage.closeUpdateBatch(batch.recipientSessionId);
  const recipients = new Set([
    ...pending,
    ...(state.updateBatches ?? []).flatMap((batch) =>
      batch.turnId ? [batch.recipientSessionId] : [],
    ),
  ]);
  for (const recipientSessionId of recipients) {
    const batch = state.updateBatches?.find(
      (item) => item.recipientSessionId === recipientSessionId,
    );
    if (!batch) {
      const metadata = yield* contextMetadata(recipientSessionId).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      yield* storage.saveUpdateBatch({
        recipientSessionId,
        openedAt: new Date(now).toISOString(),
        dueAt: new Date(updateBatchDueAt(now, cacheExpiry(metadata, now), now)).toISOString(),
      });
      continue;
    }
    if (now < Date.parse(batch.dueAt)) continue;
    yield* Effect.scoped(deliverBatch(recipientSessionId)).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Batched update delivery will retry", error);
          // Unavailable recipients retry each minute rather than every pass.
          const current = (yield* storage.state()).updateBatches?.find(
            (item) => item.recipientSessionId === recipientSessionId,
          );
          if (current)
            yield* storage.saveUpdateBatch({
              ...current,
              dueAt: new Date(now + UPDATE_BATCH_RETRY_MS).toISOString(),
            });
        }),
      ),
    );
  }
});
