import { Schema } from "effect";
import { batch } from "r-state-tree";
import type {
  SubagentActivity as SubagentActivityValue,
  SubagentUpdate,
} from "../../domain/subagent-data";
import { sessionSnapshotSchema, uiPartSchema } from "../../ipc/session-contract";
import type { Session } from "../models/Session";
import { SubagentActivity } from "../models/SubagentActivity";

export function applySubagentUpdate(model: Session, sessionId: string, update: SubagentUpdate) {
  if (update.parentSessionId !== sessionId)
    throw new Error(`Subagent parent identity collision: ${sessionId}`);
  batch(() => {
    if (update._tag === "Snapshot") {
      assertUnique(
        update.activities.map((activity) => activity.handleId),
        "Subagent handle ID",
      );
      const retained = new Set<string>(update.activities.map((activity) => activity.handleId));
      for (let index = model.subagentActivities.length - 1; index >= 0; index -= 1)
        if (!retained.has(model.subagentActivities[index]!.handleId))
          model.subagentActivities.splice(index, 1);
      for (const activity of update.activities) upsertSubagentActivity(model, activity);
      for (let index = model.releasedSubagentHandleIds.length - 1; index >= 0; index -= 1)
        if (retained.has(model.releasedSubagentHandleIds[index]!))
          model.releasedSubagentHandleIds.splice(index, 1);
      model.backgroundWorkActive = update.backgroundActive;
    } else if (update._tag === "Activity") {
      upsertSubagentActivity(model, update.activity);
      const releasedIndex = model.releasedSubagentHandleIds.indexOf(update.activity.handleId);
      if (releasedIndex >= 0) model.releasedSubagentHandleIds.splice(releasedIndex, 1);
    } else if (update._tag === "Removed") {
      const index = model.subagentActivities.findIndex(
        (activity) => activity.handleId === update.handleId,
      );
      if (index >= 0) model.subagentActivities.splice(index, 1);
      if (!model.releasedSubagentHandleIds.includes(update.handleId))
        model.releasedSubagentHandleIds.push(update.handleId);
    } else model.backgroundWorkActive = update.active;
  });
}

function upsertSubagentActivity(model: Session, activity: SubagentActivityValue) {
  let target = model.subagentActivities.find((item) => item.handleId === activity.handleId);
  if (!target) {
    target = SubagentActivity.create({ handleId: activity.handleId });
    model.subagentActivities.push(target);
  }
  target.parentSessionId = activity.parentSessionId;
  target.anchorPartId = activity.anchorPartId;
  target.revision = activity.revision;
  target.task = activity.task;
  target.profile = activity.profile;
  target.status = activity.status;
  target.resolvedModel = activity.resolvedModel;
  target.fastMode = activity.fastMode;
  target.retained = activity.retained;
  target.streaming = activity.streaming;
  target.parts = activity.parts.map((part) => Schema.decodeUnknownSync(uiPartSchema)(part));
  target.usage =
    activity.usage === undefined
      ? undefined
      : Schema.decodeUnknownSync(sessionSnapshotSchema.fields.usage)(activity.usage);
  target.error = activity.error;
}

function assertUnique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`${label} collision`);
}
