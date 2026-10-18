import { MessageReference } from "./message-reference";
import { Schema } from "effect";

const CompletionKind = Schema.Literals(["ready", "blocked", "investigation"]);
export const CompletionDecisionState = Schema.Literals([
  "pending",
  "deferred",
  "handled",
  "dismissed",
]);
export type CompletionDecisionState = typeof CompletionDecisionState.Type;
const CompletionDecision = Schema.Literals(["review", "merge", "resolve", "next-step"]);
export const CompletionInboxItem = Schema.Struct({
  id: Schema.String,
  coordinatorSessionId: Schema.String,
  sessionId: Schema.String,
  title: Schema.String.check(Schema.isMaxLength(500)),
  resultMessageRef: Schema.optionalKey(MessageReference),
  references: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(6000))),
  summary: Schema.String.check(Schema.isMaxLength(500)),
  reportedAt: Schema.String,
  kind: CompletionKind,
  decisions: Schema.Array(CompletionDecision),
  state: CompletionDecisionState,
});
export interface CompletionInboxItem extends Schema.Schema.Type<typeof CompletionInboxItem> {}
export const CompletionInboxUpdate = Schema.Struct({
  id: Schema.String,
  state: CompletionDecisionState,
});
export interface CompletionInboxUpdate extends Schema.Schema.Type<typeof CompletionInboxUpdate> {}
