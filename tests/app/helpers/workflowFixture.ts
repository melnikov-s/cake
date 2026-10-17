import { Effect, Layer, Option, Ref } from "effect";
import { PiSettings } from "../../../src/services/pi/PiSettings";
import { McpSettings } from "../../../src/services/pi/McpSettings";
import { WidgetPackages } from "../../../src/services/widgets/WidgetPackages";
import { SessionCoordination } from "../../../src/services/session-catalogs/SessionCoordination";
import { coordinationStorageHarness } from "./coordinationStorageHarness";
import {
  WorkflowRunId,
  WorkflowStepId,
  WorkflowError,
} from "../../../src/contracts/workflows/workflow-data";
import {
  WorkflowRunStorage,
  type WorkflowCheckpoint,
} from "../../../src/services/storage/WorkflowRunStorage";
import { WorkflowScripts } from "../../../src/services/pi/WorkflowScripts";
import { WorkflowSandbox } from "../../../src/services/pi/WorkflowSandbox";
import { WorkflowWorkers } from "../../../src/services/pi/WorkflowWorkers";
import { WorkflowSupervisorLive } from "../../../src/services/workflows/WorkflowSupervisorLive";
import { workflowSummary } from "../../../src/contracts/workflows/workflow-projection";

export const runId = WorkflowRunId.make("00000000-0000-4000-8000-000000000101");
export const stepId = WorkflowStepId.make("00000000-0000-4000-8000-000000000102");
export const target = { sessionId: "session-1", runId };
export const model = {
  provider: "test",
  modelId: "test-model",
  thinkingLevel: "off",
  fastMode: false,
} as const;
export const checkpoint = (): WorkflowCheckpoint => ({
  run: {
    id: runId,
    ownerSessionId: target.sessionId,
    projectPath: "/project",
    workingDirectory: "/project",
    program: {
      meta: { name: "test-run", description: "Test workflow" },
      source: `export const meta = { name: "test-run", description: "Test workflow" };\nreturn args;`,
      sourcePath: "/project/workflow.js",
      args: { task: "audit" },
    },
    status: "running",
    revision: 0,
    execution: 1,
    maxConcurrentAgents: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    phases: [],
    logs: [],
    steps: [],
  },
  inheritedModel: model,
  commonInstructions: "Project instructions",
  previousPrograms: [],
  workers: [],
  completionTurnIds: [],
  completionDelivery: "pending",
});
export const makeMemoryWorkflowStorage = Effect.fn("WorkflowFixture.storage")(function* () {
  const records = yield* Ref.make<ReadonlyMap<string, WorkflowCheckpoint>>(new Map());
  const service = WorkflowRunStorage.of({
    load: (id) =>
      Ref.get(records).pipe(Effect.map((values) => Option.fromUndefinedOr(values.get(id)))),
    list: (owner) =>
      Ref.get(records).pipe(
        Effect.map((values) =>
          [...values.values()]
            .filter((item) => owner === undefined || item.run.ownerSessionId === owner)
            .map((item) => workflowSummary(item.run)),
        ),
      ),
    save: (value, revision) =>
      Ref.modify(records, (values) => {
        const previous = values.get(value.run.id);
        if (revision === null ? previous !== undefined : previous?.run.revision !== revision)
          return [false, values] as const;
        return [true, new Map(values).set(value.run.id, value)] as const;
      }).pipe(
        Effect.flatMap((saved) =>
          saved
            ? Effect.void
            : Effect.fail(
                new WorkflowError({
                  operation: "save",
                  reason: "storage",
                  message: "revision conflict",
                }),
              ),
        ),
      ),
  });
  return { service, records };
});

export const AgentControlTestLive = Layer.mergeAll(
  SessionCoordination.layer.pipe(
    Layer.provide(Layer.suspend(() => coordinationStorageHarness().layer)),
  ),
  Layer.mock(PiSettings, {}),
  Layer.mock(McpSettings, {}),
  Layer.mock(WidgetPackages, { directory: "/test/widgets" }),
);

/** Ordinary session tests supply all new capabilities, failing loudly if unexpectedly invoked. */
export const WorkflowTestLive = Layer.mergeAll(
  WorkflowSupervisorLive,
  AgentControlTestLive,
  Layer.effect(
    WorkflowRunStorage,
    makeMemoryWorkflowStorage().pipe(Effect.map((fixture) => fixture.service)),
  ),
  Layer.mock(WorkflowSandbox, {}),
  Layer.mock(WorkflowScripts, {}),
  Layer.mock(WorkflowWorkers, {}),
);
