import { isDirectProjectChatDelegation } from "../../contracts/worktrees/auto-merge-delegation";
import type { AutoMergeOutcome, AutoMergeRequest } from "../../contracts/worktrees/auto-merge";
import { ReadableMessageReference } from "../../contracts/conversations/message-reference";
import type { StoredPassiveNotice } from "../../contracts/conversations/passive-notice";
import {
  pendingReportRef,
  samePendingResponse,
  type PendingReport,
  type ReportHandlingReceipt,
} from "../../contracts/conversations/pending-report";
import type { BoardDelivery } from "../../contracts/artifacts/board-delivery";
import type {
  CompletionInboxItem,
  CompletionDecisionState,
} from "../../contracts/conversations/completion-inbox";
import type { ResultDelivery } from "../../contracts/conversations/result-delivery";
import type { TurnStop } from "../../contracts/conversations/turn-stop";
import {
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Semaphore,
  RcMap,
  Scope,
  Exit,
  Struct,
} from "effect";
import { atomicWriteFile, type AtomicFileStage } from "./internal/atomicFile";
import { timedStorageRead } from "./internal/timedStorageRead";
import type { SessionFamilyStorageError } from "../../contracts/storage/session-family-storage-errors";

import type {
  CakeChatLaunchReport,
  SessionCompletionReport,
} from "../../contracts/project-sessions/session-reporting";

import {
  type SessionFamily,
  type SessionFamilyChild,
  SessionFamilyDocument,
  familyMember,
  familyMemberIds,
  type FamilyTurn,
  type SpawnedSession,
  type CoordinatorDigestItem,
  type UpdateBatch,
} from "../../contracts/session-families/session-family-document";
import {
  DOCUMENT_VERSION,
  decodeSessionFamilyDocument,
  storageError,
  validateDocument,
} from "./sessionFamilyDocumentCodec";

export class SessionFamilyStorage extends Context.Service<
  SessionFamilyStorage,
  {
    readonly state: () => Effect.Effect<SessionFamilyDocument, SessionFamilyStorageError>;
    readonly authorizeAutoMerge: (
      runId: string,
      epoch: string,
      projectPath: string,
      projectChatId: string,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly recordAutoMerge: (
      request: AutoMergeRequest,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly updateAutoMerge: (
      id: string,
      state: AutoMergeRequest["state"],
      message?: string,
      outcome?: AutoMergeOutcome,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly invalidateAutoMerge: (
      workspacePath: string,
      id?: string,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly advanceBoardDelivery: (
      familyId: string,
      through: number,
      assignments: ReadonlyArray<{ readonly sessionId: string; readonly sequence: number }>,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly recordBoardDelivery: (
      delivery: BoardDelivery,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly updateBoardDelivery: (
      turnId: string,
      status: BoardDelivery["status"],
      issue?: string,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly setBoardDeliveryPaused: (
      sessionId: string,
      paused: boolean,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly recordCompletion: (
      item: CompletionInboxItem,
      digest?: CoordinatorDigestItem,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly updateCompletion: (
      sessionId: string,
      id: string,
      state: CompletionDecisionState,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    /** Serializes one create request through admission, independently of family turn admission. */
    readonly withCreationLock: <A, E, R>(
      key: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly withMemberLock: <A, E, R>(
      sessionId: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | SessionFamilyStorageError, R>;
    readonly recordTurn: (turn: FamilyTurn) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly registerSpawn: (
      session: SpawnedSession,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly recordReport: (
      turnId: string,
      report: SessionCompletionReport,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly settleTurn: (
      turnId: string,
      outcome: "complete" | "failed" | "aborted",
      report?: SessionCompletionReport,
      stop?: TurnStop,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly pendingResponseRequest: (
      sessionId: string,
      executingTurnIds: ReadonlyArray<string>,
      threadId?: string,
      requestMessageId?: string,
    ) => Effect.Effect<FamilyTurn | undefined, SessionFamilyStorageError>;
    readonly prepareResponse: (
      sessionId: string,
      targetSessionId: string,
      requestMessageId: string,
      responseMessageId: string,
      executingTurnIds: ReadonlyArray<string>,
    ) => Effect.Effect<boolean, SessionFamilyStorageError>;
    readonly confirmResponse: (
      responseMessageId: string,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly markNoticeAttempt: (
      turnId: string,
      deliveryTurnId: string,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly completeNotice: (turnId: string) => Effect.Effect<void, SessionFamilyStorageError>;
    /** Settles a Cake Chat obligation into the digest inbox instead of starting a turn. */
    readonly digestNotice: (
      turnId: string,
      item: CoordinatorDigestItem,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    /** Atomically retains an exact notification and settles its optional report obligation. */
    readonly deferPassiveNotice: (
      item: StoredPassiveNotice,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly markPassiveNoticeAdmission: (
      ids: ReadonlyArray<string>,
      turnId: string,
      delivered?: boolean,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly deferReferenceNotice: (
      item: PendingReport,
      turnIds?: ReadonlyArray<string>,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly releaseAttentionReports: (
      recipientSessionId: string,
      todoId: string,
      ids: readonly string[],
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly markReferenceAdmissions: (
      ids: ReadonlyArray<string>,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly acknowledgeReports: (
      receipts: ReadonlyArray<ReportHandlingReceipt>,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly recordLaunchReport: (
      sessionId: string,
      report: CakeChatLaunchReport,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    /** Opens or replaces the recipient's batch timer record. */
    readonly saveUpdateBatch: (
      batch: UpdateBatch,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    /** Cancels the recipient's batch timer after its items were delivered. */
    readonly closeUpdateBatch: (
      recipientSessionId: string,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    /** Drops everything still waiting for a resolved conversation, including its batch timer. */
    readonly discardUpdates: (
      recipientSessionId: string,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    /** Removes digest items once they were attached to an accepted Cake Chat message. */
    readonly removeDigest: (
      ids: ReadonlyArray<string>,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly markNoticeFailure: (
      turnId: string,
      message: string,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly retryNoticeDelivery: (
      recipientSessionId: string,
      turnId: string,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    /** Serializes retry admission with explicit queue withdrawal, not model execution. */
    readonly withNoticeDelivery: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly withdrawNotices: (
      recipientSessionId: string,
      messageIds: ReadonlyArray<string>,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly removeUnmaterializedChild: (
      sessionId: string,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly removeProject: (projectPath: string) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly list: () => Effect.Effect<ReadonlyArray<SessionFamily>, SessionFamilyStorageError>;
    readonly familyForMember: (
      sessionId: string,
    ) => Effect.Effect<SessionFamily | undefined, SessionFamilyStorageError>;
    readonly addChild: (input: {
      readonly familyId: string;
      readonly parentSessionId: string;
      readonly parentWorkingDirectory: string;
      readonly parentManagedWorktreePath?: string;
      readonly childSessionId: string;
      readonly assignmentTopic?: string;
      readonly childWorkingDirectory: string;
      readonly resultDelivery?: ResultDelivery;
      readonly childManagedWorktreePath?: string;
      readonly requestId: string;
      readonly projectPath: string;
      readonly createdAt: string;
    }) => Effect.Effect<SessionFamily, SessionFamilyStorageError>;
  }
>()("cake/services/storage/SessionFamilyStorage") {}

/** The initial assignment's obligation is the spawned session's one handoff to Cake Chat. */
const settleHandoffs = (
  spawnedSessions: ReadonlyArray<SpawnedSession>,
  turns: ReadonlyArray<FamilyTurn>,
  reportDelivered: (turn: FamilyTurn) => boolean,
): ReadonlyArray<SpawnedSession> =>
  spawnedSessions.map((spawn) => {
    const initial = turns.find(
      (turn) => turn.sessionId === spawn.sessionId && turn.requestMessageId === spawn.sessionId,
    );
    return initial
      ? { ...spawn, handoffSettled: true, reportDelivered: reportDelivered(initial) }
      : spawn;
  });

export const makeSessionFamilyStorageLive = (documentPath: string) =>
  Layer.effect(
    SessionFamilyStorage,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lock = yield* Semaphore.make(1);
      const noticeDeliveryLock = yield* Semaphore.make(1);

      // Pending delivery and other workflows share this document. Decode it again
      // only after the file changes; every atomic rewrite replaces the file's identity.
      let decoded:
        | { readonly version: string; readonly document: SessionFamilyDocument }
        | undefined;
      const loadUnlocked = Effect.fn("SessionFamilyStorage.loadUnlocked")(function* () {
        if (
          !(yield* fileSystem
            .exists(documentPath)
            .pipe(Effect.mapError((e) => storageError("load", e))))
        )
          return { families: [], turns: [], spawnedSessions: [] } satisfies SessionFamilyDocument;
        const info = yield* fileSystem
          .stat(documentPath)
          .pipe(Effect.mapError((e) => storageError("load", e)));
        const version = [
          Option.getOrUndefined(info.ino),
          info.size,
          Option.getOrUndefined(info.mtime)?.getTime(),
        ].join(":");
        if (decoded?.version === version) return decoded.document;
        const text = yield* fileSystem
          .readFileString(documentPath)
          .pipe(Effect.mapError((e) => storageError("load", e)));
        const document = yield* decodeSessionFamilyDocument(text);
        decoded = { version, document };
        return document;
      });

      const writeError = (stage: AtomicFileStage, cause: unknown) =>
        storageError(`save:${stage}`, cause);
      const saveUnlocked = Effect.fn("SessionFamilyStorage.saveUnlocked")(function* (
        document: SessionFamilyDocument,
      ) {
        const validated = yield* Effect.try({
          try: () => validateDocument(document),
          catch: (cause) => storageError("save", cause),
        });
        const data = yield* Schema.encodeEffect(SessionFamilyDocument)(validated).pipe(
          Effect.mapError((cause) => storageError("save", cause)),
        );
        decoded = undefined;
        yield* atomicWriteFile(
          fileSystem,
          path,
          documentPath,
          `${JSON.stringify({ version: DOCUMENT_VERSION, data }, null, 2)}\n`,
          writeError,
        );
      });

      const list = Effect.fn("SessionFamilyStorage.list")(() =>
        lock
          .withPermits(1)(loadUnlocked())
          .pipe(Effect.map((document) => document.families)),
      );
      const familyForMember = Effect.fn("SessionFamilyStorage.familyForMember")(
        (sessionId: string) =>
          list().pipe(
            Effect.map((families) =>
              families.find(
                (family) =>
                  family.parentSessionId === sessionId ||
                  family.children.some((child) => child.sessionId === sessionId),
              ),
            ),
          ),
      );
      const addChild = Effect.fn("SessionFamilyStorage.addChild")(function* (
        input: Parameters<SessionFamilyStorage["Service"]["addChild"]>[0],
      ) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const document = yield* loadUnlocked();
            const retried = document.families.find((family) =>
              family.children.some((child) => child.requestId === input.requestId),
            );
            if (retried) return retried;
            const childOwner = document.families.find(
              (family) => familyMember(family, input.parentSessionId) !== undefined,
            );
            const conflictingMember = document.families.some(
              (family) =>
                family.parentSessionId === input.childSessionId ||
                family.children.some((child) => child.sessionId === input.childSessionId),
            );
            if (conflictingMember)
              return yield* storageError(
                "addChild",
                `Session ${input.childSessionId} already belongs to a family`,
              );
            if (childOwner && childOwner.projectPath !== input.projectPath)
              return yield* storageError(
                "addChild",
                "Session Family Project binding cannot change",
              );
            const parent = childOwner && familyMember(childOwner, input.parentSessionId);
            if (
              parent &&
              (parent.workingDirectory !== input.parentWorkingDirectory ||
                parent.managedWorktreePath !== input.parentManagedWorktreePath)
            )
              return yield* storageError(
                "addChild",
                "Session Family parent Working Directory binding cannot change",
              );
            const child: SessionFamilyChild = {
              sessionId: input.childSessionId,
              parentSessionId: input.parentSessionId,
              requestId: input.requestId,
              workingDirectory: input.childWorkingDirectory,
              resultDelivery: input.resultDelivery ?? "notification",
              ...(input.assignmentTopic ? { assignmentTopic: input.assignmentTopic } : null),
              createdAt: input.createdAt,
            };
            if (input.childManagedWorktreePath !== undefined)
              Object.assign(child, { managedWorktreePath: input.childManagedWorktreePath });
            let family: SessionFamily;
            if (childOwner) family = { ...childOwner, children: [...childOwner.children, child] };
            else {
              family = {
                familyId: input.familyId,
                parentSessionId: input.parentSessionId,
                projectPath: input.projectPath,
                workingDirectory: input.parentWorkingDirectory,
                createdAt: input.createdAt,
                children: [child],
              };
              if (input.parentManagedWorktreePath !== undefined)
                Object.assign(family, { managedWorktreePath: input.parentManagedWorktreePath });
            }
            const families = childOwner
              ? document.families.map((candidate) =>
                  candidate.familyId === childOwner.familyId ? family : candidate,
                )
              : [...document.families, family];
            yield* saveUnlocked({ ...document, families });
            return family;
          }),
        );
      });

      const state = Effect.fn("SessionFamilyStorage.state")(() =>
        timedStorageRead("SessionFamilyStorage.state", lock, loadUnlocked()),
      );
      const memberLocks = yield* RcMap.make({
        lookup: (parentSessionId: string) =>
          Semaphore.make(1).pipe(
            Effect.withSpan("SessionFamilyStorage.lock", { attributes: { parentSessionId } }),
          ),
      });
      const withKeyLock: SessionFamilyStorage["Service"]["withCreationLock"] = (key, effect) =>
        Effect.acquireUseRelease(
          Scope.make(),
          (leaseScope) =>
            Effect.gen(function* () {
              const memberLock = yield* RcMap.get(memberLocks, key).pipe(
                Effect.provideService(Scope.Scope, leaseScope),
              );
              return yield* memberLock.withPermits(1)(effect);
            }),
          (leaseScope) => Scope.close(leaseScope, Exit.void),
        );
      const withMemberLock: SessionFamilyStorage["Service"]["withMemberLock"] = (
        sessionId,
        effect,
      ) =>
        Effect.gen(function* () {
          const family = yield* familyForMember(sessionId);
          return yield* withKeyLock(family?.parentSessionId ?? sessionId, effect);
        });
      const update = Effect.fn("SessionFamilyStorage.update")(
        (change: (document: SessionFamilyDocument) => SessionFamilyDocument) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const document = yield* loadUnlocked();
              const changed = change(document);
              if (changed !== document) yield* saveUnlocked(changed);
            }),
          ),
      );
      const advanceBoardDelivery = Effect.fn("SessionFamilyStorage.advanceBoardDelivery")(
        (
          familyId: string,
          through: number,
          assignments: ReadonlyArray<{ readonly sessionId: string; readonly sequence: number }>,
        ) =>
          update((document) => {
            const family = document.families.find((item) => item.familyId === familyId);
            if (!family) return document;
            const children = family.children.map((child) => {
              const assignment = assignments.find((item) => item.sessionId === child.sessionId);
              return assignment && child.assignmentSequence === undefined
                ? { ...child, assignmentSequence: assignment.sequence }
                : child;
            });
            if (
              through <= (family.boardDeliveryThrough ?? 0) &&
              children.every((child, i) => child === family.children[i])
            )
              return document;
            return {
              ...document,
              families: document.families.map((item) =>
                item === family
                  ? {
                      ...item,
                      children,
                      boardDeliveryThrough: Math.max(through, family.boardDeliveryThrough ?? 0),
                    }
                  : item,
              ),
            };
          }),
      );
      const recordBoardDelivery = Effect.fn("SessionFamilyStorage.recordBoardDelivery")(
        (delivery: BoardDelivery) =>
          update((document) =>
            document.boardDeliveries?.some((item) => item.turnId === delivery.turnId)
              ? document
              : {
                  ...document,
                  boardDeliveries: [
                    ...(document.boardDeliveries ?? []),
                    document.boardDeliveryPaused?.includes(delivery.recipientSessionId)
                      ? {
                          ...delivery,
                          status: "canceled" as const,
                          issue: "Session explicitly stopped; this board batch will not restart it",
                        }
                      : delivery,
                  ],
                },
          ),
      );
      const updateBoardDelivery = Effect.fn("SessionFamilyStorage.updateBoardDelivery")(
        (turnId: string, status: BoardDelivery["status"], issue?: string) =>
          update((document) => ({
            ...document,
            passiveNotices:
              status === "canceled"
                ? (document.passiveNotices ?? []).map((notice) =>
                    notice.id === turnId ? { ...notice, delivered: true, text: "" } : notice,
                  )
                : (document.passiveNotices ?? []),
            boardDeliveries: (document.boardDeliveries ?? []).map((item) => {
              if (
                item.turnId !== turnId ||
                !["pending", "admitted", "deferred"].includes(item.status)
              )
                return item;
              return {
                ...Struct.omit(item, ["issue"]),
                status,
                ...(issue ? { issue: issue.slice(0, 2000) } : null),
              };
            }),
          })),
      );
      const setBoardDeliveryPaused = Effect.fn("SessionFamilyStorage.setBoardDeliveryPaused")(
        (sessionId: string, paused: boolean) =>
          update((document) => ({
            ...document,
            passiveNotices: (document.passiveNotices ?? []).map((notice) =>
              paused &&
              document.boardDeliveries?.some(
                (delivery) =>
                  delivery.turnId === notice.id &&
                  delivery.recipientSessionId === sessionId &&
                  ["pending", "deferred"].includes(delivery.status),
              )
                ? { ...notice, delivered: true, text: "" }
                : notice,
            ),
            boardDeliveryPaused: paused
              ? [...new Set([...(document.boardDeliveryPaused ?? []), sessionId])]
              : (document.boardDeliveryPaused ?? []).filter((id) => id !== sessionId),
            boardDeliveries: (document.boardDeliveries ?? []).map((item) =>
              paused &&
              item.recipientSessionId === sessionId &&
              ["pending", "deferred"].includes(item.status)
                ? {
                    ...item,
                    status: "canceled" as const,
                    issue: "Session stopped or failed before board delivery admission",
                  }
                : item,
            ),
          })),
      );
      const authorizeAutoMerge = Effect.fn("SessionFamilyStorage.authorizeAutoMerge")(
        (runId: string, epoch: string, projectPath: string, projectChatId: string) =>
          update((document) => ({
            ...document,
            autoMergeRequests: (document.autoMergeRequests ?? []).map((item) => {
              if (
                !item.readyToMerge ||
                item.runId !== runId ||
                item.projectPath !== projectPath ||
                !isDirectProjectChatDelegation(document.spawnedSessions, item, projectChatId) ||
                item.state === "landing" ||
                item.state === "landed"
              )
                return item;
              const next = { ...Struct.omit(item, ["outcome"]), epoch };
              if (item.state === "failed" || item.state === "canceled")
                Object.assign(next, { state: "ready", attempt: (item.attempt ?? 0) + 1 });
              return next;
            }),
          })),
      );
      const recordAutoMerge = Effect.fn("SessionFamilyStorage.recordAutoMerge")(
        (request: AutoMergeRequest) =>
          update((document) =>
            (document.autoMergeRequests ?? []).some((item) => item.id === request.id)
              ? document
              : {
                  ...document,
                  autoMergeRequests: [...(document.autoMergeRequests ?? []), request],
                },
          ),
      );
      const updateAutoMerge = Effect.fn("SessionFamilyStorage.updateAutoMerge")(function* (
        id: string,
        state: AutoMergeRequest["state"],
        message?: string,
        outcome?: AutoMergeOutcome,
      ) {
        const reportedAt = DateTime.formatIso(yield* DateTime.now);
        yield* update((document) => {
          const request = document.autoMergeRequests?.find((item) => item.id === id);
          if (
            !request ||
            (request.state === state &&
              request.message === message &&
              (!outcome || request.outcome))
          )
            return document;
          const changed = { ...Struct.omit(request, ["message"]), state };
          if (message) Object.assign(changed, { message });
          if (outcome) Object.assign(changed, { outcome });
          const next = {
            ...document,
            autoMergeRequests: document.autoMergeRequests?.map((item) =>
              item.id === id ? changed : item,
            ),
          };
          // Persist the backend result and its outbox atomically. The original report is
          // untouched; this single quiet system reminder survives source-session resolution.
          if (outcome && !request.outcome && request.coordinatorSessionId) {
            const digest = document.coordinatorDigest ?? [];
            const digestId = `auto-merge:${id}${request.attempt ? `:${request.attempt}` : ""}`;
            if (!digest.some((item) => item.id === digestId))
              next.coordinatorDigest = [
                ...digest,
                {
                  id: digestId,
                  coordinatorSessionId: request.coordinatorSessionId,
                  sessionId: request.sessionId,
                  title:
                    document.spawnedSessions.find((item) => item.sessionId === request.sessionId)
                      ?.title ?? `Session ${request.sessionId}`,
                  status: outcome.resolutionSucceeded ? "completed" : "blocked",
                  summary: `Auto-merge backend outcome: merged=${outcome.merged}; resolutionSucceeded=${outcome.resolutionSucceeded}; targetBranch=${outcome.targetBranch}; landedCommit=${outcome.landedCommit ?? "none"}. ${outcome.message.slice(0, 500)}`,
                  reportedAt,
                  userInputOnly: true,
                },
              ];
          }
          return next;
        });
      });
      const invalidateAutoMerge = Effect.fn("SessionFamilyStorage.invalidateAutoMerge")(
        (workspacePath: string, id?: string) =>
          update((document) =>
            !(document.autoMergeRequests ?? []).some(
              (item) =>
                item.workspacePath === workspacePath &&
                (!id || item.id === id) &&
                item.readyToMerge &&
                item.state !== "landed",
            )
              ? document
              : {
                  ...document,
                  autoMergeRequests: document.autoMergeRequests?.map((item) =>
                    item.workspacePath === workspacePath &&
                    (!id || item.id === id) &&
                    item.readyToMerge &&
                    item.state !== "landed"
                      ? {
                          ...item,
                          readyToMerge: false,
                          state: "canceled" as const,
                          message: "New input invalidated merge readiness",
                        }
                      : item,
                  ),
                },
          ),
      );
      const recordCompletion = Effect.fn("SessionFamilyStorage.recordCompletion")(
        (item: CompletionInboxItem, digest?: CoordinatorDigestItem) =>
          update((document) => {
            const inbox = document.completionInbox ?? [];
            const existing = inbox.find((entry) => entry.id === item.id);
            if (existing) {
              // Repair a crash/older summary-only record before settling its source.
              if (
                existing.resultMessageRef ||
                existing.resultText ||
                (!item.resultMessageRef && !item.resultText)
              )
                return document;
              return {
                ...document,
                completionInbox: inbox.map((entry) =>
                  entry.id === item.id
                    ? {
                        ...entry,
                        ...(item.resultMessageRef
                          ? { resultMessageRef: item.resultMessageRef }
                          : { resultText: item.resultText }),
                      }
                    : entry,
                ),
              };
            }
            return {
              ...document,
              completionInbox: [...inbox, item],
              coordinatorDigest:
                !digest || document.coordinatorDigest?.some((existing) => existing.id === item.id)
                  ? (document.coordinatorDigest ?? [])
                  : [...(document.coordinatorDigest ?? []), digest],
            };
          }),
      );
      const updateCompletion = Effect.fn("SessionFamilyStorage.updateCompletion")(
        (sessionId: string, id: string, state: CompletionDecisionState) =>
          update((document) => ({
            ...document,
            completionInbox: (document.completionInbox ?? []).map((item) =>
              item.id === id && item.coordinatorSessionId === sessionId ? { ...item, state } : item,
            ),
            coordinatorDigest:
              state === "pending"
                ? document.coordinatorDigest
                : document.coordinatorDigest?.filter(
                    (item) => item.id !== id || item.coordinatorSessionId !== sessionId,
                  ),
          })),
      );
      const recordTurn = Effect.fn("SessionFamilyStorage.recordTurn")((turn: FamilyTurn) =>
        update((document) => ({
          ...document,
          turns: document.turns.some((item) => item.turnId === turn.turnId)
            ? document.turns
            : [...document.turns, turn],
        })),
      );
      const registerSpawn = Effect.fn("SessionFamilyStorage.registerSpawn")(
        (session: SpawnedSession) =>
          update((document) => ({
            ...document,
            spawnedSessions: document.spawnedSessions.some(
              (item) => item.sessionId === session.sessionId,
            )
              ? document.spawnedSessions
              : [...document.spawnedSessions, session],
          })),
      );
      const recordReport = Effect.fn("SessionFamilyStorage.recordReport")(
        (turnId: string, report: SessionCompletionReport) =>
          update((document) => ({
            ...document,
            turns: document.turns.map((turn) =>
              turn.turnId === turnId && !turn.reported && !turn.report && turn.outcome === undefined
                ? { ...turn, report }
                : turn,
            ),
          })),
      );
      const settleTurn = Effect.fn("SessionFamilyStorage.settleTurn")(
        (
          turnId: string,
          outcome: "complete" | "failed" | "aborted",
          report?: SessionCompletionReport,
          stop?: TurnStop,
        ) =>
          update((document) => ({
            ...document,
            turns: document.turns.flatMap((turn) =>
              turn.turnId !== turnId || turn.outcome !== undefined
                ? [turn]
                : turn.reported
                  ? []
                  : [
                      {
                        ...turn,
                        outcome,
                        ...(report || turn.report
                          ? {
                              report: {
                                ...(outcome === "failed"
                                  ? (report ?? turn.report!)
                                  : (turn.report ?? report!)),
                                ...(report?.resultMessageRef &&
                                (outcome === "failed" || !turn.report?.resultMessageRef)
                                  ? { resultMessageRef: report.resultMessageRef }
                                  : null),
                              },
                            }
                          : null),
                        ...(stop && outcome === "aborted" ? { stop } : null),
                      },
                    ],
            ),
          })),
      );
      const pendingResponseRequest = Effect.fn("SessionFamilyStorage.pendingResponseRequest")((
        sessionId: string,
        executingTurnIds: ReadonlyArray<string>,
        threadId?: string,
        requestMessageId?: string,
      ) => {
        const executing = new Set(executingTurnIds);
        const explicitlyCorrelated = threadId !== undefined || requestMessageId !== undefined;
        return state().pipe(
          Effect.map((document) =>
            [...document.turns]
              .reverse()
              .find(
                (turn) =>
                  turn.sessionId === sessionId &&
                  !turn.reported &&
                  (executing.has(turn.turnId) ||
                    (explicitlyCorrelated && turn.outcome !== undefined)) &&
                  (threadId === undefined || turn.threadId === threadId) &&
                  (requestMessageId === undefined || turn.requestMessageId === requestMessageId),
              ),
          ),
        );
      });
      const prepareResponse = Effect.fn("SessionFamilyStorage.prepareResponse")(function* (
        sessionId: string,
        targetSessionId: string,
        requestMessageId: string,
        responseMessageId: string,
        executingTurnIds: ReadonlyArray<string>,
      ) {
        let matched = false;
        const executing = new Set(executingTurnIds);
        yield* update((document) => {
          const requestedTurn = document.turns.find(
            (turn) =>
              turn.sessionId === sessionId &&
              turn.senderSessionId === targetSessionId &&
              turn.requestMessageId === requestMessageId &&
              !turn.reported,
          );
          if (!requestedTurn) return document;
          matched = true;
          // One model response covers all requests from this sender that Pi consumed into
          // the same run. Keep queued requests and requests from other family members open.
          const coversExecutingInputs = executing.has(requestedTurn.turnId);
          return {
            ...document,
            turns: document.turns.map((turn) => {
              const isRequestedTurn = turn === requestedTurn;
              const isCoveredExecutingInput =
                coversExecutingInputs &&
                turn.sessionId === sessionId &&
                turn.senderSessionId === targetSessionId &&
                !turn.reported &&
                executing.has(turn.turnId);
              if (!isRequestedTurn && !isCoveredExecutingInput) return turn;
              return {
                ...turn,
                replyMessageIds: [...(turn.replyMessageIds ?? []), responseMessageId],
              };
            }),
          };
        });
        return matched;
      });
      const confirmResponse = Effect.fn("SessionFamilyStorage.confirmResponse")(
        (responseMessageId: string) =>
          update((document) => {
            const answered = document.turns.filter((turn) =>
              turn.replyMessageIds?.includes(responseMessageId),
            );
            return {
              ...document,
              turns: document.turns.flatMap((turn) =>
                answered.includes(turn)
                  ? turn.outcome
                    ? []
                    : [{ ...turn, reported: true }]
                  : [turn],
              ),
              spawnedSessions: settleHandoffs(document.spawnedSessions, answered, () => true),
            };
          }),
      );
      const markNoticeAttempt = Effect.fn("SessionFamilyStorage.markNoticeAttempt")(
        (turnId: string, deliveryTurnId: string) =>
          update((document) => ({
            ...document,
            turns: document.turns.map((turn) =>
              turn.turnId === turnId ? { ...turn, deliveryTurnId } : turn,
            ),
          })),
      );
      const markNoticeFailure = Effect.fn("SessionFamilyStorage.markNoticeFailure")(
        (turnId: string, message: string) =>
          update((document) => ({
            ...document,
            turns: document.turns.map((turn) =>
              turn.turnId === turnId && !turn.reported
                ? {
                    ...turn,
                    deliveryError: message.slice(0, 2000),
                    deliveryFailureCount: (turn.deliveryFailureCount ?? 0) + 1,
                  }
                : turn,
            ),
          })),
      );
      const retryNoticeDelivery = Effect.fn("SessionFamilyStorage.retryNoticeDelivery")(
        (recipientSessionId: string, turnId: string) =>
          update((document) => ({
            ...document,
            turns: document.turns.map((turn) => {
              if (turn.turnId !== turnId || turn.senderSessionId !== recipientSessionId)
                return turn;
              const { deliveryError: _error, deliveryFailureCount: _failures, ...rest } = turn;
              return rest;
            }),
          })),
      );
      const withoutNotice = (
        document: SessionFamilyDocument,
        turnId: string,
      ): SessionFamilyDocument => ({
        ...document,
        turns: document.turns.filter((turn) => turn.turnId !== turnId),
        spawnedSessions: settleHandoffs(
          document.spawnedSessions,
          document.turns.filter((turn) => turn.turnId === turnId && turn.outcome !== undefined),
          (turn) =>
            Boolean(
              turn.report &&
              (turn.outcome === "complete" ||
                (turn.outcome === "failed" && turn.report.outcome === "failed")),
            ),
        ),
      });
      const withLaunchReport = (
        spawnedSessions: SessionFamilyDocument["spawnedSessions"],
        sessionId: string,
        report: CakeChatLaunchReport,
      ) =>
        spawnedSessions.map((spawn) =>
          spawn.sessionId === sessionId ? { ...spawn, lastReport: report } : spawn,
        );
      const completeNotice = Effect.fn("SessionFamilyStorage.completeNotice")((turnId: string) =>
        update((document) => withoutNotice(document, turnId)),
      );
      const digestNotice = Effect.fn("SessionFamilyStorage.digestNotice")(
        (turnId: string, item: CoordinatorDigestItem) =>
          update((document) => {
            if (!document.turns.some((turn) => turn.turnId === turnId && !turn.reported))
              return document;
            const settled = withoutNotice(document, turnId);
            const digest = document.coordinatorDigest ?? [];
            return {
              ...settled,
              spawnedSessions: withLaunchReport(settled.spawnedSessions, item.sessionId, {
                status: item.status,
                summary: item.summary,
                reportedAt: item.reportedAt,
              }),
              // A retained completion proves this notification was already enqueued, even if a user
              // consumed it before a crash/retry settled the original obligation.
              coordinatorDigest:
                digest.some((existing) => existing.id === item.id) ||
                document.completionInbox?.some((existing) => existing.id === item.id)
                  ? digest
                  : [...digest, item],
            };
          }),
      );
      const deferPassiveNotice = Effect.fn("SessionFamilyStorage.deferPassiveNotice")(
        (item: StoredPassiveNotice) =>
          update((document) => ({
            ...document,
            passiveNotices: document.passiveNotices?.some((notice) => notice.id === item.id)
              ? document.passiveNotices
              : [...(document.passiveNotices ?? []), item],
          })),
      );
      const markPassiveNoticeAdmission = Effect.fn(
        "SessionFamilyStorage.markPassiveNoticeAdmission",
      )((ids: ReadonlyArray<string>, turnId: string, delivered = false) =>
        update((document) => ({
          ...document,
          passiveNotices: (document.passiveNotices ?? []).map((notice) =>
            ids.includes(notice.id)
              ? {
                  ...notice,
                  admissionTurnId: turnId,
                  delivered,
                  ...(delivered ? { text: "" } : null),
                }
              : notice,
          ),
        })),
      );
      const deferReferenceNotice = Effect.fn("SessionFamilyStorage.deferReferenceNotice")(
        (item: PendingReport, turnIds: ReadonlyArray<string> = []) =>
          update((document) => {
            if (
              turnIds.length &&
              !document.turns.some((turn) => turnIds.includes(turn.turnId) && !turn.reported) &&
              !document.deferredReferences?.some((notice) => samePendingResponse(notice, item))
            )
              return document;
            if (
              document.handledReports?.some(
                (receipt) =>
                  receipt.recipientSessionId === item.recipientSessionId &&
                  (receipt.id === item.id ||
                    Boolean(item.responseKey && receipt.responseKey === item.responseKey)),
              )
            )
              return turnIds.reduce(withoutNotice, document);
            const candidate = pendingReportRef(item);
            const ref =
              candidate && Schema.is(ReadableMessageReference)(candidate) ? candidate : undefined;
            const retained = { ...item, ...(ref ? { resultMessageRef: ref } : null) };
            const notices = document.deferredReferences ?? [];
            const existing = notices.find((notice) => samePendingResponse(notice, retained));
            return {
              ...turnIds.reduce(withoutNotice, document),
              deferredReferences: existing
                ? notices.map((notice) =>
                    notice !== existing
                      ? notice
                      : {
                          ...notice,
                          // Upgrade in place without reviving attention or replaying an admission.
                          ...(!Schema.is(ReadableMessageReference)(pendingReportRef(notice)) && ref
                            ? {
                                text: retained.text,
                                resultMessageRef: ref,
                                ...(retained.source ? { source: retained.source } : null),
                              }
                            : null),
                          ...(retained.responseKey ? { responseKey: retained.responseKey } : null),
                        },
                  )
                : [...notices, retained],
            };
          }),
      );
      const releaseAttentionReports = Effect.fn("SessionFamilyStorage.releaseAttentionReports")(
        (recipientSessionId: string, todoId: string, ids: readonly string[]) =>
          update((document) => ({
            ...document,
            deferredReferences: document.deferredReferences?.map((item) => {
              if (
                item.recipientSessionId !== recipientSessionId ||
                item.attentionTodoId !== todoId ||
                !ids.includes(item.id)
              )
                return item;
              const { attentionTodoId: _todoId, ...released } = item;
              return released;
            }),
          })),
      );
      const markReferenceAdmissions = Effect.fn("SessionFamilyStorage.markReferenceAdmissions")(
        (ids: ReadonlyArray<string>) =>
          update((document) => ({
            ...document,
            deferredReferences: document.deferredReferences?.map((item) =>
              ids.includes(item.id) ? { ...item, admissions: (item.admissions ?? 0) + 1 } : item,
            ),
          })),
      );
      const acknowledgeReports = Effect.fn("SessionFamilyStorage.acknowledgeReports")(
        (receipts: ReadonlyArray<ReportHandlingReceipt>) =>
          update((document) => {
            const matches = (item: { id: string; recipientSessionId: string }) =>
              receipts.some(
                (receipt) =>
                  receipt.id === item.id && receipt.recipientSessionId === item.recipientSessionId,
              );
            const handled = document.handledReports ?? [];
            return {
              ...document,
              deferredReferences: document.deferredReferences?.filter((item) => !matches(item)),
              handledReports: [
                ...handled,
                ...receipts
                  .map((receipt) => {
                    const pending = document.deferredReferences?.find(
                      (item) =>
                        item.recipientSessionId === receipt.recipientSessionId &&
                        item.id === receipt.id,
                    );
                    return {
                      ...receipt,
                      ...(pending?.responseKey ? { responseKey: pending.responseKey } : null),
                    };
                  })
                  .filter(
                    (receipt) =>
                      !handled.some(
                        (item) =>
                          item.id === receipt.id &&
                          item.recipientSessionId === receipt.recipientSessionId,
                      ),
                  ),
              ],
            };
          }),
      );
      const recordLaunchReport = Effect.fn("SessionFamilyStorage.recordLaunchReport")(
        (sessionId: string, report: CakeChatLaunchReport) =>
          update((document) => ({
            ...document,
            spawnedSessions: withLaunchReport(document.spawnedSessions, sessionId, report),
          })),
      );
      const removeDigest = Effect.fn("SessionFamilyStorage.removeDigest")(
        (ids: ReadonlyArray<string>) =>
          update((document) =>
            document.coordinatorDigest === undefined
              ? document
              : {
                  ...document,
                  coordinatorDigest: document.coordinatorDigest.filter(
                    (item) => !ids.includes(item.id),
                  ),
                },
          ),
      );
      const saveUpdateBatch = Effect.fn("SessionFamilyStorage.saveUpdateBatch")(
        (batch: UpdateBatch) =>
          update((document) => ({
            ...document,
            updateBatches: [
              ...(document.updateBatches ?? []).filter(
                (item) => item.recipientSessionId !== batch.recipientSessionId,
              ),
              batch,
            ],
          })),
      );
      const closeUpdateBatch = Effect.fn("SessionFamilyStorage.closeUpdateBatch")(
        (recipientSessionId: string) =>
          update((document) =>
            document.updateBatches?.some((item) => item.recipientSessionId === recipientSessionId)
              ? {
                  ...document,
                  updateBatches: document.updateBatches.filter(
                    (item) => item.recipientSessionId !== recipientSessionId,
                  ),
                }
              : document,
          ),
      );
      const discardUpdates = Effect.fn("SessionFamilyStorage.discardUpdates")(
        (recipientSessionId: string) =>
          update((document) => ({
            ...document,
            ...(document.passiveNotices && {
              passiveNotices: document.passiveNotices.filter(
                (notice) => notice.delivered || notice.recipientSessionId !== recipientSessionId,
              ),
            }),
            ...(document.deferredReferences && {
              deferredReferences: document.deferredReferences.filter(
                (item) => item.recipientSessionId !== recipientSessionId,
              ),
            }),
            ...(document.coordinatorDigest && {
              coordinatorDigest: document.coordinatorDigest.filter(
                (item) => item.coordinatorSessionId !== recipientSessionId,
              ),
            }),
            ...(document.updateBatches && {
              updateBatches: document.updateBatches.filter(
                (item) => item.recipientSessionId !== recipientSessionId,
              ),
            }),
          })),
      );
      const withdrawNotices = Effect.fn("SessionFamilyStorage.withdrawNotices")(
        (recipientSessionId: string, messageIds: ReadonlyArray<string>) =>
          update((document) => {
            const withdrawn = document.turns.filter(
              (turn) =>
                turn.senderSessionId === recipientSessionId &&
                ((turn.deliveryTurnId !== undefined && messageIds.includes(turn.deliveryTurnId)) ||
                  turn.replyMessageIds?.some((id) => messageIds.includes(id))),
            );
            return {
              ...document,
              turns: document.turns.flatMap((turn) =>
                !withdrawn.includes(turn)
                  ? [turn]
                  : turn.outcome
                    ? []
                    : [{ ...turn, reported: true }],
              ),
              spawnedSessions: settleHandoffs(document.spawnedSessions, withdrawn, () => false),
            };
          }),
      );
      const removeUnmaterializedChild = Effect.fn("SessionFamilyStorage.removeUnmaterializedChild")(
        (sessionId: string) =>
          update((document) => ({
            ...document,
            families: document.families.map((family) => ({
              ...family,
              children: family.children.filter((child) => child.sessionId !== sessionId),
            })),
          })),
      );
      const removeProject = Effect.fn("SessionFamilyStorage.removeProject")((projectPath: string) =>
        update((document) => {
          const removedFamilies = document.families.filter(
            (family) => family.projectPath === projectPath,
          );
          const removedMembers = new Set(removedFamilies.flatMap(familyMemberIds));
          for (const spawn of document.spawnedSessions)
            if (spawn.projectPath === projectPath) removedMembers.add(spawn.sessionId);
          return {
            ...(document.coordinatorDigest
              ? {
                  coordinatorDigest: document.coordinatorDigest.filter(
                    (item) => !removedMembers.has(item.sessionId),
                  ),
                }
              : null),
            ...(document.deferredReferences
              ? {
                  deferredReferences: document.deferredReferences.filter(
                    (item) => !removedMembers.has(item.recipientSessionId),
                  ),
                }
              : null),
            ...(document.updateBatches
              ? {
                  updateBatches: document.updateBatches.filter(
                    (item) => !removedMembers.has(item.recipientSessionId),
                  ),
                }
              : null),
            ...(document.handledReports
              ? {
                  handledReports: document.handledReports.filter(
                    (item) => !removedMembers.has(item.recipientSessionId),
                  ),
                }
              : null),
            spawnedSessions: document.spawnedSessions.filter(
              (spawn) => spawn.projectPath !== projectPath,
            ),
            families: document.families.filter((family) => family.projectPath !== projectPath),
            turns: document.turns.filter(
              (turn) =>
                !removedMembers.has(turn.sessionId) && !removedMembers.has(turn.senderSessionId),
            ),
          };
        }),
      );
      return SessionFamilyStorage.of({
        advanceBoardDelivery,
        recordBoardDelivery,
        updateBoardDelivery,
        setBoardDeliveryPaused,
        authorizeAutoMerge,
        recordAutoMerge,
        updateAutoMerge,
        invalidateAutoMerge,
        recordCompletion,
        updateCompletion,
        list,
        familyForMember,
        addChild,
        state,
        withMemberLock,
        withCreationLock: (key, effect) => withKeyLock(`creation:${key}`, effect),
        recordTurn,
        registerSpawn,
        recordReport,
        settleTurn,
        pendingResponseRequest,
        prepareResponse,
        confirmResponse,
        markNoticeAttempt,
        completeNotice,
        digestNotice,
        deferReferenceNotice,
        deferPassiveNotice,
        markPassiveNoticeAdmission,
        releaseAttentionReports,
        markReferenceAdmissions,
        acknowledgeReports,
        recordLaunchReport,
        removeDigest,
        saveUpdateBatch,
        closeUpdateBatch,
        discardUpdates,
        markNoticeFailure,
        retryNoticeDelivery,
        withNoticeDelivery: (effect) => noticeDeliveryLock.withPermit(effect),
        withdrawNotices,
        removeUnmaterializedChild,
        removeProject,
      });
    }),
  );
