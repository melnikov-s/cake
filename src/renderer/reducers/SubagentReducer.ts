import { Schema } from "effect";
import { batch } from "r-state-tree";
import type {
  SubagentActivity as SubagentActivityValue,
  SubagentUpdate,
} from "../../contracts/subagents/subagent-data";
import {
  conversationSnapshotSchema,
  uiPartSchema,
} from "../../contracts/conversations/session-contract";
import type { SubagentCatalog } from "../models/SubagentCatalog";
import { SubagentActivity } from "../models/SubagentActivity";

export function applySubagentUpdate(
  model: SubagentCatalog,
  sessionId: string,
  update: SubagentUpdate,
) {
  if (update.parentSessionId !== sessionId)
    throw new Error(`Subagent parent identity collision: ${sessionId}`);
  batch(() => {
    if (update._tag === "Snapshot") {
      model.loaded = true;
      model.observationError = undefined;
      assertUnique(
        update.activities.map((activity) => activity.handleId),
        "Subagent handle ID",
      );
      const retained = new Set<string>(update.activities.map((activity) => activity.handleId));
      for (let index = model.activities.length - 1; index >= 0; index -= 1)
        if (!retained.has(model.activities[index]!.handleId)) model.activities.splice(index, 1);
      for (const activity of update.activities) upsertSubagentActivity(model, activity);
      model.backgroundActive = update.backgroundActive;
    } else if (update._tag === "Activity") {
      upsertSubagentActivity(model, update.activity);
    } else if (update._tag === "Removed") {
      // Resource disposal does not erase the last observed outcome or live history.
      // A later authoritative snapshot supplies Pi-backed released history.
      if (!model.releasedHandleIds.includes(update.handleId))
        model.releasedHandleIds.push(update.handleId);
    } else model.backgroundActive = update.active;
  });
}

function upsertSubagentActivity(model: SubagentCatalog, activity: SubagentActivityValue) {
  const releasedIndex = model.releasedHandleIds.indexOf(activity.handleId);
  if (activity.released && releasedIndex < 0) model.releasedHandleIds.push(activity.handleId);
  else if (!activity.released && releasedIndex >= 0)
    model.releasedHandleIds.splice(releasedIndex, 1);
  let target = model.activities.find((item) => item.handleId === activity.handleId);
  if (!target) {
    target = SubagentActivity.create({ handleId: activity.handleId });
    model.activities.push(target);
  }
  target.parentSessionId = activity.parentSessionId;
  target.anchorPartId = activity.anchorPartId;
  target.revision = activity.revision;
  target.task = activity.task;
  target.projectPath = activity.projectPath;
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
  target.failurePhase = activity.failurePhase;
}

function assertUnique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`${label} collision`);
}
