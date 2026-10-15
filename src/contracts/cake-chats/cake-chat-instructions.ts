import { Schema } from "effect";
import { CakeChatPreferences } from "../application/application-data";

export const CakeChatInstructions = Schema.Struct({
  instructions: CakeChatPreferences.fields.instructions,
});
export interface CakeChatInstructions extends Schema.Schema.Type<typeof CakeChatInstructions> {}

export const CakeChatInstructionsUpdate = Schema.Struct({
  expectedInstructions: CakeChatPreferences.fields.instructions,
  instructions: CakeChatPreferences.fields.instructions,
});
export interface CakeChatInstructionsUpdate extends Schema.Schema.Type<
  typeof CakeChatInstructionsUpdate
> {}

/** Permanent coordinator authority, not a Project Session or renderer control. */
export interface CakeChatInstructionsControl {
  get(signal: AbortSignal): Promise<CakeChatInstructions>;
  update(input: CakeChatInstructionsUpdate, signal: AbortSignal): Promise<CakeChatInstructions>;
}
