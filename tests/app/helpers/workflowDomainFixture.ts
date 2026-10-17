import { Context, Effect, Layer, Queue, Stream } from "effect";
import { acquireOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { makeHeadlessProjectSessionRuntimeMechanismTestLayer } from "../domain/projectSessionRuntimeTestLayer";
import {
  defaultApplicationState,
  defaultProjectWorkflow,
} from "../../../src/contracts/application/application-data";
import { WorkflowSandbox, type WorkflowScriptHost } from "../../../src/services/pi/WorkflowSandbox";
import {
  WorkflowWorkers,
  type WorkflowWorkerRequest,
  type WorkflowWorkerResult,
} from "../../../src/services/pi/WorkflowWorkers";
import { WorkflowScripts } from "../../../src/services/pi/WorkflowScripts";
import { WorkflowRunStorage } from "../../../src/services/storage/WorkflowRunStorage";
import { WorkflowSupervisorLive } from "../../../src/services/workflows/WorkflowSupervisorLive";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";
import { PiModels } from "../../../src/services/pi/PiModels";
import {
  makeCakeSessionRuntimesLayer,
  CakeSessionRuntimes,
} from "../../../src/services/pi/CakeSessionRuntimes";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import {
  checkpoint,
  model,
  makeMemoryWorkflowStorage,
  AgentControlTestLive,
} from "./workflowFixture";
import {
  makeRuntimeRecoveryStorageTestLayer,
  fakeRuntime,
  options,
  snapshot,
} from "./piRuntimeFixture";
import { familyStorageHarness } from "./familyStorageHarness";
import type { JsonValue } from "../../../src/contracts/serialization/json-contract";
import type {
  WorkflowError,
  WorkflowProgram,
} from "../../../src/contracts/workflows/workflow-data";

export interface WorkflowPlan {
  readonly run: (host: WorkflowScriptHost) => Effect.Effect<JsonValue | undefined, WorkflowError>;
  readonly worker?: (
    request: WorkflowWorkerRequest,
  ) => Effect.Effect<WorkflowWorkerResult, WorkflowError>;
  readonly profile?: "ProjectSession" | "CakeChatSession" | "DiscussionSession";
  readonly dynamicWorkflows?: boolean;
}
export const makeWorkflowDomainFixture = Effect.fn("WorkflowFixture.domain")(function* (
  plan: WorkflowPlan,
) {
  const memory = yield* makeMemoryWorkflowStorage();
  const assignments = yield* Queue.unbounded<WorkflowWorkerRequest>();
  const reports = yield* Queue.unbounded<string>();
  const programs = yield* Queue.unbounded<WorkflowProgram>();
  const executing: string[] = [];
  const disposed = yield* Queue.unbounded<string>();
  const scripts = new Map<string, WorkflowProgram>([
    ["/project/workflow.js", checkpoint().run.program],
  ]);
  const app = {
    ...defaultApplicationState(),
    experimentalFeatures: { dynamicWorkflows: plan.dynamicWorkflows ?? true },
    projects: [
      {
        path: "/project",
        name: "Project",
        sortOrder: 0,
        addedAt: "2026-01-01T00:00:00.000Z",
        lastOpenedAt: "2026-01-01T00:00:00.000Z",
        workflow: defaultProjectWorkflow(),
      },
    ],
  };
  const applicationContext = yield* Layer.build(
    ApplicationState.layer.pipe(
      Layer.provide(
        Layer.succeed(ApplicationStorage, {
          load: () => Effect.succeed({ state: app, source: "current" as const }),
          save: () => Effect.void,
        }),
      ),
    ),
  );
  const application = Context.get(applicationContext, ApplicationState);
  yield* application.initialize();
  const runtimes = makeCakeSessionRuntimesLayer({
    sessionIds: () => Stream.empty,
    catalog: () => Stream.empty,
    catalogEntry: () => Effect.succeed(undefined),
    inspect: () => Effect.succeed(undefined),
    changelog: () => Effect.succeed(""),
    createRuntime: (runtimeOptions) =>
      Effect.succeed({
        ...fakeRuntime(runtimeOptions, () => {
          Queue.offerUnsafe(disposed, runtimeOptions.sessionId ?? "");
        }),
        executingTurnIds: () => [...executing],
        snapshot: async () => ({
          ...snapshot,
          model: { provider: model.provider, id: model.modelId, name: "Test model" },
          fastMode: false,
        }),
        prompt: async (text) => {
          await Effect.runPromise(Queue.offer(reports, text));
        },
      }),
  }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer()));
  const layer = Layer.mergeAll(
    WorkflowSupervisorLive,
    AgentControlTestLive,
    makeHeadlessProjectSessionRuntimeMechanismTestLayer(),
    SessionCatalogChanges.layer,
    familyStorageHarness().layer,
    runtimes,
    Layer.succeed(WorkflowRunStorage, memory.service),
    Layer.succeed(WorkflowSandbox, {
      execute: (program, host) =>
        Queue.offer(programs, program).pipe(Effect.andThen(plan.run(host))),
    }),
    Layer.mock(WorkflowScripts, {
      read: (_location, path, args) => {
        const program = scripts.get(path);
        if (!program) return Effect.die("Missing test script");
        return Effect.succeed({ ...program, args: args ?? program.args });
      },
    }),
    Layer.mock(WorkflowWorkers, {
      validateOutputSchema: () => Effect.void,
      run: (request) =>
        request
          .onCreated({
            sessionId: "00000000-0000-4000-8000-000000000201",
            workingDirectory: request.workingDirectory,
          })
          .pipe(
            Effect.andThen(Queue.offer(assignments, request)),
            Effect.andThen(
              plan.worker ? plan.worker(request) : Effect.succeed({ result: request.input.prompt }),
            ),
          ),
      inspect: (_reference, target, attempt) =>
        Effect.succeed({
          stepId: target.stepId,
          execution: target.execution,
          attempt,
          streaming: false,
          parts: [
            {
              id: "worker-answer",
              kind: "text",
              role: "assistant",
              status: "complete",
              text: "Retained answer",
            },
          ],
        }),
    }),
    Layer.succeed(ApplicationState, application),
    Layer.mock(PiModels, { resolve: (selection) => Effect.succeed(selection) }),
    Layer.succeed(ProjectSessionConfiguration, {
      agentDirectory: "/agent",
      sessionDirectory: "/sessions",
      resolvedSessionDirectory: "/resolved",
    }),
    Layer.mock(SessionArchiveStorage, {
      resolvedProjectEntry: () => Effect.succeed(undefined),
      locate: () => Effect.succeed("active"),
    }),
    Layer.mock(ManagedWorktrees, { records: () => Effect.succeed([]) }),
  );
  const registerOwner = Effect.gen(function* () {
    if (plan.profile === undefined || plan.profile === "ProjectSession") {
      yield* (yield* CakeSessionRuntimes).acquire(
        yield* acquireOptions({
          sessionId: "session-1",
          newSession: false,
          location: {
            projectName: "Project",
            projectPath: "/project",
            workingDirectory: "/project",
            sessionDirectory: "/sessions",
            resolvedSessionDirectory: "/resolved",
          },
        }),
      );
      return;
    }
    yield* (yield* CakeSessionRuntimes).acquire({
      ...options({
        auxiliary: plan.profile === "DiscussionSession",
        globalControl:
          plan.profile === "CakeChatSession" ? { tools: [], invoke: async () => null } : undefined,
      }),
      profile: { _tag: plan.profile ?? "ProjectSession" },
    });
  });
  return {
    layer,
    application,
    assignments,
    reports,
    programs,
    scripts,
    records: memory.records,
    registerOwner,
    executing,
    disposed,
  };
});
