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

const DOCUMENT_VERSION = 2;
const BoundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const BoundedPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));

const SessionFamilyChild = Schema.Struct({
  sessionId: BoundedId,
  requestId: BoundedId,
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

const FamilyTransition = Schema.Struct({ parentSessionId: BoundedId, resolved: Schema.Boolean });
const FamilyTurn = Schema.Struct({
  sessionId: BoundedId,
  parentSessionId: BoundedId,
  turnId: BoundedId,
  reported: Schema.Boolean,
  deliveryTurnId: Schema.optionalKey(BoundedId),
  replyMessageIds: Schema.optionalKey(Schema.Array(BoundedId)),
  outcome: Schema.optionalKey(Schema.Literals(["complete", "failed", "aborted"])),
});
export interface FamilyTurn extends Schema.Schema.Type<typeof FamilyTurn> {}
export const SessionFamilyDocument = Schema.Struct({
  families: Schema.Array(SessionFamily),
  transitions: Schema.Array(FamilyTransition),
  turns: Schema.Array(FamilyTurn),
});
export interface SessionFamilyDocument extends Schema.Schema.Type<typeof SessionFamilyDocument> {}

export class SessionFamilyStorageError extends Schema.TaggedError<SessionFamilyStorageError>()(
  "SessionFamilyStorageError",
  { operation: Schema.String, message: Schema.String },
) {}

export class SessionFamilyStorage extends Context.Service<
  SessionFamilyStorage,
  {
    readonly state: () => Effect.Effect<SessionFamilyDocument, SessionFamilyStorageError>;
    readonly withMemberLock: <A, E, R>(
      sessionId: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | SessionFamilyStorageError, R>;
    readonly beginTransition: (
      parentSessionId: string,
      resolved: boolean,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly finishTransition: (
      parentSessionId: string,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly recordTurn: (turn: FamilyTurn) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly settleTurn: (
      turnId: string,
      outcome: "complete" | "failed" | "aborted",
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly prepareReply: (
      sessionId: string,
      turnIds: ReadonlyArray<string>,
      messageId: string,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly reportTurns: (
      sessionId: string,
      turnIds: ReadonlyArray<string>,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly markNoticeAttempt: (
      turnId: string,
      deliveryTurnId: string,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly completeNotice: (turnId: string) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly removeUnmaterializedChild: (
      sessionId: string,
    ) => Effect.Effect<void, SessionFamilyStorageError>;
    readonly list: () => Effect.Effect<ReadonlyArray<SessionFamily>, SessionFamilyStorageError>;
    readonly familyForMember: (
      sessionId: string,
    ) => Effect.Effect<SessionFamily | undefined, SessionFamilyStorageError>;
    readonly addChild: (input: {
      readonly familyId: string;
      readonly parentSessionId: string;
      readonly childSessionId: string;
      readonly requestId: string;
      readonly projectPath: string;
      readonly workingDirectory: string;
      readonly managedWorktreePath?: string;
      readonly createdAt: string;
    }) => Effect.Effect<SessionFamily, SessionFamilyStorageError>;
  }
>()("cake/services/storage/SessionFamilyStorage") {}

const StoredEnvelope = Schema.Struct({ version: Schema.Int, data: Schema.Unknown });
const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const storageError = (operation: string, cause: unknown) =>
  new SessionFamilyStorageError({ operation, message: messageOf(cause) });

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
    for (const child of family.children) {
      if (memberIds.has(child.sessionId))
        throw new Error(`Session ${child.sessionId} belongs to more than one family`);
      if (requestIds.has(child.requestId))
        throw new Error(`Duplicate child creation request ${child.requestId}`);
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

      const loadUnlocked = Effect.fn("SessionFamilyStorage.loadUnlocked")(function* () {
        if (
          !(yield* fileSystem
            .exists(documentPath)
            .pipe(Effect.mapError((e) => storageError("load", e))))
        )
          return { families: [], transitions: [], turns: [] } satisfies SessionFamilyDocument;
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
        if (envelope.version !== 1 && envelope.version !== DOCUMENT_VERSION)
          return yield* storageError(
            "load",
            `Unsupported session family document version ${envelope.version}`,
          );
        const data =
          envelope.version === 1
            ? {
                ...(yield* Schema.decodeUnknownEffect(
                  Schema.Struct({ families: Schema.Array(SessionFamily) }),
                )(envelope.data).pipe(Effect.mapError((cause) => storageError("migrate", cause)))),
                transitions: [],
                turns: [],
              }
            : envelope.data;
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
              (family) =>
                family.parentSessionId === input.parentSessionId ||
                family.children.some((child) => child.sessionId === input.parentSessionId),
            );
            if (childOwner && childOwner.parentSessionId !== input.parentSessionId)
              return yield* storageError(
                "addChild",
                "A child Project Session cannot create children",
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
            if (
              childOwner &&
              (childOwner.projectPath !== input.projectPath ||
                childOwner.workingDirectory !== input.workingDirectory ||
                childOwner.managedWorktreePath !== input.managedWorktreePath)
            )
              return yield* storageError(
                "addChild",
                "Family Working Directory binding cannot change",
              );
            const child: SessionFamilyChild = {
              sessionId: input.childSessionId,
              requestId: input.requestId,
              createdAt: input.createdAt,
            };
            let family: SessionFamily;
            if (childOwner) family = { ...childOwner, children: [...childOwner.children, child] };
            else {
              family = {
                familyId: input.familyId,
                parentSessionId: input.parentSessionId,
                projectPath: input.projectPath,
                workingDirectory: input.workingDirectory,
                createdAt: input.createdAt,
                children: [child],
              };
              if (input.managedWorktreePath !== undefined)
                Object.assign(family, { managedWorktreePath: input.managedWorktreePath });
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
      const beginTransition = Effect.fn("SessionFamilyStorage.beginTransition")(
        (parentSessionId: string, resolved: boolean) =>
          update((document) => ({
            ...document,
            transitions: [
              ...document.transitions.filter((item) => item.parentSessionId !== parentSessionId),
              { parentSessionId, resolved },
            ],
          })),
      );
      const finishTransition = Effect.fn("SessionFamilyStorage.finishTransition")(
        (parentSessionId: string) =>
          update((document) => ({
            ...document,
            transitions: document.transitions.filter(
              (item) => item.parentSessionId !== parentSessionId,
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
      const settleTurn = Effect.fn("SessionFamilyStorage.settleTurn")(
        (turnId: string, outcome: "complete" | "failed" | "aborted") =>
          update((document) => ({
            ...document,
            turns: document.turns.flatMap((turn) =>
              turn.turnId !== turnId ? [turn] : turn.reported ? [] : [{ ...turn, outcome }],
            ),
          })),
      );
      const prepareReply = Effect.fn("SessionFamilyStorage.prepareReply")(
        (sessionId: string, turnIds: ReadonlyArray<string>, messageId: string) =>
          update((document) => ({
            ...document,
            turns: document.turns.map((turn) =>
              turn.sessionId === sessionId && turnIds.includes(turn.turnId)
                ? { ...turn, replyMessageIds: [...(turn.replyMessageIds ?? []), messageId] }
                : turn,
            ),
          })),
      );
      const reportTurns = Effect.fn("SessionFamilyStorage.reportTurns")(
        (sessionId: string, turnIds: ReadonlyArray<string>) =>
          update((document) => ({
            ...document,
            turns: document.turns.map((turn) =>
              turn.sessionId === sessionId && turnIds.includes(turn.turnId)
                ? { ...turn, reported: true }
                : turn,
            ),
          })),
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
      const completeNotice = Effect.fn("SessionFamilyStorage.completeNotice")((turnId: string) =>
        update((document) => ({
          ...document,
          turns: document.turns.filter((turn) => turn.turnId !== turnId),
        })),
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
      return SessionFamilyStorage.of({
        list,
        familyForMember,
        addChild,
        state,
        withMemberLock,
        beginTransition,
        finishTransition,
        recordTurn,
        settleTurn,
        reportTurns,
        prepareReply,
        markNoticeAttempt,
        completeNotice,
        removeUnmaterializedChild,
      });
    }),
  );
