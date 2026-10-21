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
  "Rows: bare id, status, lifecycle (active/draft/resolved), execution outcome (- if unknown), tokens (estimated active context, K/M), cache (warm/expired?/?), age since recorded model activity, ttl (estimated remaining time; negative means elapsed). ? means unknown. Cache hints never prove a hit/miss. sessions.info supplies exact metadata and evidence.",
  "launchedByCakeChat selects your unresolved launches.",
  'projection: "workflow" lists only launches owned by the invoking Cake Chat, grouped by working (including idle/unknown), waiting-for-input, ready-for-review/merge, blocked/stopped and resolved. Metadata only: no transcript/attachment reads, wakes or acknowledgments. includeResolved adds resolved history (off by default). Unknown facts remain unknown; done is not merge readiness. Use offset/limit for bounded pages.',
];
export const sessionListResult =
  "Compact text rows with one header and total; next=N appears only when another page exists. Workflow rows add task names, canonical session/result links, lifecycle/execution, input/blocker reason, brief outcome, result-decision state, recorded worktree/landing facts and next action. Working includes idle/unknown; ready means an explicit ready result, not verified merge readiness.";

export const AgentSessionListInput = Schema.Struct({
  ...AgentListInput.fields,
  projectPath: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  ),
  status: Schema.optionalKey(AgentSessionStatus),
  launchedByCakeChat: Schema.optionalKey(Schema.Boolean),
  attentionOnly: Schema.optionalKey(Schema.Boolean),
  projection: Schema.optionalKey(Schema.Literal("workflow")),
  includeResolved: Schema.optionalKey(Schema.Boolean),
});
export interface AgentSessionListInput extends Schema.Schema.Type<typeof AgentSessionListInput> {}
