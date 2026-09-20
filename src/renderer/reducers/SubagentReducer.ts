import { Schema } from "effect";
import { batch } from "r-state-tree";
import type {
  SubagentActivity as SubagentActivityValue,
  SubagentUpdate,
} from "../../domain/subagents/subagent-data";
import { conversationSnapshotSchema, uiPartSchema } from "../../ipc/session-contract";
import type { SubagentCatalog } from "../models/SubagentCatalog";
import { SubagentActivity } from "../models/SubagentActivity";

export function applySubagentUpdate(
  model: SubagentCatalog,
  sessionId: string,
  update: SubagentUpdate,
) {
  if (update.parentSessionId !== sessionId)
    throw new Error(`Subagent parent identity collision: ${sessionId}`);
  const before = relationshipSignature(model);
  batch(() => {
    if (update._tag === "Snapshot") {
      assertUnique(
        update.activities.map((activity) => activity.handleId),
        "Subagent handle ID",
      );
      const retained = new Set<string>(update.activities.map((activity) => activity.handleId));
      for (let index = model.activities.length - 1; index >= 0; index -= 1)
        if (!retained.has(model.activities[index]!.handleId)) model.activities.splice(index, 1);
      for (const activity of update.activities) upsertSubagentActivity(model, activity);
      for (let index = model.releasedHandleIds.length - 1; index >= 0; index -= 1)
        if (retained.has(model.releasedHandleIds[index]!)) model.releasedHandleIds.splice(index, 1);
      model.backgroundActive = update.backgroundActive;
    } else if (update._tag === "Activity") {
      upsertSubagentActivity(model, update.activity);
      const releasedIndex = model.releasedHandleIds.indexOf(update.activity.handleId);
      if (releasedIndex >= 0) model.releasedHandleIds.splice(releasedIndex, 1);
    } else if (update._tag === "Removed") {
      const index = model.activities.findIndex((activity) => activity.handleId === update.handleId);
      if (index >= 0) model.activities.splice(index, 1);
      if (!model.releasedHandleIds.includes(update.handleId))
        model.releasedHandleIds.push(update.handleId);
    } else model.backgroundActive = update.active;
    if (relationshipSignature(model) !== before) model.relationshipRevision += 1;
  });
}

function relationshipSignature(model: SubagentCatalog) {
  return model.activities
    .map(({ handleId, status, task }) => `${handleId}\u0000${status}\u0000${task}`)
    .sort()
    .join("\u0001");
}

function upsertSubagentActivity(model: SubagentCatalog, activity: SubagentActivityValue) {
  let target = model.activities.find((item) => item.handleId === activity.handleId);
  if (!target) {
    target = SubagentActivity.create({ handleId: activity.handleId });
    model.activities.push(target);
  }
  target.parentSessionId = activity.parentSessionId;
  target.anchorPartId = activity.anchorPartId;
  target.revision = activity.revision;
  target.task = activity.task;
  target.status = activity.status;
  target.resolvedModel = activity.resolvedModel;
  target.fastMode = activity.fastMode;
  target.streaming = activity.streaming;
  target.parts = activity.parts.map((part) => Schema.decodeUnknownSync(uiPartSchema)(part));
  target.usage =
    activity.usage === undefined
      ? undefined
      : Schema.decodeUnknownSync(conversationSnapshotSchema.fields.usage)(activity.usage);
  target.error = activity.error;
}

function assertUnique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`${label} collision`);
}
