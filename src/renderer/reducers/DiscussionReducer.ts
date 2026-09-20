import { Schema } from "effect";
import { applySnapshot, batch, type Snapshot } from "r-state-tree";
import type { DiscussionCatalogUpdate } from "../../domain/application/catalog-data";
import type { DiscussionThread } from "../../domain/discussion-sessions/discussion-session-data";
import { uiPartSchema } from "../../ipc/session-contract";
import { ReviewThread } from "../models/ReviewThread";
import type { DiscussionCatalog } from "../models/DiscussionCatalog";
import { messageSnapshots } from "./SessionPartReducer";

/**
 * Applies the parent's Cake-owned Discussion catalog. Rows carry thread
 * metadata and a persisted preview only; the live sidecar conversation is a
 * separately observed `Conversation` Model.
 */
export function applyDiscussionCatalogUpdate(
  model: DiscussionCatalog,
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
  // Validate every row before mutating the collection.
  const snapshots = threads.map(discussionSnapshot);
  const retained = new Set(snapshots.map((thread) => thread.id));
  batch(() => {
    for (let index = model.threads.length - 1; index >= 0; index -= 1)
      if (!retained.has(model.threads[index]!.id)) model.threads.splice(index, 1);
    for (const snapshot of snapshots) {
      const existing = model.threads.find((thread) => thread.id === snapshot.id);
      if (existing) applySnapshot(existing, snapshot);
      else model.threads.push(ReviewThread.create(snapshot));
    }
    const order = new Map(snapshots.map((thread, index) => [thread.id, index]));
    model.threads.sort((left, right) => order.get(left.id)! - order.get(right.id)!);
    model.relationshipRevision += 1;
  });
}

function discussionSnapshot(thread: DiscussionThread): Snapshot<ReviewThread> {
  return {
    id: thread.id,
    workingDirectory: thread.workingDirectory,
    parentSessionId: thread.parentSessionId,
    sidecarSessionId: thread.sidecarSessionId,
    anchor: thread.anchor,
    parts: messageSnapshots(
      thread.parts.map((part) => Schema.decodeUnknownSync(uiPartSchema)(part)),
      thread.id,
    ),
    status: thread.status,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    resolvedAt: thread.resolvedAt,
  };
}

function assertUnique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`${label} collision`);
}
