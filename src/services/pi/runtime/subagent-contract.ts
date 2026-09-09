import { Effect, Schema } from "effect";
import { CakeModelSelection } from "../../../domain/cake-model-selection";

const defaultKey = <S extends Schema.Top>(schema: S, value: S["Type"]) =>
  schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)));
const subagentProfileSchema = Schema.Literals(["scout", "planner", "reviewer", "worker"]);

export const subagentTaskSchema = Schema.Struct({
  task: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(262_144)),
  profile: defaultKey(subagentProfileSchema, "worker"),
  model: Schema.optionalKey(CakeModelSelection),
  instructions: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32_768))),
  maxDepth: defaultKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })), 0),
  retain: defaultKey(Schema.Boolean, false),
});
export type SubagentTaskInput = typeof subagentTaskSchema.Type;

export const parallelSubagentSchema = Schema.Struct({
  tasks: Schema.Array(subagentTaskSchema).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});
