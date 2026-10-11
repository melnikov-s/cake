import type {
  WorkflowRun,
  WorkflowRunId,
  WorkflowStepId,
  WorkflowWorkerActivity,
} from "../../src/contracts/workflows/workflow-data";

const workflowRunId = "5a440a2e-f7cc-4779-9cc4-fd36a343034c";
const workflowStepId = "4d6c98da-c1a2-4687-a7a4-74714eccffbe";
export const workflowSource =
  'export const meta = { name: "audit-auth", description: "Audit route authentication", phases: ["Discover", "Review"] };\nawait phase("Review");\nreturn await agent(`Audit ${args.scope}`);\n';

/** Coherent persisted authority records shared by renderer and hidden Electron fixtures. */
export function workflowRunFixture(
  options: { ownerSessionId?: string; projectPath?: string; status?: WorkflowRun["status"] } = {},
): WorkflowRun {
  const status = options.status ?? "running";
  const terminal = !["running", "paused", "stopping"].includes(status);
  const path = options.projectPath ?? "/project";
  return {
    // SAFETY: fixed UUIDv4 fixture IDs are validated by the receiving run schema.
    id: workflowRunId as WorkflowRunId,
    ownerSessionId: options.ownerSessionId ?? "workflow-session",
    projectPath: path,
    workingDirectory: path,
    status,
    revision: 1,
    execution: 1,
    maxConcurrentAgents: 4,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    program: {
      meta: {
        name: "audit-auth",
        description: "Audit route authentication",
        phases: ["Discover", "Review"],
      },
      source: workflowSource,
      sourcePath: `${path}/.cake/workflows/audit-auth.js`,
      args: { scope: "routes/auth" },
    },
    phases: ["Discover", "Review"],
    logs: ["Discovered two route groups."],
    steps: [
      {
        // SAFETY: this fixed UUIDv4 is validated at the run projection boundary.
        id: workflowStepId as WorkflowStepId,
        ordinal: 0,
        execution: 1,
        phase: "Review",
        input: {
          prompt: "Audit routes/auth and cite supported findings.",
          options: { label: "Auth routes", schema: { type: "object" } },
        },
        workingDirectory: path,
        status: status === "complete" ? "complete" : terminal ? "error" : "running",
        attempt: 2,
        resolvedModel: {
          provider: "fixture",
          modelId: "fixture-model",
          thinkingLevel: "off",
          fastMode: false,
        },
        ...(status === "complete"
          ? { result: { findings: ["Verified route guard"] } }
          : terminal
            ? { error: "Worker interrupted before finishing coverage" }
            : {}),
      },
    ],
    ...(status === "complete"
      ? { result: { report: "Authentication audit complete" } }
      : status === "interrupted"
        ? { error: "Execution interrupted; relaunch explicitly to continue" }
        : {}),
  };
}

export function workflowActivityFixture(): WorkflowWorkerActivity {
  return {
    // SAFETY: this fixed UUIDv4 is validated at the activity projection boundary.
    stepId: workflowStepId as WorkflowStepId,
    execution: 1,
    attempt: 2,
    streaming: false,
    parts: [
      {
        id: "workflow-tool",
        kind: "tool",
        name: "read",
        input: JSON.stringify({ path: "routes/auth.ts" }),
        output: "export const guard = requireAuth;",
        state: "success",
      },
      {
        id: "workflow-answer",
        kind: "text",
        role: "assistant",
        text: "Verified the route guard against the source.",
        status: "complete",
      },
    ],
  };
}
