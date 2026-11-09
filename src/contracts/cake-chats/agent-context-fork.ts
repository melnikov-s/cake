import { Schema } from "effect";
import { ResultDelivery } from "../conversations/result-delivery";
import { inputRefsSchema } from "../conversations/task-input";
import { messageRefsSchema } from "../conversations/message-reference";

export const AgentContextFork = Schema.Struct({
  todoId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
  inputRefs: Schema.optionalKey(inputRefsSchema),
  messageRefs: Schema.optionalKey(messageRefsSchema),
  workspacePath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  initialPrompt: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100000)),
  entryId: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  worktreeName: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/)),
  resultDelivery: Schema.optionalKey(ResultDelivery),
});
export interface AgentContextFork extends Schema.Schema.Type<typeof AgentContextFork> {}
