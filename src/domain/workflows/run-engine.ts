import {
  Cause,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  Ref,
  PubSub,
  Schedule,
  Schema,
  Semaphore,
  SubscriptionRef,
} from "effect";
import {
  WorkflowStepId,
  type WorkflowError,
  type WorkflowAgentInput,
  type WorkflowProgram,
  type WorkflowRunId,
  type WorkflowStep,
} from "../../contracts/workflows/workflow-data";
import { jsonObjectSchema, type JsonValue } from "../../contracts/serialization/json-contract";
import type { ExplicitCakeModelSelection } from "../../contracts/model-presets/cake-model-selection";
import type { SessionUsage } from "../../contracts/conversations/session-contract";
import { WorkflowSandbox } from "../../services/pi/WorkflowSandbox";
import { WorkflowWorkers } from "../../services/pi/WorkflowWorkers";
import { WorkflowSupervisor } from "../../services/workflows/WorkflowSupervisor";
import { ApplicationState } from "../../services/storage/ApplicationState";
import type { WorkflowRunStorage } from "../../services/storage/WorkflowRunStorage";
import { PiModels } from "../../services/pi/PiModels";
import { resolveCakeModelSelection } from "../model-presets/cake-model-selection";
import { getRun, updateRun, workflowError } from "./run-state";

const emptyUsage = (): SessionUsage => ({
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0,
});
function addUsage(left: SessionUsage | undefined, right: SessionUsage): SessionUsage {
  const value = left ?? emptyUsage();
  return {
    tokens: {
      input: value.tokens.input + right.tokens.input,
      output: value.tokens.output + right.tokens.output,
      cacheRead: value.tokens.cacheRead + right.tokens.cacheRead,
      cacheWrite: value.tokens.cacheWrite + right.tokens.cacheWrite,
      total: value.tokens.total + right.tokens.total,
    },
    cost: value.cost + right.cost,
  };
}
function usageDelta(current: SessionUsage, previous: SessionUsage): SessionUsage {
  return {
    tokens: {
      input: Math.max(0, current.tokens.input - previous.tokens.input),
      output: Math.max(0, current.tokens.output - previous.tokens.output),
      cacheRead: Math.max(0, current.tokens.cacheRead - previous.tokens.cacheRead),
      cacheWrite: Math.max(0, current.tokens.cacheWrite - previous.tokens.cacheWrite),
      total: Math.max(0, current.tokens.total - previous.tokens.total),
    },
    cost: Math.max(0, current.cost - previous.cost),
  };
}
function sortJson(value: JsonValue): JsonValue {
  if (Schema.is(jsonObjectSchema)(value))
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  if (Array.isArray(value)) return value.map((item: JsonValue) => sortJson(item));
  return value;
}
function canonical(value: WorkflowAgentInput | ExplicitCakeModelSelection): string {
  return JSON.stringify(
    sortJson(Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(value)))),
  );
}
const updateStep = (
  steps: readonly WorkflowStep[],
  id: WorkflowStepId,
  change: (step: WorkflowStep) => WorkflowStep,
) => steps.map((step) => (step.id === id ? change(step) : step));

/** Script calls, not conversation turns, drive this execution. Checkpoints precede answers. */
export const executeRun = Effect.fn("Workflows.executeRun")(function* (
  id: WorkflowRunId,
  program: WorkflowProgram,
  previousSteps: readonly WorkflowStep[],
) {
  const supervisor = yield* WorkflowSupervisor;
  const workers = yield* WorkflowWorkers;
  const sandbox = yield* WorkflowSandbox;
  const application = yield* ApplicationState;
  const models = yield* PiModels;
  const context = yield* Effect.context<WorkflowSupervisor | WorkflowRunStorage>();
  const bind = <A>(
    effect: Effect.Effect<A, WorkflowError, WorkflowSupervisor | WorkflowRunStorage>,
  ) => Effect.provide(effect, context);
  const initial = (yield* SubscriptionRef.get(supervisor.state)).get(id);
  if (!initial)
    return yield* workflowError("execute", "not-found", "Workflow disappeared before execution.");
  const owner = initial.checkpoint.run.ownerSessionId;
  const execution = initial.checkpoint.run.execution;
  const ordinal = yield* Ref.make(0);
  const replayValid = yield* Ref.make(true);
  const permits = yield* Semaphore.make(initial.checkpoint.run.maxConcurrentAgents);
  const allocations = yield* Semaphore.make(1);
  const live = () => getRun({ sessionId: owner, runId: id });
  const mutate = (change: Parameters<typeof updateRun>[1]) =>
    updateRun(id, (checkpoint) => {
      if (checkpoint.run.execution !== execution)
        throw workflowError(
          "activity",
          "invalid-state",
          "Previous execution cannot update the current run.",
        );
      return change(checkpoint);
    });
  const agent = Effect.fn("Workflows.agent")(function* (
    input: WorkflowAgentInput,
    failureMode: "throw" | "null",
  ) {
    const allocation = yield* allocations.withPermits(1)(
      Effect.gen(function* () {
        if (input.options.schema !== undefined)
          yield* workers.validateOutputSchema(input.options.schema);
        const index = yield* Ref.getAndUpdate(ordinal, (value) => value + 1);
        if (index >= 1000)
          return yield* workflowError(
            "agent",
            "limit",
            "A workflow can schedule at most 1000 agents.",
          );
        const modelSelection = yield* Effect.try({
          try: () =>
            resolveCakeModelSelection(
              input.options.model,
              // Omission uses the run's start-time default snapshot, not the live default.
              { presets: application.snapshot().modelPresets },
              initial.checkpoint.inheritedModel,
            ),
          catch: (error) => workflowError("model", "invalid-input", String(error)),
        });
        const model = yield* models
          .resolve(modelSelection)
          .pipe(Effect.mapError((error) => workflowError("model", "invalid-input", error.message)));
        const previous = previousSteps[index];
        const canReplay = yield* Ref.modify(replayValid, (valid) => {
          const matches =
            valid &&
            previous?.status === "complete" &&
            previous.result !== undefined &&
            canonical(previous.input) === canonical(input) &&
            canonical(previous.resolvedModel) === canonical(model) &&
            previous.workingDirectory === initial.checkpoint.run.workingDirectory;
          return [matches, matches] as const;
        });
        const stepId =
          previous?.id ??
          (yield* Schema.decodeUnknownEffect(WorkflowStepId)(crypto.randomUUID()).pipe(
            Effect.orDie,
          ));
        const newStep: WorkflowStep = {
          id: stepId,
          ordinal: index,
          execution,
          input,
          workingDirectory: initial.checkpoint.run.workingDirectory,
          status: canReplay ? "complete" : "queued",
          attempt: 1,
          resolvedModel: model,
        };
        if (canReplay && previous?.result !== undefined) {
          Object.assign(newStep, { result: previous.result });
          if (previous.usage !== undefined) Object.assign(newStep, { usage: previous.usage });
        }
        yield* mutate((checkpoint) => {
          const step: WorkflowStep = { ...newStep };
          const phase = checkpoint.run.phases.at(-1);
          if (phase !== undefined) Object.assign(step, { phase });
          return {
            ...checkpoint,
            run: {
              ...checkpoint.run,
              steps: [...checkpoint.run.steps, step].sort((a, b) => a.ordinal - b.ordinal),
            },
          };
        });
        return { model, previous, canReplay, stepId };
      }),
    );
    const { model, previous, canReplay, stepId } = allocation;
    if (canReplay && previous?.result !== undefined) return previous.result;
    const attempts = yield* Ref.make(0);
    const attempt = Effect.fn("Workflows.workerAttempt")(function* () {
      const current = yield* live();
      yield* current.schedulingGate.await;
      return yield* permits.withPermits(1)(
        Effect.gen(function* () {
          yield* current.schedulingGate.await;
          const fresh = yield* live();
          const step = fresh.checkpoint.run.steps.find((item) => item.id === stepId);
          if (step?.status === "aborted") return { result: null };
          if (fresh.checkpoint.run.status === "paused")
            return yield* workflowError("admission", "invalid-state", "paused");
          const number = yield* Ref.updateAndGet(attempts, (value) => value + 1);
          if (number > 6)
            return yield* workflowError("agent", "worker", "Agent abandoned after 6 attempts.");
          yield* mutate((checkpoint) => {
            if (checkpoint.run.status === "paused")
              throw workflowError("admission", "invalid-state", "paused");
            return {
              ...checkpoint,
              run: {
                ...checkpoint.run,
                steps: updateStep(checkpoint.run.steps, stepId, (item) => ({
                  ...item,
                  status: "running",
                  attempt: number,
                })),
              },
            };
          });
          let lastUsage = emptyUsage();
          const recordUsage = (usage: SessionUsage | undefined) => {
            const delta = usage === undefined ? emptyUsage() : usageDelta(usage, lastUsage);
            if (usage !== undefined) lastUsage = usage;
            if (
              delta.tokens.total === 0 &&
              delta.tokens.input === 0 &&
              delta.tokens.output === 0 &&
              delta.tokens.cacheRead === 0 &&
              delta.tokens.cacheWrite === 0 &&
              delta.cost === 0
            )
              return Effect.void;
            return mutate((checkpoint) => ({
              ...checkpoint,
              run: {
                ...checkpoint.run,
                usage: addUsage(checkpoint.run.usage, delta),
                steps: updateStep(checkpoint.run.steps, stepId, (item) => ({
                  ...item,
                  usage: addUsage(item.usage, delta),
                })),
              },
            })).pipe(Effect.asVoid);
          };
          const target = { sessionId: owner, runId: id, stepId, execution };
          const result = yield* workers.run({
            target,
            attempt: number,
            input,
            workingDirectory: initial.checkpoint.run.workingDirectory,
            model,
            commonInstructions: initial.checkpoint.commonInstructions,
            onCreated: (reference) =>
              bind(
                mutate((checkpoint) => ({
                  ...checkpoint,
                  workers: [
                    ...checkpoint.workers,
                    { stepId, execution, attempt: number, reference },
                  ],
                })).pipe(Effect.asVoid),
              ),
            onActivity: (activity) =>
              activity.execution !== execution || activity.attempt !== number
                ? Effect.void
                : bind(
                    Effect.gen(function* () {
                      const current = yield* live();
                      if (current.checkpoint.run.execution !== execution)
                        return yield* workflowError(
                          "activity",
                          "invalid-state",
                          "Previous execution cannot update the current run.",
                        );
                      const step = current.checkpoint.run.steps.find(
                        (candidate) => candidate.id === stepId,
                      );
                      if (step?.attempt !== number) return;
                      yield* PubSub.publish(supervisor.activity, { runId: id, activity });
                      yield* recordUsage(activity.usage);
                    }),
                  ),
          });
          yield* recordUsage(result.usage);
          yield* mutate((checkpoint) => ({
            ...checkpoint,
            run: {
              ...checkpoint.run,
              steps: updateStep(checkpoint.run.steps, stepId, (item) => ({
                ...item,
                status: "complete",
                result: result.result,
              })),
            },
          }));
          return result;
        }),
      );
    });
    const scheduled = attempt().pipe(
      Effect.retry({
        schedule: Schedule.forever,
        while: (error) =>
          error.reason === "stalled" ||
          (error.operation === "admission" && error.message === "paused"),
      }),
    );
    // Manual restart interrupts only the keyed worker; the script call remains pending.
    const wait = Effect.fn("Workflows.awaitWorker")(function* (): Effect.fn.Return<
      JsonValue,
      WorkflowError,
      WorkflowSupervisor | WorkflowRunStorage
    > {
      const fiber = yield* FiberMap.run(initial.workers, stepId, scheduled);
      const exit = yield* Fiber.await(fiber);
      if (Exit.isSuccess(exit)) return exit.value.result;
      const current = yield* live();
      const step = current.checkpoint.run.steps.find((item) => item.id === stepId);
      if (
        Cause.hasInterrupts(exit.cause) &&
        step?.status === "queued" &&
        ["running", "paused"].includes(current.checkpoint.run.status)
      )
        return yield* wait();
      if (Cause.hasInterrupts(exit.cause) && step?.status === "aborted") return null;
      const failure = Cause.findErrorOption(exit.cause);
      if (failure._tag === "None") return yield* Effect.failCause(exit.cause);
      yield* mutate((checkpoint) => ({
        ...checkpoint,
        run: {
          ...checkpoint.run,
          steps: updateStep(checkpoint.run.steps, stepId, (item) => ({
            ...item,
            status: "error",
            error: failure.value.message,
          })),
        },
      }));
      if (failureMode === "null") return null;
      return yield* failure.value;
    });
    return yield* wait().pipe(Effect.ensuring(FiberMap.remove(initial.workers, stepId)));
  });
  return yield* sandbox.execute(program, {
    agent: (input, mode) => bind(agent(input, mode)),
    phase: (title) =>
      bind(
        mutate((checkpoint) => {
          if (checkpoint.run.phases.length >= 1000)
            throw workflowError("phase", "limit", "At most 1000 phases are allowed.");
          return {
            ...checkpoint,
            run: { ...checkpoint.run, phases: [...checkpoint.run.phases, title] },
          };
        }).pipe(Effect.asVoid),
      ),
    log: (message) =>
      bind(
        mutate((checkpoint) => ({
          ...checkpoint,
          run: { ...checkpoint.run, logs: [...checkpoint.run.logs, message].slice(-1000) },
        })).pipe(Effect.asVoid),
      ),
  });
});
