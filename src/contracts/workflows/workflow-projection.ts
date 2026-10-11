import type { WorkflowRun, WorkflowRunSummary } from "./workflow-data";

/** Compact, transcript-free projection shared by storage and domain observations. */
export function workflowSummary(run: WorkflowRun): WorkflowRunSummary {
  const summary: WorkflowRunSummary = {
    id: run.id,
    ownerSessionId: run.ownerSessionId,
    meta: run.program.meta,
    status: run.status,
    revision: run.revision,
    total: run.steps.length,
    queued: run.steps.filter((step) => step.status === "queued").length,
    active: run.steps.filter((step) => step.status === "running").length,
    complete: run.steps.filter((step) => step.status === "complete").length,
    failed: run.steps.filter((step) => step.status === "error").length,
    aborted: run.steps.filter((step) => step.status === "aborted").length,
  };
  const phase = run.phases.at(-1);
  if (phase !== undefined) Object.assign(summary, { phase });
  if (run.usage !== undefined) Object.assign(summary, { usage: run.usage });
  if (run.error !== undefined) Object.assign(summary, { error: run.error });
  return summary;
}
