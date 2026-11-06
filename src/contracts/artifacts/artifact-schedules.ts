import { Schema } from "effect";
import { AutomationSchedule } from "../automations/automation-data";
import { ArtifactLineageId } from "./artifact-lineage";

const Name = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
);

/** Stable identity belongs to the artifact, never to a renderer view or source revision. */
export const ArtifactScheduleIdentity = Schema.Struct({
  lineageId: ArtifactLineageId,
  name: Name,
});
export interface ArtifactScheduleIdentity extends Schema.Schema.Type<
  typeof ArtifactScheduleIdentity
> {}

export const ArtifactScheduleConfigureInput = Schema.Struct({
  ...ArtifactScheduleIdentity.fields,
  handler: Name,
  input: Schema.Json,
  schedule: AutomationSchedule,
});
export interface ArtifactScheduleConfigureInput extends Schema.Schema.Type<
  typeof ArtifactScheduleConfigureInput
> {}

/** Deterministic background work; no prompt, conversation, model, or Pi session. */
export const ArtifactSchedule = Schema.Struct({
  ...ArtifactScheduleConfigureInput.fields,
  paused: Schema.Boolean,
  nextScheduledAt: Schema.optionalKey(Schema.String),
  lastRunAt: Schema.optionalKey(Schema.String),
  lastOutcome: Schema.optionalKey(Schema.Literals(["completed", "failed"])),
  lastError: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_096))),
});
export interface ArtifactSchedule extends Schema.Schema.Type<typeof ArtifactSchedule> {}
