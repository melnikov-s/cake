import { Schema } from "effect";
import { applySnapshot, batch, type Snapshot } from "r-state-tree";
import {
  WorkflowCatalogUpdate,
  WorkflowRunUpdate,
  WorkflowWorkerActivity,
} from "../../contracts/workflows/workflow-data";
import type { WorkflowCatalog } from "../models/WorkflowCatalog";
import type { WorkflowRun } from "../models/WorkflowRun";
import { WorkflowStep } from "../models/WorkflowStep";

export function applyWorkflowCatalogUpdate(model: WorkflowCatalog, input: WorkflowCatalogUpdate) {
  const update = Schema.decodeUnknownSync(WorkflowCatalogUpdate)(input);
  const owner = update._tag === "Snapshot" ? update.ownerSessionId : update.run.ownerSessionId;
  if (owner !== model.sessionId) throw new Error(`Workflow owner identity collision: ${owner}`);
  if (update._tag !== "Snapshot" && update.revision <= model.revision) return;
  batch(() => {
    if (update._tag === "Snapshot") {
      if (
        new Set(update.runs.map((run) => run.id)).size !== update.runs.length ||
        update.runs.some((run) => run.ownerSessionId !== owner)
      )
        throw new Error("Workflow catalog identity collision");
      // Snapshot applies only the compact authority, never demand-loaded detail.
      applySnapshot(model, {
        sessionId: owner,
        revision: update.revision,
        runs: update.runs.map((run) => ({ ...run, id: String(run.id) })),
      });
    } else {
      const index = model.runs.findIndex((run) => run.id === update.run.id);
      if (index < 0) model.runs.push(update.run);
      else model.runs.splice(index, 1, update.run);
      model.revision = update.revision;
    }
  });
}

export function applyWorkflowWorkerActivity(model: WorkflowRun, input: WorkflowWorkerActivity) {
  const activity = Schema.decodeUnknownSync(WorkflowWorkerActivity)(input);
  const step = model.steps.find((candidate) => candidate.id === activity.stepId);
  if (
    !step ||
    activity.execution !== model.execution ||
    activity.execution !== step.execution ||
    activity.attempt !== step.attempt
  )
    return;
  step.activity = { ...activity, stepId: String(activity.stepId) };
}

export function applyWorkflowRunUpdate(model: WorkflowRun, input: WorkflowRunUpdate) {
  const update = Schema.decodeUnknownSync(WorkflowRunUpdate)(input);
  if (update._tag !== "Snapshot" && update.revision <= model.observationRevision) return;
  batch(() => {
    if (update._tag === "WorkerActivity") applyWorkflowWorkerActivity(model, update.activity);
    else {
      const run = update.run;
      if (run.id !== model.id || run.ownerSessionId !== model.ownerSessionId)
        throw new Error(`Workflow detail identity collision: ${run.id}`);
      if (new Set(run.steps.map((step) => step.id)).size !== run.steps.length)
        throw new Error("Workflow step identity collision");
      const activities = new Map(model.steps.map((step) => [step.id, step.activity]));
      if (update._tag === "Snapshot") {
        // SAFETY: the run schema has validated the entire JSON payload; r-state-tree's
        // Snapshot mapped type does not model recursive readonly JSON arrays correctly.
        applySnapshot(model, {
          ...run,
          id: String(run.id),
          result: run.result,
          error: run.error,
          usage: run.usage,
          loaded: true,
          observationRevision: update.revision,
          phases: [...run.phases],
          logs: [...run.logs],
          steps: run.steps.map((step) => ({
            ...step,
            id: String(step.id),
            phase: step.phase,
            result: step.result,
            error: step.error,
            usage: step.usage,
            activity: undefined,
          })),
        } as Snapshot<WorkflowRun>);
      } else {
        const { steps, phases, logs, ...fields } = run;
        Object.assign(model, fields, {
          loaded: true,
          result: run.result,
          error: run.error,
          usage: run.usage,
        });
        model.phases.splice(0, model.phases.length, ...phases);
        model.logs.splice(0, model.logs.length, ...logs);
        const retained = new Set(steps.map((step) => String(step.id)));
        for (let index = model.steps.length - 1; index >= 0; index--)
          if (!retained.has(model.steps[index]!.id)) model.steps.splice(index, 1);
        for (const step of steps) {
          let target = model.steps.find((candidate) => candidate.id === step.id);
          if (!target) {
            target = WorkflowStep.create({ id: String(step.id) });
            model.steps.push(target);
          }
          Object.assign(target, step, {
            phase: step.phase,
            result: step.result,
            error: step.error,
            usage: step.usage,
            activity: undefined,
          });
        }
      }
      for (const activity of activities.values())
        if (activity)
          applyWorkflowWorkerActivity(
            model,
            Schema.decodeUnknownSync(WorkflowWorkerActivity)(activity),
          );
    }
    model.observationRevision = update.revision;
  });
}

export function unloadWorkflowRun(model: WorkflowRun) {
  applySnapshot(model, {
    id: model.id,
    ownerSessionId: model.ownerSessionId,
    loaded: false,
    observationRevision: -1,
    program: undefined,
    steps: [],
    phases: [],
    logs: [],
    result: undefined,
    error: undefined,
  });
}
