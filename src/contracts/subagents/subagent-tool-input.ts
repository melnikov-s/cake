import { Schema } from "effect";
import { CakeModelSelection } from "../model-presets/cake-model-selection";
import { inputRefsSchema } from "../conversations/task-input";
import { messageRefsSchema } from "../conversations/message-reference";
export const subagentTaskSchema = Schema.Struct({
  task: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(262_144)),
  projectPath: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)).annotate({
      description:
        "Cake Chat only: exact registered project root for project-aware investigation. Omit for general research without repository context.",
    }),
  ),
  inputRefs: Schema.optionalKey(
    inputRefsSchema.annotate({
      description:
        "Exact attachment IDs selected from attachments.list. Forward references without reading their contents; omitted means no attachments are shared.",
    }),
  ),
  messageRefs: Schema.optionalKey(
    messageRefsSchema.annotate({
      description:
        "Exact Cake message links selected for this worker. Forward unchanged without reading their bodies first.",
    }),
  ),
  model: Schema.optionalKey(CakeModelSelection),
  instructions: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32_768))),
});
export type SubagentTaskInput = typeof subagentTaskSchema.Type;

export const parallelSubagentSchema = Schema.Struct({
  tasks: Schema.Array(subagentTaskSchema).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});
