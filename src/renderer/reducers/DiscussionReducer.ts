import { Option, Schema } from "effect";
import { applySnapshot, batch, type Snapshot } from "r-state-tree";
import type { DiscussionCatalogUpdate } from "../../domain/application/catalog-data";
import type {
  DiscussionSessionUpdate,
  DiscussionThread,
} from "../../domain/discussion-sessions/discussion-session-data";
import { sessionSnapshotSchema, uiPartSchema } from "../../ipc/session-contract";
import { ReviewThread } from "../models/ReviewThread";
import type { Session } from "../models/Session";
import { applyPartUpdate, messageSnapshots, removePart } from "./SessionPartReducer";

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
  // A catalog row carries no conversation; keep the model each thread already
  // learned from its sidecar snapshot.
  const snapshots = threads.map((thread) =>
    discussionSnapshot(
      thread,
      undefined,
      model.reviewThreads.find((candidate) => candidate.id === thread.id),
    ),
  );
  const retained = new Set(snapshots.map((thread) => thread.id));
  batch(() => {
    for (let index = model.reviewThreads.length - 1; index >= 0; index -= 1)
      if (!retained.has(model.reviewThreads[index]!.id)) model.reviewThreads.splice(index, 1);
    for (const snapshot of snapshots) {
      const existing = model.reviewThreads.find((thread) => thread.id === snapshot.id);
      if (existing) applySnapshot(existing, snapshot);
      else model.reviewThreads.push(ReviewThread.create(snapshot));
    }
    const order = new Map(snapshots.map((thread, index) => [thread.id, index]));
    model.reviewThreads.sort((left, right) => order.get(left.id)! - order.get(right.id)!);
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
      applyPartUpdate(model.parts, Schema.decodeUnknownSync(uiPartSchema)(event.part), model.id);
    else if (event._tag === "PartRemoved") removePart(model.parts, event.partId);
    else if (event._tag === "StreamingChanged") model.streaming = event.streaming;
  });
}

function decodeThreadModel(value: unknown): ReviewThread["model"] {
  const decoded = Option.getOrUndefined(
    Schema.decodeUnknownOption(sessionSnapshotSchema.fields.model)(value),
  );
  return decoded
    ? { provider: decoded.provider, modelId: decoded.id, name: decoded.name }
    : undefined;
}

function decodeThreadThinkingLevel(value: unknown): ReviewThread["thinkingLevel"] {
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(sessionSnapshotSchema.fields.thinkingLevel)(value),
  );
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
    readonly model?: unknown;
    readonly thinkingLevel?: string;
    readonly streaming: boolean;
  },
  current?: Pick<ReviewThread, "model" | "thinkingLevel">,
): Snapshot<ReviewThread> {
  const usage = Schema.decodeUnknownSync(sessionSnapshotSchema.fields.usage)(
    conversation?.usage ?? thread.usage,
  );
  // The sidecar's model arrives only with a conversation snapshot; an update
  // without one keeps what the thread already knows.
  const model = conversation ? decodeThreadModel(conversation.model) : current?.model;
  const thinkingLevel = conversation
    ? decodeThreadThinkingLevel(conversation.thinkingLevel)
    : current?.thinkingLevel;
  return {
    ...thread,
    usage,
    model,
    thinkingLevel,
    parts: messageSnapshots(
      (conversation?.parts ?? thread.parts).map((part) =>
        Schema.decodeUnknownSync(uiPartSchema)(part),
      ),
      thread.id,
    ),
    streaming: conversation?.streaming ?? false,
  };
}

function assertUnique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`${label} collision`);
}
