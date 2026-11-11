import { Schema } from "effect";
import { SessionPurpose } from "./session-purpose";

export const workflowRosterGroups = [
  "working",
  "waiting-for-input",
  "ready-for-review/merge",
  "blocked/stopped",
] as const;
const group = Schema.Literals(workflowRosterGroups);
const row = Schema.Struct({
  sessionId: Schema.String,
  purpose: SessionPurpose,
  projectPath: Schema.String,
  title: Schema.String,
  group,
  execution: Schema.String,
  lifecycle: Schema.String,
  reason: Schema.String,
  result: Schema.String,
  outcome: Schema.String,
  decision: Schema.String,
  worktree: Schema.String,
  merge: Schema.String,
  next: Schema.String,
  date: Schema.String,
});
export const WorkflowRoster = Schema.Struct({
  projection: Schema.Literal("workflow"),
  total: Schema.Int,
  offset: Schema.Int,
  nextOffset: Schema.NullOr(Schema.Int),
  counts: Schema.Record(group, Schema.Int),
  // The coordinator's existing task-input policy may retain only safe identity metadata.
  sessions: Schema.Array(
    Schema.Union([row, Schema.Struct({ sessionId: Schema.String, title: Schema.String })]),
  ),
});
