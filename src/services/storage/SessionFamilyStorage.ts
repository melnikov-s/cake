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
} from "effect";
import { atomicWriteFile, type AtomicFileStage } from "./internal/atomicFile";
import { SessionFamilyStorageError } from "../../contracts/storage/session-family-storage-errors";

import {
  CakeChatLaunchReport,
  CakeChatLaunchStatus,
  CakeChatReportDelivery,
  SessionCompletionReport,
  SessionRequester,
} from "../../contracts/project-sessions/session-reporting";

const DOCUMENT_VERSION = 7;
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
  projectPath: BoundedPath,
  workingDirectory: BoundedPath,
  requester: SessionRequester,
  reportDelivered: Schema.Boolean,
  /** A factual stop notice is a settled handoff, but not a successful result report. */
  handoffSettled: Schema.Boolean,
  launchedAt: Schema.optionalKey(Schema.String),
  /** The initial assignment's report policy, reused by crash-recovery notices. */
  reportPolicy: Schema.optionalKey(CakeChatReportDelivery),
  /** Latest result Cake Chat received (immediately or by digest), for status surfaces. */
  lastReport: Schema.optionalKey(CakeChatLaunchReport),
});
export interface SpawnedSession extends Schema.Schema.Type<typeof SpawnedSession> {}

/**
 * One pending reply obligation. Cake records it only when an accepted incoming
 * message explicitly set `expectsResponse: true`; the turn that consumes that
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
  /** Cake Chat requests only. Absent means immediate delivery, as for family parents. */
  reportPolicy: Schema.optionalKey(CakeChatReportDelivery),
  /** Who deliberately stopped an aborted turn. Absent on an unexpected interruption. */
  stop: Schema.optionalKey(TurnStop),
});
export interface FamilyTurn extends Schema.Schema.Type<typeof FamilyTurn> {}
/** Version 6 recorded every correlated message, including ones that requested no response. */
const Version6FamilyTurn = Schema.Struct({
  ...FamilyTurn.fields,
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
  status: CakeChatLaunchStatus,
  summary: Schema.String.check(Schema.isMaxLength(500)),
  reportedAt: Schema.String,
});
export interface CoordinatorDigestItem extends Schema.Schema.Type<typeof CoordinatorDigestItem> {}
export const SessionFamilyDocument = Schema.Struct({
  families: Schema.Array(SessionFamily),
  turns: Schema.Array(FamilyTurn),
  spawnedSessions: Schema.Array(SpawnedSession),
  /** Cake Chat's inbox of digest-policy results, drained into its next user message. */
  coordinatorDigest: Schema.optionalKey(Schema.Array(CoordinatorDigestItem)),
});
export interface SessionFamilyDocument extends Schema.Schema.Type<typeof SessionFamilyDocument> {}

export class SessionFamilyStorage extends Context.Service<
  SessionFamilyStorage,
  {
    readonly state: () => Effect.Effect<SessionFamilyDocument, SessionFamilyStorageError>;
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
    readonly recordLaunchReport: (
      sessionId: string,
      report: CakeChatLaunchReport,
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
      readonly childWorkingDirectory: string;
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
        if (![1, 2, 3, 4, 5, 6, DOCUMENT_VERSION].includes(envelope.version))
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
        lock.withPermits(1)(loadUnlocked()),
      );
      const memberLocks = yield* RcMap.make({
        lookup: (parentSessionId: string) =>
          Semaphore.make(1).pipe(
            Effect.withSpan("SessionFamilyStorage.lock", { attributes: { parentSessionId } }),
          ),
      });
      const withMemberLock: SessionFamilyStorage["Service"]["withMemberLock"] = (
        sessionId,
        effect,
      ) =>
        Effect.acquireUseRelease(
          Scope.make(),
          (leaseScope) =>
            Effect.gen(function* () {
              const family = yield* familyForMember(sessionId);
              const memberLock = yield* RcMap.get(
                memberLocks,
                family?.parentSessionId ?? sessionId,
              ).pipe(Effect.provideService(Scope.Scope, leaseScope));
              return yield* memberLock.withPermits(1)(effect);
            }),
          (leaseScope) => Scope.close(leaseScope, Exit.void),
        );
      const update = Effect.fn("SessionFamilyStorage.update")(
        (change: (document: SessionFamilyDocument) => SessionFamilyDocument) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const document = yield* loadUnlocked();
              yield* saveUnlocked(change(document));
            }),
          ),
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
                        ...(report && (!turn.report || outcome === "failed") ? { report } : null),
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
              coordinatorDigest: digest.some((existing) => existing.id === item.id)
                ? digest
                : [...digest, item],
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
      const withdrawNotices = Effect.fn("SessionFamilyStorage.withdrawNotices")(
        (recipientSessionId: string, messageIds: ReadonlyArray<string>) =>
          update((document) => {
            const withdrawn = document.turns.filter(
              (turn) =>
                turn.senderSessionId === recipientSessionId &&
                (messageIds.includes(turn.turnId) ||
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
        list,
        familyForMember,
        addChild,
        state,
        withMemberLock,
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
        recordLaunchReport,
        removeDigest,
        withNoticeDelivery: (effect) => noticeDeliveryLock.withPermit(effect),
        withdrawNotices,
        removeUnmaterializedChild,
        removeProject,
      });
    }),
  );
