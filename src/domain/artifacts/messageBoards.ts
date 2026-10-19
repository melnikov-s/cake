import { DateTime, Effect, Option, Schema } from "effect";
import { queueBoardResult } from "../conversations/completionInbox";
import { resolveSessionReference } from "../../contracts/project-sessions/session-reference";
import type { BoardNoticeEntry } from "../../contracts/artifacts/message-board-control";
import { ClientEvents } from "../../services/clients/ClientEvents";
import { ArtifactLineageId } from "../../contracts/artifacts/artifact-lineage";
import {
  MessageBoardError,
  boardDescription,
  boardRelevant,
  boardDeliveryRelevant,
  boardCurrentEntries,
  type BoardCurrentInput,
  type BoardAppendInput,
  type BoardBrowseInput,
  type BoardPageInput,
} from "../../contracts/artifacts/message-board";
import { ArtifactStorage } from "../../services/storage/ArtifactStorage";
import { MessageBoardStorage } from "../../services/storage/MessageBoardStorage";
import {
  SessionFamilyStorage,
  familyMemberIds,
  type SessionFamily,
} from "../../services/storage/SessionFamilyStorage";

const failure = (operation: string, message: string) =>
  new MessageBoardError({ operation, message });
export const boardIdFor = (familyId: string) =>
  Schema.decodeUnknownSync(ArtifactLineageId)(`family-board-${familyId}`);

const publishInvalidation = Effect.fn("MessageBoards.publishInvalidation")(function* (
  lineageId: ArtifactLineageId,
) {
  const events = yield* Effect.serviceOption(ClientEvents);
  if (Option.isSome(events))
    events.value.broadcast({ type: "message-board-invalidated", lineageId });
});

/** Called under the existing family creation lock; deterministic identity survives retries. */
export const ensureBoard = Effect.fn("MessageBoards.ensureBoard")(function* (
  family: SessionFamily,
  originatingSessionTitle?: string,
) {
  const storage = yield* ArtifactStorage;
  const id = boardIdFor(family.familyId);
  const existing = yield* storage.read(id);
  if (existing) {
    if (
      existing.snapshot.kind !== "message-board" ||
      existing.snapshot.payload.familyId !== family.familyId
    )
      return yield* failure("create", "Workboard identity conflicts with an existing artifact");
    return existing;
  }
  const created = yield* storage.publishWithLink(
    {
      lineageId: id,
      expectedLatestRevision: 0,
      workingDirectory: family.workingDirectory,
      snapshot: {
        protocol: "cake.artifact/v1",
        id,
        sessionId: family.parentSessionId,
        revision: 1,
        kind: "message-board",
        title: originatingSessionTitle?.trim().slice(0, 512) || "Workboard",
        payload: { familyId: family.familyId },
        fallback: {
          markdown:
            "Shared Workboard for workgroup coordination. Use boards.read-new to discover entries and boards.read to fetch bodies. Entries and receipts are available in the artifact viewer.",
        },
      },
    },
    {
      lineageId: id,
      target: { type: "family", familyId: family.familyId },
      selection: { mode: "follow-latest" },
      createdAt: DateTime.formatIso(yield* DateTime.now),
    },
  );
  const events = yield* Effect.serviceOption(ClientEvents);
  if (Option.isSome(events))
    events.value.broadcast({ type: "artifact-catalog-invalidated", lineageId: id });
  return created;
});

const callerBoard = Effect.fn("MessageBoards.callerBoard")(function* (sessionId: string) {
  const family = yield* (yield* SessionFamilyStorage).familyForMember(sessionId);
  if (!family) return yield* failure("authorize", "This session is not a workgroup member");
  const id = boardIdFor(family.familyId);
  const revision = yield* (yield* ArtifactStorage).read(id);
  if (
    !revision ||
    revision.snapshot.kind !== "message-board" ||
    revision.snapshot.payload.familyId !== family.familyId
  )
    return yield* failure("read", "The Workboard is unavailable");
  return { id, family };
});

export const append = Effect.fn("MessageBoards.append")(function* (
  sessionId: string,
  input: BoardAppendInput,
) {
  const { id, family } = yield* callerBoard(sessionId);
  const members = familyMemberIds(family);
  let audience: BoardAppendInput["audience"] = input.audience;
  if (input.audience !== "workgroup") {
    const resolved: string[] = [];
    for (const reference of input.audience) {
      const result = resolveSessionReference(reference, members);
      if (!result.ok) return yield* failure("append", result.error);
      resolved.push(result.sessionId);
    }
    audience = [...new Set(resolved)];
  }
  const entry = yield* (yield* MessageBoardStorage).append(id, sessionId, { ...input, audience });
  yield* queueBoardResult(family, id, entry);
  yield* publishInvalidation(id);
  return {
    boardId: id,
    entry: boardDescription(entry),
    scheduledRecipients: members.filter((recipient) =>
      boardDeliveryRelevant(entry, recipient, family.parentSessionId),
    ),
    deliveries: ((yield* (yield* SessionFamilyStorage).state()).boardDeliveries ?? []).filter(
      (item) => item.boardId === id && item.sequences.includes(entry.sequence),
    ),
  };
});

const page = <T extends { readonly sequence: number }>(
  entries: ReadonlyArray<T>,
  input: BoardPageInput,
) => {
  const after = input.after ?? 0;
  const limit = input.limit ?? 20;
  const candidates = entries.filter((entry) => entry.sequence > after);
  const selected = candidates.slice(0, limit);
  return {
    entries: selected,
    nextAfter: selected.at(-1)?.sequence ?? after,
    hasMore: candidates.length > selected.length,
  };
};

/** Suppression applies only to automatic inbox context, never historical discovery. */
export const deliveryExclusions = Effect.fn("MessageBoards.deliveryExclusions")(function* (
  sessionId: string,
) {
  const storage = yield* SessionFamilyStorage;
  const family = yield* storage.familyForMember(sessionId);
  if (!family) return undefined;
  const boardId = boardIdFor(family.familyId);
  const state = yield* storage.state();
  return {
    boardId,
    paused: state.boardDeliveryPaused?.includes(sessionId) ?? false,
    sequences: (state.boardDeliveries ?? [])
      .filter(
        (delivery) =>
          delivery.boardId === boardId &&
          delivery.recipientSessionId === sessionId &&
          (delivery.status === "canceled" || delivery.status === "failed"),
      )
      .flatMap((delivery) => delivery.sequences),
  };
});

export const readNew = Effect.fn("MessageBoards.readNew")(function* (
  sessionId: string,
  input: BoardPageInput = {},
  notificationOnly = false,
  excludeEntries: ReadonlyArray<BoardNoticeEntry> = [],
) {
  const { id, family } = yield* callerBoard(sessionId);
  const storage = yield* MessageBoardStorage;
  const receipts = yield* storage.receipts(id);
  const excluded = new Set(
    excludeEntries.filter((entry) => entry.boardId === id).map((entry) => entry.sequence),
  );
  const policy = notificationOnly ? yield* deliveryExclusions(sessionId) : undefined;
  for (const sequence of policy?.sequences ?? []) excluded.add(sequence);
  const all = yield* storage.entries(id);
  const entries = (notificationOnly ? all : boardCurrentEntries(all, sessionId))
    .filter((entry) => {
      if (
        policy?.paused ||
        excluded.has(entry.sequence) ||
        entry.authorSessionId === sessionId ||
        !(notificationOnly
          ? boardDeliveryRelevant(entry, sessionId, family.parentSessionId)
          : boardRelevant(entry, sessionId))
      )
        return false;
      const receipt = receipts.find(
        (value) => value.sequence === entry.sequence && value.sessionId === sessionId,
      );
      return (
        receipt?.readAt === undefined && (!notificationOnly || receipt?.notifiedAt === undefined)
      );
    })
    .map(boardDescription);
  return { boardId: id, ...page(entries, input) };
});

/** Current relevant descriptions, independent of unread/notification receipts. Bodies stay opt-in. */
export const current = Effect.fn("MessageBoards.current")(function* (
  sessionId: string,
  input: BoardCurrentInput = {},
) {
  const { id } = yield* callerBoard(sessionId);
  const entries = boardCurrentEntries(yield* (yield* MessageBoardStorage).entries(id), sessionId)
    .filter((entry) => input.topic === undefined || entry.topic === input.topic)
    .map(boardDescription);
  return { boardId: id, ...page(entries, input) };
});

export const read = Effect.fn("MessageBoards.read")(function* (
  sessionId: string,
  sequences: ReadonlyArray<number>,
) {
  const { id } = yield* callerBoard(sessionId);
  const all = yield* (yield* MessageBoardStorage).entries(id);
  const entries = [...new Set(sequences)].map((sequence) =>
    all.find((entry) => entry.sequence === sequence),
  );
  if (entries.some((entry) => entry === undefined))
    return yield* failure("read", "An entry was not found");
  return { boardId: id, entries: entries.filter((entry) => entry !== undefined) };
});

/** Only the Pi adapter calls this, after matching content actually supplied to the agent. */
export const recordIntake = Effect.fn("MessageBoards.recordIntake")(function* (
  sessionId: string,
  boardId: string,
  sequences: ReadonlyArray<number>,
  kind: "notifiedAt" | "readAt",
) {
  const { id } = yield* callerBoard(sessionId);
  if (id !== boardId)
    return yield* failure("record", "Workboard does not belong to the caller's workgroup");
  yield* (yield* MessageBoardStorage).record(id, sessionId, sequences, kind);
  yield* publishInvalidation(id);
});

export const entryReceipts = Effect.fn("MessageBoards.entryReceipts")(function* (
  sessionId: string,
  sequence: number,
) {
  const { id, family } = yield* callerBoard(sessionId);
  return yield* receiptsFor(id, familyMemberIds(family), sequence);
});
const receiptsFor = Effect.fn("MessageBoards.receiptsFor")(function* (
  id: ArtifactLineageId,
  memberIds: ReadonlyArray<string>,
  sequence: number,
) {
  const storage = yield* MessageBoardStorage;
  const entry = (yield* storage.entries(id)).find((value) => value.sequence === sequence);
  if (!entry) return yield* failure("receipts", "Entry not found");
  const receipts = (yield* storage.receipts(id)).filter((value) => value.sequence === sequence);
  // Audience routes discovery; explicit intake remains visible even outside that audience.
  const recipients = new Set([
    ...memberIds.filter((member) => boardRelevant(entry, member)),
    ...receipts.map((receipt) => receipt.sessionId),
  ]);
  return {
    entry: boardDescription(entry),
    deliveries: ((yield* (yield* SessionFamilyStorage).state()).boardDeliveries ?? []).filter(
      (item) => item.boardId === id && item.sequences.includes(sequence),
    ),
    receipts: [...recipients].map(
      (sessionId) =>
        receipts.find((value) => value.sessionId === sessionId) ?? { sequence, sessionId },
    ),
  };
});
export const sessionReceipts = Effect.fn("MessageBoards.sessionReceipts")(function* (
  callerId: string,
  sessionReference: string,
  input: BoardPageInput = {},
) {
  const { id, family } = yield* callerBoard(callerId);
  const resolved = resolveSessionReference(sessionReference, familyMemberIds(family));
  if (!resolved.ok) return yield* failure("receipts", resolved.error);
  const sessionId = resolved.sessionId;
  const storage = yield* MessageBoardStorage;
  const receipts = yield* storage.receipts(id);
  const entries = (yield* storage.entries(id))
    .filter((entry) => boardRelevant(entry, sessionId))
    .map(boardDescription);
  const selected = page(entries, input);
  return {
    boardId: id,
    sessionId,
    ...selected,
    entries: selected.entries.map((entry) => ({
      entry,
      receipt: receipts.find(
        (value) => value.sequence === entry.sequence && value.sessionId === sessionId,
      ) ?? { sequence: entry.sequence, sessionId },
    })),
  };
});

/** Human artifact browsing never records an agent receipt. */
const uiBoard = Effect.fn("MessageBoards.uiBoard")(function* (id: ArtifactLineageId) {
  const revision = yield* (yield* ArtifactStorage).read(id);
  if (!revision || revision.snapshot.kind !== "message-board")
    return yield* failure("browse", "Message-board artifact not found");
  return revision;
});
export const browse = Effect.fn("MessageBoards.browse")(function* (
  id: ArtifactLineageId,
  input: BoardBrowseInput,
) {
  yield* uiBoard(id);
  const descriptions = (yield* (yield* MessageBoardStorage).entries(id)).map(boardDescription);
  if (input.recent) {
    const entries = descriptions.slice(-(input.limit ?? 3));
    return { boardId: id, entries, nextAfter: entries.at(-1)?.sequence ?? 0, hasMore: false };
  }
  return { boardId: id, ...page(descriptions, input) };
});
export const browseBody = Effect.fn("MessageBoards.browseBody")(function* (
  id: ArtifactLineageId,
  sequence: number,
) {
  yield* uiBoard(id);
  const entry = (yield* (yield* MessageBoardStorage).entries(id)).find(
    (entry) => entry.sequence === sequence,
  );
  if (!entry) return yield* failure("browse", "Entry not found");
  return entry;
});
export const browseReceipts = Effect.fn("MessageBoards.browseReceipts")(function* (
  id: ArtifactLineageId,
  sequence: number,
) {
  const revision = yield* uiBoard(id);
  if (revision.snapshot.kind !== "message-board")
    return yield* failure("browse", "Message-board artifact not found");
  const familyId = revision.snapshot.payload.familyId;
  const family = (yield* (yield* SessionFamilyStorage).list()).find(
    (family) => family.familyId === familyId,
  );
  return yield* receiptsFor(id, family ? familyMemberIds(family) : [], sequence);
});
