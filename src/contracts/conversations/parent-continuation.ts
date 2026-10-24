import { Schema } from "effect";
import { replyOrNotificationRule } from "./result-delivery";

/** Private-subagent continuation; session launch/send uses ResultDelivery instead. */
export const ParentContinuation = Schema.Literals(["none", "resume"]).annotate({
  description: `Defaults to "resume" (reply): the result starts a normal queued parent turn. "none" (notification) puts the quiet result in the pending batch. ${replyOrNotificationRule} Both modes require a result. Links never decide continuation. Resume uses the normal parent queue, not a concurrent or steering turn.`,
});
export type ParentContinuation = typeof ParentContinuation.Type;
