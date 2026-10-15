import { Schema } from "effect";

/** Evidence from the final assistant message of the Pi run that consumed an input. */
export const PiTurnResult = Schema.Struct({
  stopReason: Schema.String,
  text: Schema.String,
  errorMessage: Schema.optionalKey(Schema.String),
  /**
   * Session whose input the final assistant message answers. Absent when the
   * run's latest conversational input was typed locally (or is otherwise
   * unattributed), so that answer belongs to the local user, not a requester.
   */
  respondsToSessionId: Schema.optionalKey(Schema.String),
});
export interface PiTurnResult extends Schema.Schema.Type<typeof PiTurnResult> {}

/** Empty output, tool-use tails and acknowledgment-only turns are not result handoffs. */
export const substantiveTurnResult = (result: PiTurnResult | undefined): string | undefined => {
  if (result?.stopReason !== "stop") return undefined;
  const text = result.text.trim();
  if (
    text.length < 20 ||
    /^(thanks|thank you|acknowledged|confirmed|received|got it|done|ok(?:ay)?)[.!\s]*$/i.test(text)
  )
    return undefined;
  return text.slice(0, 100_000);
};

/**
 * A run's final answer becomes an implicit result handoff only when it answers
 * the requester. One Pi run can consume later local or third-party inputs; its
 * final text then addresses them and must never be forwarded to the requester.
 */
export const implicitTurnResultFor = (
  result: PiTurnResult | undefined,
  requesterSessionId: string,
): string | undefined =>
  result?.respondsToSessionId === requesterSessionId ? substantiveTurnResult(result) : undefined;
