import { Schema } from "effect";
import { ArtifactLineageId } from "../artifacts/artifact-lineage";
import { AutomationId, AutomationRun } from "../automations/automation-data";

export const activityKinds = [
  "notification",
  "agent-action",
  "session-created",
  "merge",
  "resolution",
  "automation",
] as const;
export const ActivityKind = Schema.Literals(activityKinds);
export type ActivityKind = typeof ActivityKind.Type;

const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const optionalText = (max: number) => Schema.optionalKey(text(max));

export const ActivityNotice = Schema.Struct({
  id: text(1_024),
  kind: Schema.Literals(["notification", "agent-action"]),
  title: text(512),
  detail: optionalText(4_096),
  projectPath: optionalText(4_096),
  sessionId: optionalText(256),
  tone: Schema.optionalKey(Schema.Literals(["info", "success", "warning", "error"])),
});
export interface ActivityNotice extends Schema.Schema.Type<typeof ActivityNotice> {}

export const ActivityCursor = Schema.Struct({ id: ActivityNotice.fields.id, at: text(40) });
export interface ActivityCursor extends Schema.Schema.Type<typeof ActivityCursor> {}

export const ActivityEntry = Schema.Struct({
  ...ActivityNotice.fields,
  kind: ActivityKind,
  at: ActivityCursor.fields.at,
  automationId: Schema.optionalKey(AutomationId),
  artifactLineageId: Schema.optionalKey(ArtifactLineageId),
  automationRun: Schema.optionalKey(AutomationRun),
  trigger: optionalText(512),
  outcome: optionalText(128),
  sourceSessionId: optionalText(256),
  sourceMessageId: optionalText(256),
});
export interface ActivityEntry extends Schema.Schema.Type<typeof ActivityEntry> {}

export const ActivityQuery = Schema.Struct({
  projectPath: Schema.optionalKey(Schema.NullOr(text(4_096))),
  kind: Schema.optionalKey(ActivityKind),
  before: Schema.optionalKey(ActivityCursor),
});
export interface ActivityQuery extends Schema.Schema.Type<typeof ActivityQuery> {}

export const ActivityPage = Schema.Struct({
  entries: Schema.Array(ActivityEntry),
  next: Schema.optionalKey(ActivityCursor),
});
export interface ActivityPage extends Schema.Schema.Type<typeof ActivityPage> {}

export class ActivityHistoryError extends Schema.TaggedError<ActivityHistoryError>()(
  "ActivityHistoryError",
  { message: Schema.String },
) {}

export const activityPageSize = 40;
