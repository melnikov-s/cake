import { Schema } from "effect";
import { CakeModelSelection } from "../../../domain/model-presets/cake-model-selection";
export const subagentTaskSchema = Schema.Struct({
  task: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(262_144)),
  model: Schema.optionalKey(CakeModelSelection),
  instructions: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32_768))),
});
export type SubagentTaskInput = typeof subagentTaskSchema.Type;

export const parallelSubagentSchema = Schema.Struct({
  tasks: Schema.Array(subagentTaskSchema).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});
