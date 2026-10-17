import type { WorkflowControl } from "../../contracts/workflows/workflow-agent-control";
import { Schema } from "effect";
import {
  WorkflowListInput,
  WorkflowSavedListInput,
  WorkflowSavedTarget,
  WorkflowRelaunchInput,
  WorkflowRunTarget,
  WorkflowSaveInput,
  WorkflowStartInput,
  WorkflowWorkerTarget,
} from "../../contracts/workflows/workflow-data";

import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";
import { workflowAuthoringReference } from "./workflow-authoring";

/** Project-owned execution is explicit even when called from permanent Cake Chat. */
export function createCakeWorkflowOperations(control: WorkflowControl): CakeOperationDefinition[] {
  const definitions = [
    [
      "propose",
      "Offer Run workflow / Continue normally with the frozen script and phases; start only if the user chooses workflow.",
      WorkflowStartInput,
    ],
    [
      "start",
      "Start a script-driven background workflow owned by a Project Session.",
      WorkflowStartInput,
    ],
    [
      "list",
      "List workflow identity/name/status; filter status/query and page with offset/limit (20 default, 50 maximum). Use inspect for detail.",
      WorkflowListInput,
    ],
    [
      "inspect",
      "Read the frozen script, inputs, phases and step results of a run.",
      WorkflowRunTarget,
    ],
    ["pause", "Hold new worker admission; let active workers finish.", WorkflowRunTarget],
    [
      "resume",
      "Continue scheduling a paused run without duplicating active work.",
      WorkflowRunTarget,
    ],
    [
      "stop",
      "Cancel queued work and interrupt active workers, retaining completed results.",
      WorkflowRunTarget,
    ],
    [
      "relaunch",
      "Replay a stopped or interrupted run, reusing only its matching successful prefix.",
      WorkflowRelaunchInput,
    ],
    ["stopWorker", "Cancel one worker without stopping the whole workflow.", WorkflowWorkerTarget],
    [
      "restartWorker",
      "Restart an active worker from its assignment within six total attempts.",
      WorkflowWorkerTarget,
    ],
    ["inspectWorker", "Inspect a worker's Pi-owned activity and result.", WorkflowWorkerTarget],
    [
      "saved",
      "List saved script paths/names/locations; filter location/query and page with offset/limit (20 default, 50 maximum). Use inspect-saved for detail.",
      WorkflowSavedListInput,
    ],
    [
      "inspect-saved",
      "Read one saved script's frozen source, metadata and phases by exact path.",
      WorkflowSavedTarget,
    ],
    ["save", "Save the run's frozen script as a reusable workflow.", WorkflowSaveInput],
  ] as const;
  const operations: CakeOperationDefinition[] = definitions.map(([name, summary, inputSchema]) => ({
    command: `workflows.${name}`,
    topic: "workflows",
    summary,
    available: () => control.isEnabled(),
    inputSchema,
    guidance: [
      "When suggesting script orchestration in normal conversation, prepare the script then call workflows.propose: it presents the interactive execution choice and starts the frozen program only after Run workflow. Continue normally returns choice normal: continue agent-led work without launching a workflow. Cancellation starts nothing. Never infer acceptance from your own text or replace this surface with a conversational yes/no question.",
      "An explicit user request to use a workflow already chooses execution: call workflows.start directly, without redundant confirmation. After choosing workflow, do not ask for script, phase, worker, retry or tool approvals. There is no permanent dynamic mode or permission system.",
      "Request workflows.authoring before writing a workflow. The script coordinates agents; it has no direct filesystem, shell, network or module loading.",
      "Execution belongs to the explicitly targeted Project Session, never Cake Chat or a discussion. Intermediate results go to the script; one final report returns to the owner.",
      "Workers share the owner's Working Directory. Separate agent context does not isolate files. Avoid parallel overlapping edits; cancellation and retries do not undo changes.",
    ],
    examples: [],
    result: "The requested workflow result or control receipt.",
    execute: (input, context) =>
      control.invoke(
        `workflows.${name}`,
        Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(input),
        context.signal,
      ),
  }));
  operations.push({
    command: "workflows.authoring",
    topic: "workflows",
    summary: "Read the script-writing API and workflow behavior reference.",
    available: () => control.isEnabled(),
    inputSchema: Schema.Struct({}),
    examples: [{}],
    result: "Workflow authoring reference.",
    execute: async () => workflowAuthoringReference,
  });
  return operations;
}
