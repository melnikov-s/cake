import { Schema } from "effect";
import { applySnapshot, batch, toSnapshot, type Snapshot } from "r-state-tree";
import type { DiscussionCatalogUpdate } from "../../domain/catalog-data";
import type {
  DiscussionSessionUpdate,
  DiscussionThread,
} from "../../domain/discussion-session-data";
import { sessionSnapshotSchema, uiPartSchema } from "../../ipc/session-contract";
import type { ReviewThread } from "../models/ReviewThread";
import type { Session } from "../models/Session";
import { applyPartUpdate, messageSnapshots, removePart } from "./SessionPartProjection";

export function applyDiscussionCatalogUpdate(
  model: Session,
  sessionId: string,
  update: DiscussionCatalogUpdate,
) {
  if (update.parentSessionId !== sessionId)
    throw new Error(`Discussion catalog identity collision: ${sessionId}`);
  const threads = update._tag === "Snapshot" ? update.threads : update.event.threads;
  assertUnique(
    threads.map((thread) => thread.id),
    "Discussion thread ID",
  );
  applySnapshot(model, {
    ...toSnapshot(model),
    reviewThreads: threads.map((thread) => discussionSnapshot(thread)),
  });
}

export function applyDiscussionUpdate(
  model: ReviewThread,
  threadId: string,
  update: DiscussionSessionUpdate,
) {
  if (update._tag === "Snapshot") {
    if (update.snapshot.thread.id !== threadId)
      throw new Error(`Discussion identity collision: ${threadId}`);
    applySnapshot(model, discussionSnapshot(update.snapshot.thread, update.snapshot.conversation));
    return;
  }
  if (update.threadId !== threadId)
    throw new Error(`Discussion event identity collision: ${threadId}`);
  const event = update.event;
  if (event._tag === "SnapshotUpdated") {
    applySnapshot(model, discussionSnapshot(toDiscussionThread(model), event.snapshot));
    return;
  }
  batch(() => {
    if (event._tag === "PartUpdated")
      applyPartUpdate(model.parts, Schema.decodeUnknownSync(uiPartSchema)(event.part));
    else if (event._tag === "PartRemoved") removePart(model.parts, event.partId);
    else if (event._tag === "StreamingChanged") model.streaming = event.streaming;
  });
}

function toDiscussionThread(thread: ReviewThread): DiscussionThread {
  const snapshot: DiscussionThread = {
    id: thread.id,
    workingDirectory: thread.workingDirectory,
    parentSessionId: thread.parentSessionId,
    anchor: thread.anchor,
    parts: thread.uiParts,
    status: thread.status,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
  if (thread.sidecarSessionId !== undefined)
    Object.assign(snapshot, { sidecarSessionId: thread.sidecarSessionId });
  if (thread.usage !== undefined) Object.assign(snapshot, { usage: thread.usage });
  if (thread.resolvedAt !== undefined) Object.assign(snapshot, { resolvedAt: thread.resolvedAt });
  return snapshot;
}

function discussionSnapshot(
  thread: DiscussionThread,
  conversation?: {
    readonly parts: readonly unknown[];
    readonly usage?: unknown;
    readonly streaming: boolean;
  },
): Snapshot<ReviewThread> {
  const usage =
    conversation?.usage === undefined
      ? thread.usage
      : Schema.decodeUnknownSync(sessionSnapshotSchema.fields.usage)(conversation.usage);
  const snapshot = {
    ...thread,
    parts: messageSnapshots(
      (conversation?.parts ?? thread.parts).map((part) =>
        Schema.decodeUnknownSync(uiPartSchema)(part),
      ),
    ),
    streaming: conversation?.streaming ?? false,
  };
  if (usage !== undefined) Object.assign(snapshot, { usage });
  // SAFETY: every ReviewThread field is populated from validated Discussion and UiPart values.
  return snapshot as Snapshot<ReviewThread>;
}

function assertUnique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`${label} collision`);
}
