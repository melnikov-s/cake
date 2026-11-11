import { Schema } from "effect";
import { AgentSessionStatus } from "./agent-session-list";
import { SessionPurpose } from "./session-purpose";
import { SessionContextMetadata } from "../conversations/session-context-metadata";

/** Canonical session-list data. Agent text is a projection, not the backend return value. */
export const SessionRoster = Schema.Struct({
  total: Schema.Int,
  offset: Schema.Int,
  nextOffset: Schema.NullOr(Schema.Int),
  sampledAt: Schema.Number,
  sessions: Schema.Array(
    Schema.Struct({
      sessionId: Schema.String,
      title: Schema.String,
      purpose: Schema.optionalKey(SessionPurpose),
      projectName: Schema.optionalKey(Schema.String),
      projectPath: Schema.optionalKey(Schema.String),
      status: AgentSessionStatus,
      resolved: Schema.optionalKey(Schema.Boolean),
      outcome: Schema.optionalKey(Schema.String),
      contextMetadata: Schema.optionalKey(SessionContextMetadata),
    }),
  ),
});
