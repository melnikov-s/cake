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

export const sessionListGuidance = [
  "Global Cake Chat discovers all projects; every other caller is limited to its project. projectPath only narrows that scope. Filter by query/status/attentionOnly, then offset/limit (default 20, max 50).",
  "Rows: bare id, status, tokens (estimated active context, K/M), cache (warm/expired?/?), age since recorded model activity, ttl (estimated remaining time; negative means elapsed). ? means unknown. Cache hints never prove a hit/miss. sessions.info supplies exact metadata and evidence.",
  "launchedByCakeChat selects your unresolved launches.",
];
export const sessionListResult =
  "Compact text rows with one header and total; next=N appears only when another page exists.";

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
