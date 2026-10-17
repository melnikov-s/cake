import { Schema } from "effect";
import { AgentListInput } from "../agent/agent-list-data";

export const AgentSessionStatus = Schema.Literals([
  "running",
  "needs-you",
  "failed",
  "interrupted",
  "stopped",
  "done",
  "idle",
  "unread",
  "draft",
  "resolved",
]);
export type AgentSessionStatus = typeof AgentSessionStatus.Type;

export const AgentSessionListInput = Schema.Struct({
  ...AgentListInput.fields,
  projectPath: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  ),
  status: Schema.optionalKey(AgentSessionStatus),
  launchedByCakeChat: Schema.optionalKey(Schema.Boolean),
  attentionOnly: Schema.optionalKey(Schema.Boolean),
});
export interface AgentSessionListInput extends Schema.Schema.Type<typeof AgentSessionListInput> {}
