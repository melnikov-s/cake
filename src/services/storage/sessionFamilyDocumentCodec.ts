import { Effect, Schema, Struct } from "effect";
import {
  type ResultDelivery,
  migrateResultDelivery,
} from "../../contracts/conversations/result-delivery";
import { SessionFamilyStorageError } from "../../contracts/storage/session-family-storage-errors";
import {
  SessionFamily,
  SessionFamilyChild,
  FamilyTurn,
  SpawnedSession,
  SessionFamilyDocument,
} from "../../contracts/session-families/session-family-document";

export const DOCUMENT_VERSION = 12;
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

const LegacySessionFamily = Schema.Struct({
  familyId: BoundedId,
  parentSessionId: BoundedId,
  projectPath: BoundedPath,
  workingDirectory: BoundedPath,
  managedWorktreePath: Schema.optionalKey(BoundedPath),
  createdAt: Schema.String,
  children: Schema.Array(LegacySessionFamilyChild),
});

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
/** Version 6 recorded every correlated message, including ones that requested no response. */
const Version6FamilyTurn = Schema.Struct({
  ...FamilyTurn.fields,
  ...LegacyDelivery,
  completionContract: Schema.optionalKey(Schema.Boolean),
  expectsResponse: Schema.Boolean,
});
const StoredEnvelope = Schema.Struct({ version: Schema.Int, data: Schema.Unknown });
const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
export const storageError = (operation: string, cause: unknown) =>
  new SessionFamilyStorageError({ operation, message: messageOf(cause) });

export const validateDocument = (document: SessionFamilyDocument): SessionFamilyDocument => {
  const purposes = new Set<string>();
  for (const relationship of document.sessionPurposes ?? []) {
    if (purposes.has(relationship.sessionId)) throw new Error("Duplicate session purpose");
    purposes.add(relationship.sessionId);
  }
  const parents = new Set<string>();
  for (const parent of document.sessionParents ?? []) {
    if (parent.sessionId === parent.parentSessionId || parents.has(parent.sessionId))
      throw new Error("Session parent provenance cannot change or reference itself");
    parents.add(parent.sessionId);
  }
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

export const decodeSessionFamilyDocument = Effect.fn("SessionFamilyStorage.decodeDocument")(
  function* (text: string) {
    const parsed: unknown = yield* Effect.try({
      try: () => JSON.parse(text),
      catch: (cause) => storageError("load", cause),
    });
    const envelope = yield* Schema.decodeUnknownEffect(StoredEnvelope)(parsed).pipe(
      Effect.mapError((cause) => storageError("load", cause)),
    );
    if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, DOCUMENT_VERSION].includes(envelope.version))
      return yield* storageError(
        "load",
        `Unsupported session family document version ${envelope.version}`,
      );
    const migrateTurn = (turn: typeof LegacyFamilyTurn.Type): typeof Version6FamilyTurn.Type => {
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
    // v12 adds explicit session relationships. Missing records remain User Sessions;
    // no provenance or transcript parsing is used to guess historical intent.
    // v11 adds optional boardDeliveryThrough; older documents discover from sequence zero.
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
  },
);
