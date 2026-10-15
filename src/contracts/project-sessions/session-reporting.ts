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

/**
 * How a result Cake Chat asked for reaches Cake Chat.
 * - digest (default): never starts a Cake Chat turn; a compact status line is attached to the
 *   user's next Cake Chat message. A `blocked` report escalates to immediate delivery.
 * - interrupt: delivered immediately and starts a Cake Chat turn (held while the user is composing).
 * - silent: no result is owed or delivered; Cake Chat learns the status only by asking.
 */
export const CakeChatReportPolicy = Schema.Literals(["digest", "interrupt", "silent"]);
export type CakeChatReportPolicy = typeof CakeChatReportPolicy.Type;
/** Delivery modes for an owed result; silent means no result is owed. */
export const CakeChatReportDelivery = Schema.Literals(["digest", "interrupt"]);
export type CakeChatReportDelivery = typeof CakeChatReportDelivery.Type;

/**
 * One mapping from Cake Chat's request fields to the per-message obligation.
 * `report` wins; an explicit `expectsResponse: false` means silent; otherwise digest.
 */
export function cakeChatReportPolicy(input: {
  readonly report?: CakeChatReportPolicy;
  readonly expectsResponse?: boolean;
}) {
  const report = input.report ?? (input.expectsResponse === false ? "silent" : "digest");
  return { report, expectsResponse: report !== "silent" };
}

/** Latest outcome of a session Cake Chat launched, projected for status surfaces. */
export const CakeChatLaunchStatus = Schema.Literals(["completed", "failed", "blocked", "stopped"]);
export type CakeChatLaunchStatus = typeof CakeChatLaunchStatus.Type;
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
  report: Schema.optionalKey(CakeChatReportPolicy),
  worktreeName: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/)),
  ),
});
