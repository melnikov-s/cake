import { MessageReference } from "../conversations/message-reference";
import { Schema } from "effect";
import { ResultDelivery } from "../conversations/result-delivery";
import { ExplicitCakeModelSelection } from "../model-presets/cake-model-selection";

/** Explicit task outcomes are never inferred from idle or successful model generation. */
export const SessionTaskOutcome = Schema.Literals(["completed", "blocked", "failed"]);

/** "result" is a substantive final answer whose task outcome was not explicitly declared. */
export const SessionCompletionReport = Schema.Struct({
  resultKind: Schema.optionalKey(Schema.Literals(["ready", "investigation"])),
  resultMessageRef: Schema.optionalKey(MessageReference),
  outcome: Schema.Literals(["result", "completed", "blocked", "failed"]),
  text: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000))),
});
export interface SessionCompletionReport extends Schema.Schema.Type<
  typeof SessionCompletionReport
> {}

/** Latest outcome of a session Cake Chat launched, projected for status surfaces. */
/** `stopped` is deliberate or result-less; `interrupted` is an unexpected abort (crash, restart). */
export const CakeChatLaunchStatus = Schema.Literals([
  "completed",
  "failed",
  "blocked",
  "stopped",
  "interrupted",
]);
export type CakeChatLaunchStatus = typeof CakeChatLaunchStatus.Type;

/**
 * Execution failures/stops describe the latest turn, not the launch's historical report.
 * Explicit task blockers are separate from successful model execution.
 */
export function currentSessionOutcome(
  latestTurnOutcome: "complete" | "failed" | "aborted" | undefined,
  reportedStatus: CakeChatLaunchStatus | undefined,
): CakeChatLaunchStatus | undefined {
  if (latestTurnOutcome === "failed") return "failed";
  if (latestTurnOutcome === "aborted")
    return reportedStatus === "interrupted" ? "interrupted" : "stopped";
  if (latestTurnOutcome === "complete")
    return reportedStatus === "blocked" ? "blocked" : "completed";
  return reportedStatus;
}
export const CakeChatLaunchReport = Schema.Struct({
  status: CakeChatLaunchStatus,
  summary: Schema.String.check(Schema.isMaxLength(500)),
  reportedAt: Schema.String,
});
export interface CakeChatLaunchReport extends Schema.Schema.Type<typeof CakeChatLaunchReport> {}

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
  resultDelivery: Schema.optionalKey(ResultDelivery),
  worktreeName: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/)),
  ),
});
