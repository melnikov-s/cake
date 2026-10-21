import { Schema } from "effect";
import { CakeModelSelection } from "../model-presets/cake-model-selection";
import { ResultDelivery } from "../conversations/result-delivery";

export const projectSessionCreateInputSchema = Schema.Struct({
  name: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
  initialPrompt: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000))),
  model: Schema.optionalKey(CakeModelSelection),
  resultDelivery: Schema.optionalKey(ResultDelivery),
  worktreeName: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/)),
  ),
});
export type ProjectSessionCreateInput = typeof projectSessionCreateInputSchema.Type;
