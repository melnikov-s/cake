import { Schema } from "effect";
import { ExplicitCakeModelSelection } from "../model-presets/cake-model-selection";

/** Explicit task outcomes are never inferred from idle or successful model generation. */
export const SessionTaskOutcome = Schema.Literals(["completed", "blocked", "failed"]);

/** "result" is a substantive final answer whose task outcome was not explicitly declared. */
export const SessionCompletionReport = Schema.Struct({
  outcome: Schema.Literals(["result", "completed", "blocked", "failed"]),
  text: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000))),
});
export interface SessionCompletionReport extends Schema.Schema.Type<
  typeof SessionCompletionReport
> {}

export const SessionRequester = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  kind: Schema.Literal("cake-chat"),
  title: Schema.String,
});
export interface SessionRequester extends Schema.Schema.Type<typeof SessionRequester> {}

/** Cake Chat's resolved application control input; caller identity is never model supplied. */
export const AgentProjectSessionCreate = Schema.Struct({
  workspacePath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  name: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
  initialPrompt: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000))),
  model: ExplicitCakeModelSelection,
  markdown: Schema.optionalKey(Schema.Boolean),
  worktreeName: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/)),
  ),
});
