import { Schema } from "effect";

/** Private-subagent continuation; session launch/send uses ResultDelivery instead. */
export const ParentContinuation = Schema.Literals(["none", "resume"]).annotate({
  description:
    'Choose "none" to deliver a result without starting a parent LLM turn; choose "resume" when the parent must inspect it and continue dependent work or explain failure. Both modes require a result. Links never decide continuation. Resume uses the normal parent queue, not a concurrent or steering turn.',
});
export type ParentContinuation = typeof ParentContinuation.Type;
