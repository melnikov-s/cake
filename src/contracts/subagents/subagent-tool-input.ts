import { Schema } from "effect";
import { ParentContinuation } from "../conversations/parent-continuation";
import { CakeModelSelection } from "../model-presets/cake-model-selection";
import { inputRefsSchema } from "../conversations/task-input";
import { messageRefsSchema } from "../conversations/message-reference";
export const subagentTaskSchema = Schema.Struct({
  todoId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))).annotate({
    description:
      "Existing open outcome to-do; preserve findings here and carry this ID into implementation/review. Omit for established unlinked investigation behavior.",
  }),
  continuation: Schema.optionalKey(ParentContinuation),
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
  allowMutations: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Cake Chat only: true permits explicitly user-authorized operational changes, including non-project file/config edits without projectPath. State the exact task, backend-host absolute targets, limits and checks; clarify ambiguous remote/local machine requests first. This flag is not authorization by itself or a sandbox; never touch Cake/Pi managed settings or credentials. Repository implementation still requires a Project Session. Omit or false keeps investigation-only policy; existing handles cannot gain mutation mode.",
    }),
  ),
  model: Schema.optionalKey(CakeModelSelection),
  instructions: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32_768))),
});
export type SubagentTaskInput = typeof subagentTaskSchema.Type;

export const parallelSubagentSchema = Schema.Struct({
  tasks: Schema.Array(subagentTaskSchema).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});
