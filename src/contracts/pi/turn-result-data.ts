import { Schema } from "effect";

/** Evidence from the final assistant message of the Pi run that consumed an input. */
export const PiTurnResult = Schema.Struct({
  stopReason: Schema.String,
  text: Schema.String,
  errorMessage: Schema.optionalKey(Schema.String),
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
