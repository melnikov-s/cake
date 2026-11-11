import { Schema } from "effect";
import { ResultDelivery } from "../conversations/result-delivery";
import { SessionPurpose } from "./session-purpose";
import { sessionTargetDescription } from "./session-reference";

export const SessionPurposeSetInput = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)).annotate({
    description: sessionTargetDescription,
  }),
  purpose: SessionPurpose,
  /** user→delegated only: how the caller, as new owner, receives in-flight results. */
  resultDelivery: Schema.optionalKey(ResultDelivery),
});
export interface SessionPurposeSetInput extends Schema.Schema.Type<typeof SessionPurposeSetInput> {}

/** One retired obligation: the result this session owed before becoming a User Session. */
const RetiredSessionReport = Schema.Struct({
  turnId: Schema.String,
  ownerSessionId: Schema.String,
  resultDelivery: Schema.optionalKey(ResultDelivery),
  /** The owner was told the report was dropped; false when the actor is the owner itself. */
  noticed: Schema.Boolean,
});

export const SessionPurposeOutput = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("sessions.set-purpose"),
  sessionId: Schema.String,
  purpose: SessionPurpose,
  previousPurpose: SessionPurpose,
  changed: Schema.Boolean,
  /** Live runtime activity at conversion; conversion never stops or acquires it. */
  running: Schema.Boolean,
  retiredReports: Schema.Array(RetiredSessionReport),
  owner: Schema.optionalKey(
    Schema.Struct({ sessionId: Schema.String, resultDelivery: ResultDelivery }),
  ),
  /** In-flight turns whose results now go to the owner. */
  adoptedTurnIds: Schema.Array(Schema.String),
  /** Awaiting auto-merge declarations canceled by moving to User. */
  canceledAutoMergeIds: Schema.Array(Schema.String),
});
export interface SessionPurposeOutput extends Schema.Schema.Type<typeof SessionPurposeOutput> {}

export const sessionPurposeSetDefinition = {
  command: "sessions.set-purpose",
  topic: "sessions",
  summary: "Switch a Project Session between User and Delegated",
  guidance: [
    "Idempotent: an unchanged purpose returns changed: false and does nothing else. Never stops, acquires or steers running work; permissions and routing are unchanged.",
    'purpose: "user" retires every owed result report (returned in retiredReports), sends each other owner a short FYI that its report was dropped, and cancels awaiting auto-merges: User Sessions never auto-merge. The session moves to My sessions.',
    'purpose: "delegated" makes the caller the owner: results of currently running turns go to the caller (resultDelivery, default notification; ignore adopts nothing). The session leaves My sessions and, when owned by its Project Chat, becomes eligible for that project\'s auto-merge. While idle, send work with sessions.send to receive results.',
    "Targets any Project Session. Global/Project Chats and Side Chats have no purpose and are refused.",
  ],
  examples: [
    { input: { sessionId: "target-session-id", purpose: "user" } },
    {
      input: { sessionId: "target-session-id", purpose: "delegated", resultDelivery: "reply" },
      description: "Take ownership and receive the running result as a continuation.",
    },
  ],
  result:
    "Target identity, previous and committed purpose, changed, running, retired reports, owner, adopted in-flight turns and canceled auto-merges.",
} as const;
