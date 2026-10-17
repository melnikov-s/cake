import { Schema } from "effect";

/** Result presentation and the obligation to answer are separate from dependent parent work. */
export const ParentContinuation = Schema.Literals(["none", "resume"]).annotate({
  description:
    'Choose "none" to deliver a result without starting a parent LLM turn; choose "resume" when the parent must inspect it and continue dependent work or explain failure. Both modes require a result. Links never decide continuation. Resume uses the normal parent queue, not a concurrent or steering turn.',
});
export type ParentContinuation = typeof ParentContinuation.Type;

export const parentContinuationGuidance =
  'Choose continuation: "none" for a result/report without a parent LLM turn, or "resume" when dependent parent work must inspect the result and continue or explain failure. Both request a result, even with silent/false; for no result obligation, omit continuation and choose silent/false instead. Resume bypasses digest/link-only deferral and queues behind active parent work, never steers it. Presentation as a link does not change the choice.';
