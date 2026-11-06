import Ajv, { type ValidateFunction } from "ajv";
import { Effect, Exit, Layer, Option, Schema, Scope, ScopedCache, Semaphore } from "effect";
import type { ArtifactLineageId } from "../../contracts/artifacts/artifact-lineage";
import {
  ArtifactRuntimeError,
  type ArtifactRuntimeTarget,
} from "../../contracts/artifacts/artifact-runtime";
import {
  ArtifactRuntimeDescriptor,
  type ArtifactRuntimeTool,
} from "../../contracts/artifacts/artifact-runtime-descriptor";
import { ArtifactStorage } from "../storage/ArtifactStorage";
import { ClientEvents } from "../clients/ClientEvents";
import { makeArtifactRuntimeWorker } from "../pi/live/ArtifactRuntimeWorker";
import { ArtifactRuntime, type ArtifactRuntimeHost } from "./ArtifactRuntime";

const failure = (operation: string, cause: unknown) =>
  new ArtifactRuntimeError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });
interface CompiledTool {
  readonly definition: ArtifactRuntimeTool;
  readonly input: ValidateFunction;
  readonly output: ValidateFunction;
}
const compile = Effect.fn("ArtifactRuntime.compile")(function* (
  descriptor: ArtifactRuntimeDescriptor,
) {
  const decoded = yield* Schema.decodeUnknownEffect(ArtifactRuntimeDescriptor)(descriptor).pipe(
    Effect.mapError((cause) => failure("definitions", cause)),
  );
  return yield* Effect.try({
    try: () => {
      const ajv = new Ajv({ strict: false, allErrors: true, validateSchema: true });
      return decoded.tools.map((definition): CompiledTool => ({
        definition,
        input: ajv.compile(definition.inputSchema),
        output: ajv.compile(definition.outputSchema),
      }));
    },
    catch: (cause) => failure("definitions", cause),
  });
});
const validate = Effect.fn("ArtifactRuntime.validate")(function* (
  schema: ValidateFunction,
  value: Schema.Json,
  operation: string,
) {
  if (!schema(value)) return yield* failure(operation, new Ajv().errorsText(schema.errors));
});

/**
 * Backend-scoped resources, lazily keyed by artifact identity. Each artifact serializes calls,
 * lifecycle events and revision replacement. A running call finishes on its resolved revision;
 * the next admitted call reloads changed source. Unmount does not release the worker.
 */
export const ArtifactRuntimeLive = Layer.effect(
  ArtifactRuntime,
  Effect.gen(function* () {
    const storage = yield* ArtifactStorage;
    const clientEvents = yield* ClientEvents;
    let boundHost: ArtifactRuntimeHost | undefined;
    const host: ArtifactRuntimeHost = {
      invokeCommand: Effect.fn("ArtifactRuntime.invokeCommand")(function* (input) {
        if (!boundHost) return yield* failure("host", "Artifact runtime Cake host is not bound");
        return yield* boundHost.invokeCommand(input);
      }),
    };
    const controllers = yield* ScopedCache.make({
      capacity: Number.MAX_SAFE_INTEGER,
      lookup: Effect.fn("ArtifactRuntime.controller")(function* () {
        const semaphore = yield* Semaphore.make(1);
        const owner = yield* Effect.scope;
        let lastError: string | undefined;
        const record = <A>(effect: Effect.Effect<A, ArtifactRuntimeError>) =>
          effect.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                lastError = undefined;
              }),
            ),
            Effect.tapError((error) =>
              Effect.sync(() => {
                lastError = error.message;
              }),
            ),
          );
        let current:
          | {
              target: ArtifactRuntimeTarget;
              scope: Scope.Closeable;
              worker: Effect.Success<ReturnType<typeof makeArtifactRuntimeWorker>>;
            }
          | undefined;
        yield* Effect.addFinalizer(() =>
          current ? Scope.close(current.scope, Exit.void) : Effect.void,
        );
        const stop = Effect.fn("ArtifactRuntime.controller.stop")(function* (
          event: "stop" | "delete" = "stop",
          callingSessionId?: string,
        ) {
          const previous = current;
          current = undefined;
          if (previous) {
            if (!previous.worker.isRunning()) {
              yield* Scope.close(previous.scope, Exit.void);
              return;
            }
            yield* previous.worker
              .send({
                kind: "lifecycle",
                name: event,
                input: null,
                ...(callingSessionId === undefined ? null : { callingSessionId }),
              })
              .pipe(Effect.ensuring(Scope.close(previous.scope, Exit.void)));
          }
        });
        const ensure = Effect.fn("ArtifactRuntime.controller.ensure")(function* (
          target: ArtifactRuntimeTarget,
          callingSessionId?: string,
        ) {
          if (current?.target.revision === target.revision && current.worker.isRunning())
            return current;
          if (current) yield* stop("stop", callingSessionId);
          yield* compile(target.runtime);
          const scope = yield* Scope.fork(owner);
          const worker = yield* makeArtifactRuntimeWorker(target, host, callingSessionId).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.provideService(ArtifactStorage, storage),
            Effect.provideService(ClientEvents, clientEvents),
            Effect.onError(() => Scope.close(scope, Exit.void)),
          );
          current = { target, scope, worker };
          lastError = undefined;
          return current;
        });
        return {
          semaphore,
          ensure,
          stop,
          record,
          peek: () => current,
          lastError: () => current?.worker.lastError() ?? lastError,
        };
      }),
    });
    const status = Effect.fn("ArtifactRuntime.status")(function* (lineageId: ArtifactLineageId) {
      const cached = yield* ScopedCache.getOption(controllers, lineageId);
      const current = Option.isSome(cached) ? cached.value.peek() : undefined;
      return {
        lineageId,
        revision: current?.target.revision ?? null,
        running: current?.worker.isRunning() ?? false,
        lastError: Option.isSome(cached) ? (cached.value.lastError() ?? null) : null,
      };
    });
    const stop = Effect.fn("ArtifactRuntime.stop")(function* (
      lineageId: ArtifactLineageId,
      event: "stop" | "delete" = "stop",
      callingSessionId?: string,
    ) {
      const cached = yield* ScopedCache.getOption(controllers, lineageId);
      if (Option.isSome(cached)) {
        yield* cached.value
          .stop(event, callingSessionId)
          .pipe(cached.value.record, Effect.uninterruptible, cached.value.semaphore.withPermit);
      }
      return yield* status(lineageId);
    });
    return ArtifactRuntime.of({
      setHost: Effect.fn("ArtifactRuntime.setHost")(function* (value) {
        if (boundHost) return yield* failure("host", "Artifact runtime Cake host is already bound");
        boundHost = value;
      }),
      listTools: Effect.fn("ArtifactRuntime.listTools")(function* (target) {
        return (yield* compile(target.runtime)).map((tool) => tool.definition);
      }),
      status,
      stop,
      call: Effect.fn("ArtifactRuntime.call")(function* (input) {
        const controller = yield* ScopedCache.get(controllers, input.target.lineageId);
        return yield* Effect.gen(function* () {
          const tools = yield* compile(input.target.runtime);
          const tool = tools.find((entry) => entry.definition.name === input.name);
          if (!tool) return yield* failure("call", `Unknown artifact tool: ${input.name}`);
          yield* validate(tool.input, input.input, "input");
          const current = yield* controller.ensure(input.target, input.callingSessionId);
          const result = yield* current.worker.send({
            kind: "tool",
            name: input.name,
            input: input.input,
            ...(input.callingSessionId === undefined
              ? null
              : { callingSessionId: input.callingSessionId }),
          });
          yield* validate(tool.output, result, "output");
          return result;
        }).pipe(controller.record, Effect.uninterruptible, controller.semaphore.withPermit);
      }),
      lifecycle: Effect.fn("ArtifactRuntime.lifecycle")(function* (input) {
        if (input.event === "stop" || input.event === "delete")
          return yield* stop(input.target.lineageId, input.event, input.callingSessionId);
        // A late blur/unmount never starts code after the view has gone away.
        const cached = yield* ScopedCache.getOption(controllers, input.target.lineageId);
        const closingView = input.event === "blur" || input.event === "unmount";
        if (closingView && Option.isNone(cached)) return yield* status(input.target.lineageId);
        const controller = yield* ScopedCache.get(controllers, input.target.lineageId);
        yield* Effect.gen(function* () {
          const current = closingView
            ? controller.peek()
            : yield* controller.ensure(input.target, input.callingSessionId);
          if (
            !current ||
            !current.worker.isRunning() ||
            current.target.revision !== input.target.revision
          )
            return;
          if (input.event !== "start")
            yield* current.worker.send({
              kind: "lifecycle",
              name: input.event,
              input: null,
              ...(input.callingSessionId === undefined
                ? null
                : { callingSessionId: input.callingSessionId }),
              ...(input.viewId === undefined ? null : { viewId: input.viewId }),
            });
        }).pipe(controller.record, Effect.uninterruptible, controller.semaphore.withPermit);
        return yield* status(input.target.lineageId);
      }),
    });
  }),
);
