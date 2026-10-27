import { Schema } from "effect";

/** Sender-authored content, distinct from the user-role input carrying it to Pi. */
export const AgentUpdateSource = Schema.Struct({
  title: Schema.String,
  href: Schema.String,
});
export interface AgentUpdateSource extends Schema.Schema.Type<typeof AgentUpdateSource> {}

export const AgentUpdate = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  source: AgentUpdateSource,
});
export interface AgentUpdate extends Schema.Schema.Type<typeof AgentUpdate> {}
