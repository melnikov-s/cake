import { MessageReference } from "../../contracts/conversations/message-reference";
import { StoredPassiveNotice } from "../../contracts/conversations/passive-notice";
import { PendingReport, ReportHandlingReceipt } from "../../contracts/conversations/pending-report";
import { BoardDelivery } from "../../contracts/artifacts/board-delivery";
import {
  CompletionInboxItem,
  type CompletionDecisionState,
} from "../../contracts/conversations/completion-inbox";
import {
  ResultDelivery,
  migrateResultDelivery,
} from "../../contracts/conversations/result-delivery";
import { TurnStop } from "../../contracts/conversations/turn-stop";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
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
import { SessionFamilyStorageError } from "../../contracts/storage/session-family-storage-errors";

import {
  CakeChatLaunchReport,
  CakeChatLaunchStatus,
  SessionCompletionReport,
  SessionRequester,
} from "../../contracts/project-sessions/session-reporting";

const DOCUMENT_VERSION = 10;
const LegacyDelivery = {
  continuation: Schema.optionalKey(Schema.Literals(["none", "resume"])),
  reportPolicy: Schema.optionalKey(Schema.Literals(["digest", "interrupt"])),
};
const BoundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const BoundedPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));

const LegacySessionFamilyChild = Schema.Struct({
  sessionId: BoundedId,
  requestId: BoundedId,
  createdAt: Schema.String,
});

const SessionFamilyChild = Schema.Struct({
  sessionId: BoundedId,
  parentSessionId: BoundedId,
  requestId: BoundedId,
  workingDirectory: BoundedPath,
  managedWorktreePath: Schema.optionalKey(BoundedPath),
  /** Assignment-first reservations survive restart before durable admission. */
  assignmentTopic: Schema.optionalKey(BoundedId),
  resultDelivery: Schema.optionalKey(ResultDelivery),
  createdAt: Schema.String,
});
interface SessionFamilyChild extends Schema.Schema.Type<typeof SessionFamilyChild> {}

export const SessionFamily = Schema.Struct({
  familyId: BoundedId,
  parentSessionId: BoundedId,
  projectPath: BoundedPath,
  workingDirectory: BoundedPath,
  managedWorktreePath: Schema.optionalKey(BoundedPath),
  createdAt: Schema.String,
  children: Schema.Array(SessionFamilyChild),
});
export interface SessionFamily extends Schema.Schema.Type<typeof SessionFamily> {}

const LegacySessionFamily = Schema.Struct({
  familyId: BoundedId,
  parentSessionId: BoundedId,
  projectPath: BoundedPath,
  workingDirectory: BoundedPath,
  managedWorktreePath: Schema.optionalKey(BoundedPath),
  createdAt: Schema.String,
  children: Schema.Array(LegacySessionFamilyChild),
});

export interface SessionFamilyMember {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly workingDirectory: string;
  readonly managedWorktreePath?: string;
}

export const familyMember = (
  family: SessionFamily,
  sessionId: string,
): SessionFamilyMember | undefined => {
  if (family.parentSessionId === sessionId) {
    const root: SessionFamilyMember = {
      sessionId,
      workingDirectory: family.workingDirectory,
    };
    if (family.managedWorktreePath !== undefined)
      Object.assign(root, { managedWorktreePath: family.managedWorktreePath });
    return root;
  }
  return family.children.find((child) => child.sessionId === sessionId);
};

export const familyChildren = (family: SessionFamily, parentSessionId: string) =>
  family.children.filter((child) => child.parentSessionId === parentSessionId);

export const familyMemberIds = (family: SessionFamily) => [
  family.parentSessionId,
  ...family.children.map((child) => child.sessionId),
];

export const familyDepth = (family: SessionFamily, sessionId: string) => {
  let depth = 0;
  let member = familyMember(family, sessionId);
  const visited = new Set<string>();
  while (member?.parentSessionId !== undefined) {
    if (visited.has(member.sessionId)) return undefined;
    visited.add(member.sessionId);
    depth += 1;
    member = familyMember(family, member.parentSessionId);
  }
  return member ? depth : undefined;
};

const LegacyFamilyTransition = Schema.Struct({
  parentSessionId: BoundedId,
  resolved: Schema.Boolean,
});
const LegacyFamilyTurn = Schema.Struct({
  sessionId: BoundedId,
  parentSessionId: BoundedId,
  turnId: BoundedId,
  reported: Schema.Boolean,
  deliveryTurnId: Schema.optionalKey(BoundedId),
  replyMessageIds: Schema.optionalKey(Schema.Array(BoundedId)),
  outcome: Schema.optionalKey(Schema.Literals(["complete", "failed", "aborted"])),
});
const SpawnedSession = Schema.Struct({
  sessionId: BoundedId,
  /** Launch label retained independently of Pi content for metadata-only discovery. */
  title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  projectPath: BoundedPath,
  workingDirectory: BoundedPath,
  requester: SessionRequester,
  reportDelivered: Schema.Boolean,
  /** A factual stop notice is a settled handoff, but not a successful result report. */
  handoffSettled: Schema.Boolean,
  launchedAt: Schema.optionalKey(Schema.String),
  resultDelivery: Schema.optionalKey(ResultDelivery),
  /** Latest result Cake Chat received (immediately or by digest), for status surfaces. */
  lastReport: Schema.optionalKey(CakeChatLaunchReport),
});
export interface SpawnedSession extends Schema.Schema.Type<typeof SpawnedSession> {}

/**
 * One pending reply obligation. Cake records it only when an accepted incoming
 * message selected reply or notification; the turn that consumes that
 * message owes exactly one result (or one factual failure notice), after which
 * the record is removed. Turns without a record never notify anyone.
 */
const FamilyTurn = Schema.Struct({
  report: Schema.optionalKey(SessionCompletionReport),
  /** The session executing the request. */
  sessionId: BoundedId,
  /** The session that asked for the response. */
  senderSessionId: BoundedId,
  turnId: BoundedId,
  requestMessageId: BoundedId,
  threadId: BoundedId,
  reported: Schema.Boolean,
  deliveryTurnId: Schema.optionalKey(BoundedId),
  replyMessageIds: Schema.optionalKey(Schema.Array(BoundedId)),
  outcome: Schema.optionalKey(Schema.Literals(["complete", "failed", "aborted"])),
  resultDelivery: Schema.optionalKey(ResultDelivery),
  /** Who deliberately stopped an aborted turn. Absent on an unexpected interruption. */
  stop: Schema.optionalKey(TurnStop),
});
export interface FamilyTurn extends Schema.Schema.Type<typeof FamilyTurn> {}
/** Version 6 recorded every correlated message, including ones that requested no response. */
const Version6FamilyTurn = Schema.Struct({
  ...FamilyTurn.fields,
  ...LegacyDelivery,
  completionContract: Schema.optionalKey(Schema.Boolean),
  expectsResponse: Schema.Boolean,
});
/** One quiet status line waiting for the user's next Cake Chat message. */
const CoordinatorDigestItem = Schema.Struct({
  /** Absent denotes the global chat, including existing persisted inbox items. */
  coordinatorSessionId: Schema.optionalKey(BoundedId),
  /** The settled obligation's turn ID; digesting is idempotent per turn. */
  id: BoundedId,
  sessionId: BoundedId,
  title: Schema.String.check(Schema.isMaxLength(500)),
  resultMessageRef: Schema.optionalKey(MessageReference),
  status: CakeChatLaunchStatus,
  summary: Schema.String.check(Schema.isMaxLength(500)),
  reportedAt: Schema.String,
});
export interface CoordinatorDigestItem extends Schema.Schema.Type<typeof CoordinatorDigestItem> {}
/**
 * One open batch timer per recipient conversation. Opened when the first deferred update
 * arrives in an empty batch; delivered at dueAt or carried by the next user message.
 * turnId records an admission attempt so a restart reconciles instead of resending.
 */
const UpdateBatch = Schema.Struct({
  recipientSessionId: BoundedId,
  openedAt: Schema.String,
  dueAt: Schema.String,
  turnId: Schema.optionalKey(BoundedId),
});
export interface UpdateBatch extends Schema.Schema.Type<typeof UpdateBatch> {}
export const SessionFamilyDocument = Schema.Struct({
  families: Schema.Array(SessionFamily),
  turns: Schema.Array(FamilyTurn),
  spawnedSessions: Schema.Array(SpawnedSession),
  /** Cake Chat's inbox of digest-policy results, drained into its next user message. */
  coordinatorDigest: Schema.optionalKey(Schema.Array(CoordinatorDigestItem)),
  deferredReferences: Schema.optionalKey(Schema.Array(PendingReport)),
  passiveNotices: Schema.optionalKey(Schema.Array(StoredPassiveNotice)),
  handledReports: Schema.optionalKey(Schema.Array(ReportHandlingReceipt)),
  boardDeliveries: Schema.optionalKey(Schema.Array(BoardDelivery)),
  boardDeliveryPaused: Schema.optionalKey(Schema.Array(BoundedId)),
  completionInbox: Schema.optionalKey(Schema.Array(CompletionInboxItem)),
  updateBatches: Schema.optionalKey(Schema.Array(UpdateBatch)),
});
export interface SessionFamilyDocument extends Schema.Schema.Type<typeof SessionFamilyDocument> {}

export class SessionFamilyStorage extends Context.Service<
  SessionFamilyStorage,
  {
    readonly state: () => Effect.Effect<SessionFamilyDocument, SessionFamilyStorageError>;
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
    /** Removes digest items once they were attached to an accepted Cake Chat message. */
    readonly removeDigest: (
      ids: ReadonlyArray<string>,
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

const StoredEnvelope = Schema.Struct({ version: Schema.Int, data: Schema.Unknown });
const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const storageError = (operation: string, cause: unknown) =>
  new SessionFamilyStorageError({ operation, message: messageOf(cause) });

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

const validateDocument = (document: SessionFamilyDocument): SessionFamilyDocument => {
  const familyIds = new Set<string>();
  const memberIds = new Set<string>();
  const requestIds = new Set<string>();
  for (const family of document.families) {
    if (familyIds.has(family.familyId)) throw new Error(`Duplicate family ID ${family.familyId}`);
    familyIds.add(family.familyId);
    if (memberIds.has(family.parentSessionId))
      throw new Error(`Session ${family.parentSessionId} belongs to more than one family`);
    memberIds.add(family.parentSessionId);
    const precedingMembers = new Set([family.parentSessionId]);
    for (const child of family.children) {
      if (!precedingMembers.has(child.parentSessionId))
        throw new Error(
          `Parent ${child.parentSessionId} must precede child ${child.sessionId} in its family`,
        );
      if (memberIds.has(child.sessionId))
        throw new Error(`Session ${child.sessionId} belongs to more than one family`);
      if (requestIds.has(child.requestId))
        throw new Error(`Duplicate child creation request ${child.requestId}`);
      precedingMembers.add(child.sessionId);
      memberIds.add(child.sessionId);
      requestIds.add(child.requestId);
    }
  }
  return document;
};

export const makeSessionFamilyStorageLive = (documentPath: string) =>
  Layer.effect(
    SessionFamilyStorage,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lock = yield* Semaphore.make(1);
      const noticeDeliveryLock = yield* Semaphore.make(1);

      const loadUnlocked = Effect.fn("SessionFamilyStorage.loadUnlocked")(function* () {
        if (
          !(yield* fileSystem
            .exists(documentPath)
            .pipe(Effect.mapError((e) => storageError("load", e))))
        )
          return { families: [], turns: [], spawnedSessions: [] } satisfies SessionFamilyDocument;
        const text = yield* fileSystem
          .readFileString(documentPath)
          .pipe(Effect.mapError((e) => storageError("load", e)));
        const parsed: unknown = yield* Effect.try({
          try: () => JSON.parse(text),
          catch: (cause) => storageError("load", cause),
        });
        const envelope = yield* Schema.decodeUnknownEffect(StoredEnvelope)(parsed).pipe(
          Effect.mapError((cause) => storageError("load", cause)),
        );
        if (![1, 2, 3, 4, 5, 6, 7, 8, 9, DOCUMENT_VERSION].includes(envelope.version))
          return yield* storageError(
            "load",
            `Unsupported session family document version ${envelope.version}`,
          );
        const migrateTurn = (
          turn: typeof LegacyFamilyTurn.Type,
        ): typeof Version6FamilyTurn.Type => {
          const { parentSessionId, ...rest } = turn;
          return {
            ...rest,
            senderSessionId: parentSessionId,
            requestMessageId: turn.turnId,
            threadId: turn.turnId,
            expectsResponse: true,
          };
        };
        let data = envelope.data;
        if (envelope.version === 1 || envelope.version === 2) {
          const legacy = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              families: Schema.Array(LegacySessionFamily),
              transitions:
                envelope.version === 1
                  ? Schema.optionalKey(Schema.Array(LegacyFamilyTransition))
                  : Schema.Array(LegacyFamilyTransition),
              turns:
                envelope.version === 1
                  ? Schema.optionalKey(Schema.Array(LegacyFamilyTurn))
                  : Schema.Array(LegacyFamilyTurn),
            }),
          )(envelope.data).pipe(Effect.mapError((cause) => storageError("migrate", cause)));
          data = {
            families: legacy.families.map((family) => ({
              ...family,
              children: family.children.map((child) => ({
                ...child,
                parentSessionId: family.parentSessionId,
                workingDirectory: family.workingDirectory,
                ...(family.managedWorktreePath === undefined
                  ? null
                  : { managedWorktreePath: family.managedWorktreePath }),
              })),
            })),
            transitions: legacy.transitions ?? [],
            turns: (legacy.turns ?? []).map(migrateTurn),
          };
        } else if (envelope.version === 3) {
          const legacy = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              families: Schema.Array(SessionFamily),
              transitions: Schema.Array(LegacyFamilyTransition),
              turns: Schema.Array(LegacyFamilyTurn),
            }),
          )(envelope.data).pipe(Effect.mapError((cause) => storageError("migrate", cause)));
          data = { ...legacy, turns: legacy.turns.map(migrateTurn) };
        }
        if (envelope.version < 6) {
          const previous = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              families: Schema.Array(SessionFamily),
              turns: Schema.Array(Version6FamilyTurn),
            }),
          )(data).pipe(Effect.mapError((cause) => storageError("migrate", cause)));
          data = { ...previous, spawnedSessions: [] };
        }
        if (envelope.version < 7) {
          const previous = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              families: Schema.Array(SessionFamily),
              turns: Schema.Array(Version6FamilyTurn),
              spawnedSessions: Schema.Array(SpawnedSession),
            }),
          )(data).pipe(Effect.mapError((cause) => storageError("migrate", cause)));
          // v7 journals only explicit reply obligations. Records for messages that asked
          // for no response must not become notices after upgrade. Decoding the v7
          // document below drops the retired per-record flags.
          data = { ...previous, turns: previous.turns.filter((turn) => turn.expectsResponse) };
        }
        if (envelope.version < 8) {
          const previous = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              ...SessionFamilyDocument.fields,
              families: Schema.Array(
                Schema.Struct({
                  ...SessionFamily.fields,
                  children: Schema.Array(
                    Schema.Struct({ ...SessionFamilyChild.fields, ...LegacyDelivery }),
                  ),
                }),
              ),
              turns: Schema.Array(Schema.Struct({ ...FamilyTurn.fields, ...LegacyDelivery })),
              spawnedSessions: Schema.Array(
                Schema.Struct({ ...SpawnedSession.fields, ...LegacyDelivery }),
              ),
            }),
          )(data).pipe(Effect.mapError((cause) => storageError("migrate", cause)));
          const migrate = <
            A extends {
              readonly resultDelivery?: ResultDelivery;
              readonly continuation?: "none" | "resume";
              readonly reportPolicy?: "digest" | "interrupt";
            },
          >(
            item: A,
          ) => {
            return {
              ...Struct.omit(item, ["continuation", "reportPolicy"]),
              resultDelivery: migrateResultDelivery({
                resultDelivery: item.resultDelivery,
                continuation: item.continuation,
                reportPolicy: item.reportPolicy,
              }),
            };
          };
          data = {
            ...previous,
            families: previous.families.map((family) => ({
              ...family,
              children: family.children.map(migrate),
            })),
            turns: previous.turns.map(migrate),
            spawnedSessions: previous.spawnedSessions.map(migrate),
          };
        }
        if (envelope.version < 9) {
          const legacy = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              boardContinuations: Schema.optionalKey(
                Schema.Array(
                  Schema.Struct({
                    recipientSessionId: BoundedId,
                    mode: Schema.Literals(["resume", "paused", "off"]),
                  }),
                ),
              ),
            }),
          )(envelope.data).pipe(Effect.mapError((cause) => storageError("migrate", cause)));
          const previous = yield* Schema.decodeUnknownEffect(SessionFamilyDocument)(data).pipe(
            Effect.mapError((cause) => storageError("migrate", cause)),
          );
          const paused =
            legacy.boardContinuations
              ?.filter((grant) => grant.mode !== "resume")
              .map((grant) => grant.recipientSessionId) ?? [];
          data = {
            ...previous,
            ...(paused.length
              ? {
                  boardDeliveryPaused: [
                    ...new Set([...(previous.boardDeliveryPaused ?? []), ...paused]),
                  ],
                }
              : null),
          };
        }
        // v9 drops retired Workboard completion grants on decode. Default board
        // delivery owns one cursor/batch per recipient; old budgets cannot gate or double-wake it.
        // v5 drops member-synchronization journals. The root's actual namespace
        // is authoritative even when an older transition stopped halfway through.
        const document = yield* Schema.decodeUnknownEffect(SessionFamilyDocument)(data).pipe(
          Effect.mapError((cause) => storageError("load", cause)),
        );
        return yield* Effect.try({
          try: () => validateDocument(document),
          catch: (cause) => storageError("load", cause),
        });
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
      const addChild = Effect.fn("SessionFamilyStorage.addChild")(function* (input) {
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
      const recordCompletion = Effect.fn("SessionFamilyStorage.recordCompletion")(
        (item: CompletionInboxItem, digest?: CoordinatorDigestItem) =>
          update((document) => {
            const inbox = document.completionInbox ?? [];
            if (inbox.some((existing) => existing.id === item.id)) return document;
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
                                ...(report?.resultMessageRef
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
              !document.turns.some((turn) => turnIds.includes(turn.turnId) && !turn.reported)
            )
              return document;
            if (
              document.handledReports?.some(
                (receipt) =>
                  receipt.id === item.id && receipt.recipientSessionId === item.recipientSessionId,
              )
            )
              return turnIds.reduce(withoutNotice, document);
            const notices = document.deferredReferences ?? [];
            return {
              ...turnIds.reduce(withoutNotice, document),
              deferredReferences: notices.some((notice) => notice.id === item.id)
                ? notices
                : [...notices, item],
            };
          }),
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
                ...receipts.filter(
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
        recordBoardDelivery,
        updateBoardDelivery,
        setBoardDeliveryPaused,
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
        markReferenceAdmissions,
        acknowledgeReports,
        recordLaunchReport,
        removeDigest,
        saveUpdateBatch,
        closeUpdateBatch,
        withNoticeDelivery: (effect) => noticeDeliveryLock.withPermit(effect),
        withdrawNotices,
        removeUnmaterializedChild,
        removeProject,
      });
    }),
  );
