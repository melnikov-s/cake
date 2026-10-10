import { Schema } from "effect";

export const AgentAvailabilityState = Schema.Literals(["available", "reloading", "unavailable"]);
export type AgentAvailabilityState = typeof AgentAvailabilityState.Type;

export const AgentAvailabilityEntry = Schema.Struct({
  state: AgentAvailabilityState,
  reason: Schema.optionalKey(Schema.String),
});
export type AgentAvailabilityEntry = typeof AgentAvailabilityEntry.Type;

const WorkingDirectoryAgentAvailability = Schema.Struct({
  workingDirectory: Schema.String,
  availability: AgentAvailabilityEntry,
});

export const AgentAvailabilitySnapshot = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  global: AgentAvailabilityEntry,
  workingDirectories: Schema.Array(WorkingDirectoryAgentAvailability),
});
export type AgentAvailabilitySnapshot = typeof AgentAvailabilitySnapshot.Type;
