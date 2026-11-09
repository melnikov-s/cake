import { Schema } from "effect";
import { ProjectSessionSummary } from "./project-session-data";

/** Background attention/routing facts, never list titles, message counts or transcript metadata. */
export const ProjectSessionSignal = Schema.Struct({
  sessionId: Schema.String,
  projectPath: Schema.String,
  workingDirectory: Schema.String,
  running: Schema.Boolean,
  workingStartedAt: Schema.optionalKey(Schema.Number),
  unread: Schema.Boolean,
  recoveryIssue: Schema.optionalKey(Schema.String),
  latestTurnOutcome: Schema.optionalKey(Schema.Literals(["complete", "failed", "aborted"])),
  familyParentSessionId: Schema.optionalKey(Schema.String),
  cakeChatLaunch: ProjectSessionSummary.fields.cakeChatLaunch,
  familyChildSessionIds: Schema.optionalKey(Schema.Array(Schema.String)),
});
export interface ProjectSessionSignal extends Schema.Schema.Type<typeof ProjectSessionSignal> {}

export const ProjectSessionSignalsUpdate = Schema.TaggedUnion({
  Snapshot: { sessions: Schema.Array(ProjectSessionSignal) },
  Upserted: { session: ProjectSessionSignal },
  Removed: { sessionId: Schema.String },
  TitleChanged: { sessionId: Schema.String, title: Schema.String },
});
export type ProjectSessionSignalsUpdate = Schema.Schema.Type<typeof ProjectSessionSignalsUpdate>;
