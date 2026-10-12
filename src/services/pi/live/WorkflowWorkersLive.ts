import { Deferred, Effect, Layer, Queue, Schedule, Schema } from "effect";
import {
  WorkflowError,
  type WorkflowOutputSchema,
  type WorkflowWorkerTarget,
} from "../../../contracts/workflows/workflow-data";
import { ExplicitCakeModelSelection } from "../../../contracts/model-presets/cake-model-selection";
import { SubagentEnvironment } from "../../subagents/SubagentEnvironment";
import { CakeSessionRuntimes } from "../CakeSessionRuntimes";
import { PiModels } from "../PiModels";
import {
  WorkflowWorkers,
  WorkflowWorkerReference,
  type WorkflowWorkerRequest,
} from "../WorkflowWorkers";
import { compileOutputSchema, validateAnswer } from "../runtime/workflows/output-validation";
import {
  activityFromSnapshot,
  workerError,
  workerTurn,
  type WorkerSettlement,
} from "../runtime/workflows/worker-turn";

/** Runtime/observer lifetime is one call; the private transcript remains owned by Pi. */
export const WorkflowWorkersLive = Layer.effect(
  WorkflowWorkers,
  Effect.gen(function* () {
    const sessions = yield* CakeSessionRuntimes;
    const models = yield* PiModels;
    const environment = yield* SubagentEnvironment;
    const validateOutputSchema = Effect.fn("WorkflowWorkers.validateOutputSchema")(
      (schema: WorkflowOutputSchema) => compileOutputSchema(schema).pipe(Effect.asVoid),
    );
    const run = Effect.fn("WorkflowWorkers.run")(function* (request: WorkflowWorkerRequest) {
      const schema = request.input.options.schema;
      const validator = schema === undefined ? undefined : yield* compileOutputSchema(schema);
      const selection = yield* Schema.decodeUnknownEffect(ExplicitCakeModelSelection)(
        request.model,
      ).pipe(workerError("model"));
      const model = yield* models.resolve(selection).pipe(
        Effect.mapError(
          (error) =>
            new WorkflowError({
              operation: "model",
              reason: "worker",
              message: `Requested model ${selection.provider}/${selection.modelId} is unavailable: ${error._tag}`,
            }),
        ),
      );
      const location = yield* environment
        .location(request.workingDirectory)
        .pipe(workerError("location"));
      const released = yield* Deferred.make<void>();
      let acquired = false;
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const settlements = yield* Queue.unbounded<WorkerSettlement>();
          const reference = yield* WorkflowWorkerReference.makeEffect({
            sessionId: crypto.randomUUID(),
            workingDirectory: location.workingDirectory,
          }).pipe(workerError("reference"));
          const handle = yield* sessions
            .acquire({
              profile: { _tag: "SubagentSession" },
              runtime: {
                cwd: location.workingDirectory,
                trusted: location.trusted,
                agentDir: location.agentDirectory,
                sessionDir: location.sessionDirectory,
                newSession: true,
                sessionId: reference.sessionId,
                auxiliary: true,
                auxiliaryProjectResources: true,
                tools: ["read", "bash", "edit", "write"],
                customTools: [],
                slashCommands: [],
                additionalSystemPrompt: [
                  "You are a private workflow worker. Complete the supplied assignment using the project context and relevant skills. Return your answer to the orchestration script; do not delegate, message a parent, or use Cake application controls. File changes are not rolled back by cancellation or retries.",
                  request.commonInstructions,
                  request.input.options.instructions,
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                requestUi: async () => undefined,
                fastMode: { get: () => model.fastMode, set: async () => undefined },
              },
              onTurnSettled: (event) => Queue.offer(settlements, event).pipe(Effect.asVoid),
              onRelease: Deferred.succeed(released, undefined).pipe(Effect.asVoid),
            })
            .pipe(workerError("acquire"));
          acquired = true;
          // The reference checkpoint must succeed before even the first billable prompt.
          yield* request.onCreated(reference);
          yield* handle.applyConfiguration(model).pipe(workerError("configure"));
          yield* Effect.addFinalizer(() =>
            handle.abort().pipe(
              workerError("abort"),
              Effect.andThen(handle.snapshot().pipe(workerError("snapshot"))),
              Effect.flatMap((snapshot) =>
                request.onActivity(activityFromSnapshot(request, snapshot)),
              ),
              Effect.orDie,
            ),
          );
          let prompt = validator
            ? `${request.input.prompt}\n\nReturn only one JSON value matching this JSON Schema, with no Markdown fences or commentary:\n${JSON.stringify(schema)}`
            : request.input.prompt;
          const answer = Effect.fn("WorkflowWorkers.answer")(function* () {
            const { snapshot, answer: text } = yield* workerTurn(
              handle,
              request,
              settlements,
              prompt,
            );
            if (text === undefined)
              return yield* new WorkflowError({
                operation: "answer",
                reason: "invalid-output",
                message: "Worker produced no final assistant text",
              });
            const result = validator ? yield* validateAnswer(text, validator) : text;
            return { result, ...(snapshot.usage ? { usage: snapshot.usage } : undefined) };
          });
          return yield* answer().pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                prompt = `The previous answer was invalid: ${error.message}. Return only a JSON value matching the original schema. Do not repeat completed file or tool work merely to reformat the answer.`;
              }),
            ),
            Effect.retry({
              schedule: Schedule.recurs(4),
              while: (error) => validator !== undefined && error.reason === "invalid-output",
            }),
          );
        }),
      ).pipe(
        // The detached Pi turn also holds a runtime lease. Scope release alone
        // is insufficient: wait until its final lease disposes the runtime too.
        Effect.ensuring(Effect.suspend(() => (acquired ? Deferred.await(released) : Effect.void))),
      );
    });
    const inspect = Effect.fn("WorkflowWorkers.inspect")(function* (
      reference: WorkflowWorkerReference,
      target: WorkflowWorkerTarget,
      attempt: number,
    ) {
      const parsed = yield* Schema.decodeUnknownEffect(WorkflowWorkerReference)(reference).pipe(
        workerError("inspect"),
      );
      const location = yield* environment
        .location(parsed.workingDirectory)
        .pipe(workerError("inspect"));
      const live = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* sessions.acquireSession(parsed.sessionId);
          return activityFromSnapshot({ target, attempt }, yield* handle.snapshot());
        }),
      ).pipe(Effect.option);
      if (live._tag === "Some") return live.value;
      const preview = yield* sessions
        .inspect({
          workingDirectory: parsed.workingDirectory,
          sessionDirectory: location.sessionDirectory,
          sessionId: parsed.sessionId,
        })
        .pipe(workerError("inspect"));
      return activityFromSnapshot(
        { target, attempt },
        { parts: [...preview.parts], streaming: false, usage: undefined },
      );
    });
    return WorkflowWorkers.of({ validateOutputSchema, run, inspect });
  }),
);
