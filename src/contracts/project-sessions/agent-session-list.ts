import { Schema } from "effect";
import { AgentListInput } from "../agent/agent-list-data";

const nonResolvedSessionStatus = Schema.Literals([
  "running",
  "needs-you",
  "failed",
  "interrupted",
  "stopped",
  "done",
  "idle",
  "unread",
  "draft",
]);
export const AgentSessionStatus = Schema.Literals([
  ...nonResolvedSessionStatus.literals,
  "resolved",
]);
export type AgentSessionStatus = typeof AgentSessionStatus.Type;

export const sessionListGuidance = [
  "Only non-resolved sessions are listed, including idle, Draft and done-but-unresolved sessions. Project callers default to their current project; Global Cake Chat defaults to all projects. Any caller can supply projectPath to target a project instead. Every row includes project identity. Filter by query/status/attentionOnly, then offset/limit (default 20, max 50).",
  "Rows: bare id, status, lifecycle (active/draft), execution outcome (- if unknown), tokens (estimated active context, K/M), cache (warm/expired?/?), age since recorded model activity, ttl (estimated remaining time; negative means elapsed). ? means unknown. Cache hints never prove a hit/miss. sessions.info supplies exact metadata and evidence.",
  "launchedByCakeChat selects your unresolved launches.",
  'projection: "workflow" lists only non-resolved launches owned by the invoking Cake Chat within the same project scope, grouped by working (including idle/unknown execution), waiting-for-input, ready-for-review/merge and blocked/stopped. Metadata only: no transcript/attachment reads, wakes or acknowledgments. Resolved history is never listed; use sessions.info for a known historical session or the UI history/search surfaces. Unknown execution facts remain unknown; done is not merge readiness. Use offset/limit for bounded pages.',
];
export const sessionListResult =
  "Compact text rows with one header and total; next=N appears only when another page exists. Workflow rows add task names, canonical session/result links, lifecycle/execution, input/blocker reason, brief outcome, result-decision state, recorded worktree/landing facts and next action. Working includes idle/unknown; ready means an explicit ready result, not verified merge readiness.";

export const AgentSessionListInput = Schema.Struct({
  ...AgentListInput.fields,
  projectPath: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)).annotate({
      description:
        "Target this project, overriding the caller’s default scope. Omit for the current project (project callers) or all projects (Global Cake Chat).",
    }),
  ),
  status: Schema.optionalKey(nonResolvedSessionStatus),
  launchedByCakeChat: Schema.optionalKey(Schema.Boolean),
  attentionOnly: Schema.optionalKey(Schema.Boolean),
  projection: Schema.optionalKey(
    Schema.Literal("workflow").annotate({
      description:
        "Select the invoking Cake Chat’s non-resolved launches within the selected project scope.",
    }),
  ),
});
export interface AgentSessionListInput extends Schema.Schema.Type<typeof AgentSessionListInput> {}
